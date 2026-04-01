import { DoorDashBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
  AuthStatus,
} from '../types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.join(__dirname, 'queries');

function loadQuery(filename: string): string {
  const raw = fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
  // Strip comment lines (# ...) at the top of captured files
  const lines = raw.split('\n');
  const queryStart = lines.findIndex(l => !l.startsWith('#') && l.trim() !== '');
  return lines.slice(queryStart).join('\n');
}

function parsePriceToCents(displayPrice: string): number {
  const cleaned = displayPrice.replace(/[^0-9.]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
}

// DoorDash estimated fee rates (used when live cart fees aren't available)
const DOORDASH_SERVICE_FEE_RATE = 0.15;
const DOORDASH_DELIVERY_FEE_CENTS = 299; // $2.99 default

export class DoorDashAdapter implements PlatformAdapter {
  platform = 'doordash' as const;
  private browser = new DoorDashBrowser();
  private authStatus: AuthStatus = 'not_configured';
  private lastRequestTime = 0;
  private static MIN_REQUEST_GAP_MS = 5000; // minimum 5s between comparisons to avoid 429

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (loggedIn) {
      console.log('[DoorDash] Existing session found and valid.');
      this.authStatus = 'authenticated';
    } else {
      console.log('[DoorDash] Session expired or not found. Login via Settings page.');
      this.authStatus = 'expired';
    }
  }

  getStatus(): AuthStatus {
    return this.authStatus;
  }

  setStatus(status: AuthStatus): void {
    this.authStatus = status;
  }

  getBrowser(): DoorDashBrowser {
    return this.browser;
  }

  async isSessionValid(): Promise<boolean> {
    return this.browser.isLoggedIn();
  }

  /** Fetch saved addresses and set the closest one as default */
  private async setDeliveryAddress(lat: number, lng: number): Promise<void> {
    const getAddressesQuery = loadQuery('getAvailableAddresses.graphql');
    const result = await this.browser.graphqlQuery<{
      data: {
        getAvailableAddresses: Array<{
          id: string;
          addressId: string;
          lat: number;
          lng: number;
          printableAddress: string;
        }>;
      };
    }>('getAvailableAddresses', getAddressesQuery);

    const addresses = result.data?.getAvailableAddresses;
    if (!addresses || addresses.length === 0) {
      console.warn('[DoorDash] No saved addresses found on account. Search will use current default.');
      return;
    }

    // Find closest address to target coordinates
    let closest = addresses[0];
    let minDist = Infinity;
    for (const addr of addresses) {
      const dist = Math.sqrt((addr.lat - lat) ** 2 + (addr.lng - lng) ** 2);
      if (dist < minDist) {
        minDist = dist;
        closest = addr;
      }
    }

    console.log(`[DoorDash] Setting delivery address: ${closest.printableAddress} (ID: ${closest.id})`);

    const updateQuery = loadQuery('updateConsumerDefaultAddressV2.graphql');
    await this.browser.graphqlQuery('updateConsumerDefaultAddressV2', updateQuery, {
      defaultAddressId: closest.id,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  private ensureAuthenticated(): void {
    if (this.authStatus !== 'authenticated') {
      throw new Error('DoorDash session expired. Please reconnect in Settings.');
    }
  }

  async searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]> {
    try {
      this.ensureAuthenticated();
      await this.browser.ensureConnected();
      await this.setDeliveryAddress(params.lat, params.lng);
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      const searchQuery = loadQuery('homePageFacetFeed.graphql');
      const result = await this.browser.graphqlQuery<{ data: { homePageFacetFeed: any } }>(
        'homePageFacetFeed', searchQuery, {
          cursor: '',
          filterQuery: params.query || '',
          displayHeader: false,
          isDebug: false,
          cuisineFilterVerticalIds: '',
        }
      );

      const restaurants: PlatformRestaurant[] = [];
      const feed = result.data?.homePageFacetFeed;
      if (!feed?.body) return restaurants;

      // DoorDash feed uses a facet component system. Store entries have component.id === 'row.store'.
      // Data is spread across: text (name, cuisine, eta), custom (JSON: store_id, rating),
      // events (URL), images (header image).
      for (const section of feed.body) {
        if (!section.body) continue;
        for (const facet of section.body) {
          if (facet.component?.id !== 'row.store') continue;

          let customData: any = {};
          try {
            customData = typeof facet.custom === 'string' ? JSON.parse(facet.custom) : (facet.custom || {});
          } catch { /* not valid JSON */ }

          const storeId = customData.store_id;
          const name = facet.text?.title;
          if (!storeId || !name) continue;

          // Extract text.custom key-value pairs
          const textCustomMap: Record<string, string> = {};
          if (Array.isArray(facet.text?.custom)) {
            for (const kv of facet.text.custom) {
              if (kv.key && kv.value) textCustomMap[kv.key] = kv.value;
            }
          }

          // Parse delivery time from "0.5 mi • 23 min" → "23 min"
          const etaStr = textCustomMap['eta_display_string'] || '';
          const timeMatch = etaStr.match(/(\d+\s*min)/);
          const deliveryTime = timeMatch ? timeMatch[1] : (etaStr || undefined);

          // Parse platform URL from events
          let platformUrl = `https://www.doordash.com/store/${storeId}`;
          try {
            const clickData = typeof facet.events?.click?.data === 'string'
              ? JSON.parse(facet.events.click.data)
              : facet.events?.click?.data;
            if (clickData?.uri) {
              platformUrl = `https://www.doordash.com/${clickData.uri}`;
            }
          } catch { /* use default */ }

          const cuisineStr = (facet.text?.description || '').replace(/^\s*•\s*/, '').trim();
          const cuisines = cuisineStr ? cuisineStr.split(/\s*,\s*/) : [];

          restaurants.push({
            platformId: String(storeId),
            name,
            address: '',
            lat: 0,
            lng: 0,
            cuisines,
            rating: customData.rating?.average_rating,
            deliveryTime,
            deliveryFee: undefined,
            imageUrl: facet.images?.main?.uri,
            platformUrl,
          });
        }
      }

      console.log(`[DoorDash] searchRestaurants: found ${restaurants.length} results`);
      return restaurants;
    } catch (err) {
      console.error('[DoorDash] searchRestaurants error:', err);
      return [];
    }
  }

  async getMenu(platformRestaurantId: string): Promise<PlatformMenu> {
    try {
      await this.browser.ensureConnected();
      const query = loadQuery('storepageFeed.graphql');
      const result = await this.browser.graphqlQuery<{
        data: {
          storepageFeed: {
            storeHeader: { id: string; name: string };
            itemLists: Array<{
              name: string;
              items: Array<{
                id: string;
                name: string;
                description?: string;
                displayPrice: string;
                imageUrl?: string;
              }>;
            }>;
          };
        };
      }>('storepageFeed', query, {
        storeId: platformRestaurantId,
        menuId: null,
        isMerchantPreview: false,
        fulfillmentType: 'Delivery',
        cursor: null,
        scheduledTime: null,
        entryPoint: 'HomePage',
      });

      const store = result.data?.storepageFeed;
      if (!store?.itemLists) {
        console.log('[DoorDash] getMenu: empty response');
        return { categories: [] };
      }

      const categories = store.itemLists.map(cat => ({
        name: cat.name,
        items: cat.items.map(item => ({
          platformItemId: item.id,
          name: item.name,
          description: item.description || undefined,
          priceCents: parsePriceToCents(item.displayPrice || '$0.00'),
          imageUrl: item.imageUrl || undefined,
        })),
      }));

      console.log(`[DoorDash] getMenu: ${categories.length} categories, ${categories.reduce((a, c) => a + c.items.length, 0)} items`);
      return { categories };
    } catch (err) {
      console.error('[DoorDash] getMenu error:', err);
      return { categories: [] };
    }
  }

  /**
   * Clear existing DoorDash cart for a store so we get a clean fee preview.
   * Uses listCarts to find existing cart, then deleteCart to wipe it entirely.
   */
  private async clearCart(storeId: string): Promise<void> {
    try {
      const listQuery = loadQuery('listCarts.graphql');
      const listResult = await this.browser.mainTabGraphqlQuery<any>('listCarts', listQuery, {
        input: {
          cartContextFilter: {
            experienceCase: 'MULTI_CART_EXPERIENCE_CONTEXT',
            multiCartExperienceContext: { storeId },
          },
          cartFilter: { shouldIncludeSubmitted: false },
        },
      }, 1); // maxRetries=1 to fail fast on 429

      const carts = listResult?.data?.listCarts || [];
      if (carts.length === 0) {
        console.log('[DoorDash] clearCart: no existing cart');
        return;
      }

      for (const cart of carts) {
        const itemCount = cart.orders?.[0]?.orderItems?.length || 0;
        console.log(`[DoorDash] clearCart: deleting cart ${cart.id} (${itemCount} items)`);
        await this.browser.mainTabGraphqlQuery<any>(
          'deleteCart',
          `mutation deleteCart($cartId: ID!) { deleteCart(cartId: $cartId) }`,
          { cartId: cart.id },
          1
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log('[DoorDash] clearCart: done');
    } catch (err) {
      console.warn('[DoorDash] clearCart failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Get fees for a DoorDash order.
   *
   * 1. Computes item subtotal from live menu prices (always accurate).
   * 2. Clears existing cart, adds requested items, gets PreviewOrderV2 for real fees.
   * 3. Falls back to fee rate derivation or estimated rates if cart approach fails.
   */
  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    this.ensureAuthenticated();
    await this.browser.ensureConnected();

    // Rate limit: wait if too soon after last request to avoid DoorDash 429s
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < DoorDashAdapter.MIN_REQUEST_GAP_MS) {
      const wait = DoorDashAdapter.MIN_REQUEST_GAP_MS - elapsed;
      console.log(`[DoorDash] Rate limit cooldown: waiting ${(wait / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    this.lastRequestTime = Date.now();

    // Clear cart, add items, get preview — subtotal comes from the clean cart itself
    let estimatedDeliveryTime: string | undefined;
    try {
      console.log(`[DoorDash] getFees: navigating to store ${params.platformRestaurantId}...`);
      await this.browser.navigateToStore(params.platformRestaurantId);

      // Clear stale cart items
      await this.clearCart(params.platformRestaurantId);

      const addCartQuery = loadQuery('addCartItem.graphql');
      let cartId = '';

      // Add requested items to clean cart
      for (const item of params.items) {
        const result = await this.browser.mainTabGraphqlQuery<any>('addCartItem', addCartQuery, {
          addCartItemInput: {
            storeId: params.platformRestaurantId,
            menuId: '',
            itemId: item.platformItemId,
            itemName: '',
            itemDescription: '',
            currency: 'USD',
            quantity: item.quantity,
            nestedOptions: '[]',
            specialInstructions: '',
            substitutionPreference: 'substitute',
            unitPrice: 0,
            cartId,
            isBundle: false,
            bundleType: 'BUNDLE_TYPE_UNSPECIFIED',
          },
          lowPriorityBatchAddCartItemInput: [],
          fulfillmentContext: {
            shouldUpdateFulfillment: false,
            fulfillmentType: 'Delivery',
          },
          monitoringContext: { isGroup: false },
          cartContext: { isBundle: false },
          returnCartFromOrderService: false,
          shouldKeepOnlyOneActiveCart: false,
        }, 1); // maxRetries=1 to fail fast on 429

        const cart = result?.data?.addCartItemV2;
        if (cart?.id) cartId = cart.id;
        console.log(`[DoorDash] addCartItem: ${item.platformItemId}, cart=${cartId || '(new)'}, subtotal=${cart?.subtotal}`);
        if (params.items.indexOf(item) < params.items.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
        }
      }

      if (cartId) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const detailedQuery = loadQuery('detailedCartItems.graphql');
        const previewResult = await this.browser.mainTabGraphqlQuery<any>(
          'detailedCartItems', detailedQuery, {
            orderCartId: cartId,
            isCardPayment: true,
          }, 1 // maxRetries=1 to fail fast on 429
        );

        const preview = previewResult?.data?.orderCart;
        if (preview) {
          const cartSubtotal = preview.subtotal || 0;
          const cartTotal = preview.total || 0;

          estimatedDeliveryTime = preview.asapMinutesRange
            ? `${preview.asapMinutesRange[0]}-${preview.asapMinutesRange[1]} min`
            : undefined;

          // Parse fees from preview data.
          // DoorDash's PreviewOrderV2 provides:
          //   subtotal: item prices
          //   totalBeforeDiscountsAndCredits: subtotal + all fees (delivery + service + tax)
          //   total: final amount after discounts/promos
          // lineItems and paymentLineItems may be empty depending on account type.
          const totalBeforeDiscounts = preview.totalBeforeDiscountsAndCredits || 0;
          const orders = preview.orders || [];
          const pli = orders[0]?.paymentLineItems;

          let serviceFee = pli?.serviceFee || 0;
          let taxAmount = pli?.taxAmount || 0;
          let deliveryFee = 0;
          let smallOrderFee = 0;
          let discountCents = 0;

          // Try lineItems first for itemized breakdown
          if (orders[0]?.lineItems?.length) {
            for (const li of orders[0].lineItems) {
              const label = (li.label || '').toLowerCase();
              const amount = li.finalMoney?.unitAmount || 0;
              const sign = li.finalMoney?.sign || '';
              console.log(`[DoorDash] lineItem: "${li.label}" = ${li.finalMoney?.displayString} (${amount}, sign=${sign})`);
              if (label.includes('delivery')) deliveryFee = amount;
              else if (label.includes('service')) serviceFee = amount || serviceFee;
              else if (label.includes('small order')) smallOrderFee = amount;
              else if (label.includes('tax')) taxAmount = amount || taxAmount;
              else if (sign === 'NEGATIVE' || label.includes('discount') || label.includes('promo') || label.includes('off')) {
                discountCents += amount;
              }
            }
          }

          // Cart was cleared before adding items — subtotal is accurate
          if (cartSubtotal > 0 && cartTotal > 0) {
            // Derive fees from totalBeforeDiscountsAndCredits when lineItems are empty
            if (serviceFee === 0 && deliveryFee === 0 && totalBeforeDiscounts > cartSubtotal) {
              const totalFees = totalBeforeDiscounts - cartSubtotal;
              // DoorDash service fee is typically ~15%, delivery varies
              serviceFee = Math.round(cartSubtotal * DOORDASH_SERVICE_FEE_RATE);
              deliveryFee = Math.max(0, totalFees - serviceFee);
              if (deliveryFee > 1000) {
                deliveryFee = DOORDASH_DELIVERY_FEE_CENTS;
                serviceFee = totalFees - deliveryFee;
              }
            }

            // Derive discount from totalBeforeDiscountsAndCredits - total
            if (discountCents === 0 && totalBeforeDiscounts > cartTotal) {
              discountCents = totalBeforeDiscounts - cartTotal;
            }

            console.log(`[DoorDash] getFees (live): subtotal=${cartSubtotal}, delivery=${deliveryFee}, service=${serviceFee}, tax=${taxAmount}, discount=${discountCents}, total=${cartTotal}, totalBeforeDiscounts=${totalBeforeDiscounts}`);
            return {
              subtotalCents: cartSubtotal, deliveryFeeCents: deliveryFee, serviceFeeCents: serviceFee,
              smallOrderFeeCents: smallOrderFee, taxCents: taxAmount, discountCents,
              totalCents: cartTotal, estimatedDeliveryTime,
            };
          }
        }
      }
    } catch (err) {
      console.error('[DoorDash] getFees cart approach failed:', err);
    }

    // Step 2: Full fallback — throw so comparison service uses DB pricing (no API calls)
    // Calling estimateFees here would trigger another getMenu() call that also gets 429'd
    throw new Error('[DoorDash] getFees: live cart approach failed');
  }

  /** Fallback: estimate fees from live menu prices + known DoorDash fee rates */
  private async estimateFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
  }): Promise<PlatformFees> {
    const menu = await this.getMenu(params.platformRestaurantId);
    const priceMap = new Map<string, number>();
    for (const cat of menu.categories) {
      for (const item of cat.items) {
        priceMap.set(item.platformItemId, item.priceCents);
      }
    }

    let subtotalCents = 0;
    for (const item of params.items) {
      const price = priceMap.get(item.platformItemId);
      if (price) subtotalCents += price * item.quantity;
    }

    const serviceFeeCents = Math.round(subtotalCents * DOORDASH_SERVICE_FEE_RATE);
    const deliveryFeeCents = DOORDASH_DELIVERY_FEE_CENTS;
    const taxCents = Math.round(subtotalCents * 0.08875);
    const totalCents = subtotalCents + serviceFeeCents + deliveryFeeCents + taxCents;

    console.log(`[DoorDash] getFees (estimated fallback): subtotal=${subtotalCents}, delivery=${deliveryFeeCents}, service=${serviceFeeCents}, tax=${taxCents}, total=${totalCents}`);
    return { subtotalCents, deliveryFeeCents, serviceFeeCents, smallOrderFeeCents: 0, taxCents, discountCents: 0, totalCents };
  }
}
