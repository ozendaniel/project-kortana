import { DoorDashBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
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

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (!loggedIn) {
      console.log('[DoorDash] Session expired or not found. Manual login required.');
      console.log('[DoorDash] Browser window opened — please log in with OTP.');
      console.log(`[DoorDash] Email: ${credentials.email}`);
      console.log('[DoorDash] Waiting up to 3 minutes for login...');
      await this.browser.navigateHome();

      const success = await this.browser.waitForLogin(180000);
      if (!success) {
        console.warn('[DoorDash] Login timed out after 3 minutes. Adapter may not work correctly.');
      } else {
        console.log('[DoorDash] Login detected — session established.');
      }
    } else {
      console.log('[DoorDash] Existing session found and valid.');
    }
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

  async searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]> {
    try {
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
   * Get fees for a DoorDash order.
   *
   * Computes item subtotal from live menu prices (always accurate).
   * Attempts live cart approach for real fee extraction, but the DoorDash cart
   * accumulates items across requests (no captured removeCartItem mutation yet).
   * When the cart has stale items, derives the fee RATE from the cart preview
   * (fees/subtotal ratio) and applies it to the correct subtotal.
   * Falls back to estimated fee rates if cart approach fails entirely.
   */
  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    await this.browser.ensureConnected();

    // Step 1: Always compute subtotal from live menu prices (reliable, not affected by stale cart)
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

    console.log(`[DoorDash] getFees: computed subtotal from menu prices: ${subtotalCents} cents`);

    if (subtotalCents === 0) {
      console.warn('[DoorDash] getFees: subtotal is 0, items not found in menu');
      return { subtotalCents: 0, deliveryFeeCents: 0, serviceFeeCents: 0, smallOrderFeeCents: 0, totalCents: 0 };
    }

    // Step 2: Try live cart approach to extract real fee rate
    let feeRate: number | null = null;
    let estimatedDeliveryTime: string | undefined;
    try {
      console.log(`[DoorDash] getFees: navigating to store ${params.platformRestaurantId}...`);
      await this.browser.navigateToStore(params.platformRestaurantId);

      const addCartQuery = loadQuery('addCartItem.graphql');
      let cartId = '';

      // Add items to cart (may accumulate with stale items — we only use the fee rate)
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
        });

        const cart = result?.data?.addCartItemV2;
        if (cart?.id) cartId = cart.id;
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
      }

      if (cartId) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const detailedQuery = loadQuery('detailedCartItems.graphql');
        const previewResult = await this.browser.mainTabGraphqlQuery<any>(
          'detailedCartItems', detailedQuery, {
            orderCartId: cartId,
            isCardPayment: true,
          }
        );

        const preview = previewResult?.data?.orderCart;
        if (preview) {
          const cartSubtotal = preview.subtotal || 0;
          const cartTotal = preview.total || 0;

          estimatedDeliveryTime = preview.asapMinutesRange
            ? `${preview.asapMinutesRange[0]}-${preview.asapMinutesRange[1]} min`
            : undefined;

          // Extract fee rate from cart preview (fees / subtotal)
          // This rate is valid even with stale items since fees scale proportionally
          if (cartSubtotal > 0 && cartTotal > cartSubtotal) {
            feeRate = (cartTotal - cartSubtotal) / cartSubtotal;
            console.log(`[DoorDash] getFees: cart subtotal=${cartSubtotal}, total=${cartTotal}, derived fee rate=${(feeRate * 100).toFixed(1)}%`);
          }

          // Also try to extract itemized fees from lineItems/paymentLineItems
          const orders = preview.orders || [];
          const pli = orders[0]?.paymentLineItems;
          let serviceFee = 0;
          let deliveryFee = 0;
          let smallOrderFee = 0;

          if (pli?.serviceFee) serviceFee = pli.serviceFee;

          if (orders[0]?.lineItems?.length) {
            for (const li of orders[0].lineItems) {
              const label = (li.label || '').toLowerCase();
              const amount = li.finalMoney?.unitAmount || 0;
              if (label.includes('delivery')) deliveryFee = amount;
              else if (label.includes('service')) serviceFee = amount || serviceFee;
              else if (label.includes('small order')) smallOrderFee = amount;
            }
          }

          // If we got itemized fees AND the cart was clean (subtotal matches), use them directly
          if (cartSubtotal === subtotalCents && (serviceFee > 0 || deliveryFee > 0)) {
            const totalCents = subtotalCents + deliveryFee + serviceFee + smallOrderFee;
            console.log(`[DoorDash] getFees (live itemized): subtotal=${subtotalCents}, delivery=${deliveryFee}, service=${serviceFee}, total=${totalCents}`);
            return {
              subtotalCents, deliveryFeeCents: deliveryFee, serviceFeeCents: serviceFee,
              smallOrderFeeCents: smallOrderFee, totalCents, estimatedDeliveryTime,
            };
          }
        }
      }
    } catch (err) {
      console.error('[DoorDash] getFees cart approach failed:', err);
    }

    // Step 3: Apply fees — use derived rate from cart if available, otherwise use estimates
    let deliveryFeeCents: number;
    let serviceFeeCents: number;
    let smallOrderFeeCents = 0;

    if (feeRate !== null) {
      // Use real fee rate derived from DoorDash's PreviewOrderV2.
      // The cart total includes: subtotal + delivery + service + tax.
      // Split: estimate service at 15% of subtotal, delivery = remainder (or $2.99 fallback).
      const totalFees = Math.round(subtotalCents * feeRate);
      serviceFeeCents = Math.round(subtotalCents * DOORDASH_SERVICE_FEE_RATE);
      deliveryFeeCents = Math.max(0, totalFees - serviceFeeCents);
      // If derived delivery seems unreasonable (>$10), cap at $2.99 and put rest in service
      if (deliveryFeeCents > 1000) {
        deliveryFeeCents = DOORDASH_DELIVERY_FEE_CENTS;
        serviceFeeCents = totalFees - deliveryFeeCents;
      }
      console.log(`[DoorDash] getFees (live rate ${(feeRate * 100).toFixed(1)}%): subtotal=${subtotalCents}, delivery=${deliveryFeeCents}, service=${serviceFeeCents}`);
    } else {
      // Estimated fee rates
      serviceFeeCents = Math.round(subtotalCents * DOORDASH_SERVICE_FEE_RATE);
      deliveryFeeCents = DOORDASH_DELIVERY_FEE_CENTS;
      if (subtotalCents < 1000) smallOrderFeeCents = 200;
      console.log(`[DoorDash] getFees (estimated): subtotal=${subtotalCents}, delivery=${deliveryFeeCents}, service=${serviceFeeCents}`);
    }

    const totalCents = subtotalCents + deliveryFeeCents + serviceFeeCents + smallOrderFeeCents;
    return { subtotalCents, deliveryFeeCents, serviceFeeCents, smallOrderFeeCents, totalCents, estimatedDeliveryTime };
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
    const totalCents = subtotalCents + serviceFeeCents + deliveryFeeCents;

    console.log(`[DoorDash] getFees (estimated fallback): subtotal=${subtotalCents}, delivery=${deliveryFeeCents}, service=${serviceFeeCents}, total=${totalCents}`);
    return { subtotalCents, deliveryFeeCents, serviceFeeCents, smallOrderFeeCents: 0, totalCents };
  }
}
