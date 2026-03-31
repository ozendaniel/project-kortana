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

export class DoorDashAdapter implements PlatformAdapter {
  platform = 'doordash' as const;
  private browser = new DoorDashBrowser();

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (!loggedIn) {
      console.log('[DoorDash] Session expired or not found. Manual login required.');
      console.log('[DoorDash] Browser window opened — please log in manually.');
      console.log(`[DoorDash] Email: ${credentials.email}`);
      await this.browser.navigateHome();
    } else {
      console.log('[DoorDash] Existing session found and valid.');
    }
  }

  async isSessionValid(): Promise<boolean> {
    return this.browser.isLoggedIn();
  }

  async searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]> {
    try {
      // First set the delivery address
      const addressQuery = loadQuery('updateConsumerDefaultAddressV2.graphql');
      await this.browser.graphqlQuery('updateConsumerDefaultAddressV2', addressQuery, {
        input: {
          address: {
            printableAddress: params.address,
            lat: params.lat,
            lng: params.lng,
          },
        },
      });

      // Execute search
      const searchQuery = loadQuery('homePageFacetFeed.graphql');
      const result = await this.browser.graphqlQuery<{
        data: {
          homePageFacetFeed: {
            body: Array<{
              body: Array<{
                stores?: Array<{
                  store: {
                    id: string;
                    name: string;
                    headerImgUrl: string;
                    averageRating: number;
                    numRatings: number;
                    deliveryFee: number;
                    extraSosDeliveryFee: number;
                    displayDeliveryFee: string;
                    asapMinutesRange: [number, number];
                    priceRange: number;
                    address: {
                      street: string;
                      city: string;
                      state: string;
                      lat: number;
                      lng: number;
                    };
                    menus: Array<{ id: string }>;
                    business: { name: string };
                    tags: Array<{ name: string }>;
                    url: string;
                  };
                }>;
              }>;
            }>;
          };
        };
      }>('homePageFacetFeed', searchQuery, {
        cursor: '',
        filterQuery: params.query || '',
        displayHeader: false,
        isDebug: false,
        cuisineFilterVerticalIds: '',
      });

      const restaurants: PlatformRestaurant[] = [];
      const feed = result.data?.homePageFacetFeed;
      if (!feed?.body) return restaurants;

      // DoorDash feed is nested — stores are inside body > body > stores
      for (const section of feed.body) {
        if (!section.body) continue;
        for (const item of section.body) {
          if (!item.stores) continue;
          for (const storeEntry of item.stores) {
            const s = storeEntry.store;
            if (!s) continue;
            restaurants.push({
              platformId: s.id,
              name: s.name || s.business?.name || '',
              address: [s.address?.street, s.address?.city, s.address?.state].filter(Boolean).join(', '),
              lat: s.address?.lat || 0,
              lng: s.address?.lng || 0,
              cuisines: (s.tags || []).map((t: { name: string }) => t.name),
              rating: s.averageRating,
              deliveryTime: s.asapMinutesRange ? `${s.asapMinutesRange[0]}-${s.asapMinutesRange[1]} min` : undefined,
              deliveryFee: s.deliveryFee,
              imageUrl: s.headerImgUrl,
              platformUrl: `https://www.doordash.com/store/${s.id}`,
            });
          }
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
      const query = loadQuery('storepageFeed.graphql');
      const result = await this.browser.graphqlQuery<{
        data: {
          storepageFeed: {
            storeHeader: {
              id: string;
              name: string;
            };
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

  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    try {
      const addCartQuery = loadQuery('addCartItem.graphql');

      // Add each item to cart and capture the final cart state
      let lastCartResponse: any = null;

      for (const item of params.items) {
        const result = await this.browser.graphqlQuery('addCartItem', addCartQuery, {
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
            cartId: lastCartResponse?.data?.addCartItemV2?.id || '',
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

        lastCartResponse = result;

        // Rate limit: 2-3 second spacing
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
      }

      // Parse fees from cart response
      const cart = lastCartResponse?.data?.addCartItemV2;
      if (!cart) {
        console.log('[DoorDash] getFees: no cart data in response');
        return { subtotalCents: 0, deliveryFeeCents: 0, serviceFeeCents: 0, smallOrderFeeCents: 0, totalCents: 0 };
      }

      // DoorDash cart subtotal is available, but detailed fees require checkout page.
      // For Phase 1, we use the subtotal from cart and estimate fees from store header data.
      const subtotal = cart.subtotal || 0;
      const orders = cart.orders || [];
      let serviceFee = 0;
      let deliveryFee = 0;

      // Check if paymentLineItems is populated (it is when at checkout stage)
      if (orders[0]?.paymentLineItems) {
        serviceFee = orders[0].paymentLineItems.serviceFee || 0;
        // The delivery fee isn't in paymentLineItems but in the line items
      }

      // Try to extract from lineItems if available
      if (orders[0]?.lineItems) {
        for (const li of orders[0].lineItems) {
          if (li.label?.toLowerCase().includes('delivery')) {
            deliveryFee = li.finalMoney?.unitAmount || 0;
          }
          if (li.label?.toLowerCase().includes('service')) {
            serviceFee = li.finalMoney?.unitAmount || 0;
          }
        }
      }

      const total = cart.total || (subtotal + deliveryFee + serviceFee);

      console.log(`[DoorDash] getFees: subtotal=${subtotal}, delivery=${deliveryFee}, service=${serviceFee}, total=${total}`);
      return {
        subtotalCents: subtotal,
        deliveryFeeCents: deliveryFee,
        serviceFeeCents: serviceFee,
        smallOrderFeeCents: 0,
        totalCents: total,
        estimatedDeliveryTime: cart.asapMinutesRange ? `${cart.asapMinutesRange}` : undefined,
      };
    } catch (err) {
      console.error('[DoorDash] getFees error:', err);
      return { subtotalCents: 0, deliveryFeeCents: 0, serviceFeeCents: 0, smallOrderFeeCents: 0, totalCents: 0 };
    }
  }
}
