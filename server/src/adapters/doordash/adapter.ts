import { DoorDashBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
  AuthStatus,
} from '../types.js';
import { LiveFeeError } from '../types.js';
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
  /** Invoked when a GraphQL call returns 401/403. Wired in index.ts to flip AuthManager state. */
  onAuthExpired?: () => void;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    // Use checkSession (cookie-based) instead of isLoggedIn (navigates to homepage).
    // isLoggedIn creates new pages + loads ad iframes that spawn popup windows.
    const loggedIn = await this.browser.checkSession();

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
    return this.browser.checkSession();
  }

  /**
   * Return saved addresses on the logged-in DD account. Used by preflight
   * so the frontend can show which address live fees will be calculated for.
   */
  async getAccountAddresses(): Promise<Array<{ id: string; address: string; lat: number; lng: number }>> {
    this.ensureAuthenticated();
    await this.browser.ensureConnected();
    const query = loadQuery('getAvailableAddresses.graphql');
    try {
      const result = await this.browser.graphqlQuery<{
        data: {
          getAvailableAddresses: Array<{
            id: string;
            printableAddress: string;
            lat: number;
            lng: number;
          }>;
        };
      }>('getAvailableAddresses', query);
      const addrs = result.data?.getAvailableAddresses || [];
      return addrs.map((a) => ({
        id: a.id,
        address: a.printableAddress,
        lat: a.lat,
        lng: a.lng,
      }));
    } catch (err) {
      console.warn('[DoorDash] getAccountAddresses failed:', err instanceof Error ? err.message : err);
      return [];
    }
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
          const compId = facet.component?.id;
          if (compId !== 'row.store' && compId !== 'card.store') continue;

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
   * Fetch full modifier structure for a single item via the itemPage GraphQL
   * query. Returns normalized ModifierGroup[] (empty if the item has no
   * customization or the fetch fails). Used by the populate script to cache
   * modifier_groups for items where storepageFeed's quickAddContext.isEligible
   * is false (i.e. items that require customization before adding to cart).
   *
   * menuId can be passed if known (from storepageFeed.menuBook.id) — improves
   * the cursor context DoorDash uses to route the query. Optional.
   */
  async fetchItemModifiers(
    storeId: string,
    itemId: string,
    menuId?: string,
  ): Promise<import('../../services/modifiers.js').ModifierGroup[]> {
    this.ensureAuthenticated();
    await this.browser.ensureConnected();

    // DoorDash 403s itemPage unless the main tab's origin/referer matches a
    // store page URL. Navigate there first so the page.evaluate fetch sends
    // the right Referer header.
    await this.browser.navigateToStore(storeId);

    // itemPage also requires consumerId in variables (from ajs_user_id cookie)
    const consumerId = await this.browser.getConsumerId();

    const query = loadQuery('itemPage.graphql');

    // Try multiple cursor strategies. DoorDash's itemPage endpoint rejects
    // some requests with a 403-wrapped HTML page depending on what the
    // cursorContext contains. We iterate through plausible formats.
    const cursorStrategies: Array<{ label: string; cursorContext: unknown }> = [
      // 1. Null cursor — simplest
      { label: 'null', cursorContext: null },
      // 2. Empty cursor object
      { label: 'empty', cursorContext: {} },
      // 3. Minimal itemCursor with just ids
      {
        label: 'minimal',
        cursorContext: {
          itemCursor: Buffer.from(JSON.stringify({
            dm_id: 'item_1',
            dm_type: 'item',
            dm_version: 2,
            cursor_version: 'ITEM_PAGE',
            itemId: Number(itemId),
            optionId: null,
            selectedOrderItemId: null,
            storeLiteData: null,
            is_homegrown_loyalty: false,
            page_stack_trace: [],
            storeId: Number(storeId),
            menuId: menuId ? Number(menuId) : null,
            categoryId: null,
            businessId: null,
            verticalId: 0,
            is_meal_manager_entry: false,
          })).toString('base64'),
        },
      },
    ];

    for (const strat of cursorStrategies) {
      try {
        const result = await this.browser.mainTabGraphqlQuery<any>(
          'itemPage',
          query,
          {
            itemId,
            consumerId: consumerId || undefined,
            storeId,
            isMerchantPreview: false,
            isNested: false,
            shouldFetchPresetCarousels: true,
            fulfillmentType: 'Delivery',
            cursorContext: strat.cursorContext,
            shouldFetchStoreLiteData: false,
          },
          1,
        );

        if (result?.errors?.length) {
          const msg = result.errors[0]?.message || 'unknown';
          console.warn(`[DoorDash] fetchItemModifiers ${itemId} (cursor=${strat.label}): GraphQL error: ${msg.substring(0, 150)}`);
          continue;
        }

        const optionLists = result?.data?.itemPage?.optionLists;
        if (!optionLists) {
          console.warn(`[DoorDash] fetchItemModifiers ${itemId} (cursor=${strat.label}): no optionLists`);
          continue;
        }

        const { extractDoorDashModifiers } = await import('../../services/modifiers.js');
        const groups = extractDoorDashModifiers(optionLists);
        console.log(`[DoorDash] fetchItemModifiers ${itemId}: got ${groups.length} groups (cursor=${strat.label})`);
        return groups;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[DoorDash] fetchItemModifiers ${itemId} (cursor=${strat.label}) failed: ${msg.substring(0, 150)}`);
        // Fall through to next strategy
      }
    }

    console.warn(`[DoorDash] fetchItemModifiers ${itemId}: all cursor strategies exhausted`);
    return [];
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
    items: Array<{
      platformItemId: string;
      quantity: number;
      name?: string;
      description?: string;
      unitPriceCents?: number;
      menuPlatformId?: string;
      modifierGroups?: import('../../services/modifiers.js').ModifierGroup[];
      modifierSelections?: import('../../services/modifiers.js').ModifierSelection[];
    }>;
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

    // Import modifier helpers once
    const { fillDefaultSelections, buildDoorDashNestedOptions } = await import('../../services/modifiers.js');

    // Clear cart, add items, get preview — subtotal comes from the clean cart itself
    let estimatedDeliveryTime: string | undefined;
    try {
      // Snap DD account's default delivery address to the closest saved address
      // for the requested lat/lng so live fees reflect the right delivery zone.
      // If the user's Kortana address isn't near any saved DD address, this
      // falls back to the nearest one (preflight warns the user beforehand).
      try {
        await this.setDeliveryAddress(params.deliveryAddress.lat, params.deliveryAddress.lng);
      } catch (addrErr) {
        console.warn('[DoorDash] setDeliveryAddress in getFees failed:', addrErr instanceof Error ? addrErr.message : addrErr);
      }

      console.log(`[DoorDash] getFees: navigating to store ${params.platformRestaurantId}...`);
      await this.browser.navigateToStore(params.platformRestaurantId);

      // Clear stale cart items
      await this.clearCart(params.platformRestaurantId);

      const addCartQuery = loadQuery('addCartItem.graphql');
      let cartId = '';

      // Add requested items to clean cart
      for (const item of params.items) {
        // Build nestedOptions from user selections (or auto-picked defaults)
        const groups = item.modifierGroups || [];
        const selections = fillDefaultSelections(groups, item.modifierSelections || []);
        const nestedOptions = groups.length > 0 ? buildDoorDashNestedOptions(groups, selections) : '[]';

        const result = await this.browser.mainTabGraphqlQuery<any>('addCartItem', addCartQuery, {
          addCartItemInput: {
            storeId: params.platformRestaurantId,
            menuId: item.menuPlatformId || '',
            itemId: item.platformItemId,
            itemName: item.name || '',
            itemDescription: item.description || '',
            currency: 'USD',
            quantity: item.quantity,
            nestedOptions,
            specialInstructions: '',
            substitutionPreference: 'substitute',
            unitPrice: item.unitPriceCents ?? 0,
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
        const modSummary = selections.length > 0 ? ` mods=${selections.map(s => s.optionIds.length).join('+')}` : '';
        console.log(`[DoorDash] addCartItem: ${item.platformItemId}${modSummary}, cart=${cartId || '(new)'}, subtotal=${cart?.subtotal}`);

        // If no cart came back, GraphQL likely returned errors — surface them
        if (!cart && result?.errors?.length) {
          console.error(`[DoorDash] addCartItem errors for ${item.platformItemId}:`);
          for (const e of result.errors) {
            console.error(`  ${e.message || JSON.stringify(e).substring(0, 300)}`);
            if (e.extensions?.exception?.details) {
              console.error(`    details: ${JSON.stringify(e.extensions.exception.details).substring(0, 300)}`);
            }
          }
          throw new Error(`addCartItem returned no cart; first error: ${result.errors[0]?.message || 'unknown'}`);
        }
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
            // Derive fees from cartTotal (the amount actually charged) when lineItems
            // are empty. This is important for DashPass users: cartTotal already
            // reflects DashPass discounts, so the derived breakdown matches what the
            // user sees at checkout. If a discount exists, record it separately from
            // the totalBeforeDiscountsAndCredits delta.
            if (serviceFee === 0 && deliveryFee === 0 && taxAmount === 0 && cartTotal > cartSubtotal) {
              const totalFees = cartTotal - cartSubtotal;
              // Allocate in order: tax (NYC 8.875%) → service (~15%) → delivery (residual)
              const estimatedTax = Math.round(cartSubtotal * 0.08875);
              const estimatedService = Math.round(cartSubtotal * DOORDASH_SERVICE_FEE_RATE);

              if (totalFees >= estimatedTax + estimatedService) {
                taxAmount = estimatedTax;
                serviceFee = estimatedService;
                deliveryFee = totalFees - estimatedTax - estimatedService;
                // Sanity: if derived delivery is implausibly high, probably a small-order fee
                if (deliveryFee > 1500 && cartSubtotal < 1500) {
                  smallOrderFee = deliveryFee - DOORDASH_DELIVERY_FEE_CENTS;
                  deliveryFee = DOORDASH_DELIVERY_FEE_CENTS;
                }
              } else if (totalFees >= estimatedTax) {
                // Enough for tax but not full service; split the rest into service
                taxAmount = estimatedTax;
                serviceFee = totalFees - estimatedTax;
              } else {
                // Tiny fees (e.g. DashPass zero delivery + reduced service).
                // Attribute everything to service — it's the most variable line item.
                serviceFee = totalFees;
              }
              console.log(`[DoorDash] getFees derived from cartTotal: delivery=${deliveryFee}, service=${serviceFee}, smallOrder=${smallOrderFee}, tax=${taxAmount}, totalFees=${totalFees}`);
            }

            // Record DashPass / promo discount if the pre-discount total exists
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
      const msg = err instanceof Error ? err.message : String(err);
      // Token / cookies stale — flip status so the Settings page prompts re-login.
      if (/\bGraphQL (401|403)\b/.test(msg)) {
        this.authStatus = 'expired';
        this.onAuthExpired?.();
        throw new LiveFeeError('doordash', 'session_expired', 'DoorDash session expired — reconnect required.', true);
      }
      if (/does not deliver|out of (delivery )?range|delivery zone|not available at this address|beyond (the )?delivery/i.test(msg)) {
        throw new LiveFeeError('doordash', 'out_of_delivery_range', 'DoorDash does not deliver to this address.', false);
      }
      if (/unavailable|out of stock|86'?d|not available|sold out|item.*unavailable/i.test(msg)) {
        throw new LiveFeeError('doordash', 'item_unavailable', `DoorDash: item unavailable. ${msg.substring(0, 140)}`, false);
      }
      throw new LiveFeeError('doordash', 'unknown', `DoorDash live cart failed: ${msg.substring(0, 180)}`, true);
    }

    // Reached only if the cart loop produced no cartId or no preview — treat as unknown live failure.
    throw new LiveFeeError('doordash', 'unknown', 'DoorDash live cart produced no preview.', true);
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
