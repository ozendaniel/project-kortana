import { SeamlessBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
} from '../types.js';

const API_BASE = 'https://api-gtm.grubhub.com';

export class SeamlessAdapter implements PlatformAdapter {
  platform = 'seamless' as const;
  private browser = new SeamlessBrowser();
  private sessionCookie = '';
  private perimeterXToken = '';
  private authToken = '';

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (!loggedIn) {
      console.log('[Seamless] Session expired or not found. Please log in manually in the browser window.');
      console.log('[Seamless] Waiting up to 2 minutes for login...');
      await this.browser.navigateHome();
      const success = await this.browser.waitForLogin(120000);
      if (!success) {
        console.error('[Seamless] Login timed out after 2 minutes. Adapter will not be available.');
        return;
      }
      console.log('[Seamless] Login detected!');
    } else {
      console.log('[Seamless] Existing session found and valid.');
    }

    // Extract auth token from localStorage and session cookies
    this.authToken = await this.browser.getAuthToken();
    this.sessionCookie = await this.browser.getSessionCookies();
    this.perimeterXToken = await this.browser.getPerimeterXToken();
    console.log(`[Seamless] Adapter initialized successfully. Auth token: ${this.authToken ? 'found' : 'missing'}`);
  }

  async isSessionValid(): Promise<boolean> {
    return this.browser.isLoggedIn();
  }

  /** Make an authenticated REST call to Seamless/Grubhub API */
  private async apiCall<T = unknown>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    await this.browser.ensureConnected();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'origin': 'https://www.seamless.com',
      ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
      ...(this.perimeterXToken ? { 'perimeter-x': this.perimeterXToken } : {}),
      ...(options.headers as Record<string, string> || {}),
    };

    // Use browser fetch to inherit cookies and bypass bot detection
    const page = await this.browser.ensurePage();
    const result = await page.evaluate(
      async ({ url, method, headers, body }) => {
        const response = await fetch(url, {
          method,
          headers,
          body: body || undefined,
          credentials: 'include',
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`API ${response.status}: ${text.substring(0, 500)}`);
        }
        return text ? JSON.parse(text) : null;
      },
      {
        url: `${API_BASE}${endpoint}`,
        method: options.method || 'GET',
        headers,
        body: options.body as string | null || null,
      }
    );

    return result as T;
  }

  async searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]> {
    try {
      const searchParams = new URLSearchParams({
        orderMethod: 'delivery',
        locationMode: 'DELIVERY',
        facetSet: 'umamiV6',
        pageSize: '20',
        hideHateos: 'true',
        searchMetrics: 'true',
        location: `POINT(${params.lng} ${params.lat})`,
        preciseLocation: 'true',
        sortSetId: 'umamiV3',
        countOmittingTimes: 'true',
      });

      if (params.query) {
        searchParams.set('queryText', params.query);
      }

      const result = await this.apiCall<{
        search_result: {
          results: Array<{
            restaurant_id: string;
            name: string;
            logo: string;
            address: {
              street_address: string;
              locality: string;
              region: string;
              latitude: string;
              longitude: string;
            };
            cuisines: string[];
            ratings: { rating_count: number; average_rating: number };
            delivery_time_estimate: number;
            delivery_fee: { amount: number };
            restaurant_url: string;
          }>;
        };
      }>(`/restaurants/search?${searchParams.toString()}`);

      const restaurants: PlatformRestaurant[] = (result.search_result?.results || []).map(r => ({
        platformId: r.restaurant_id,
        name: r.name,
        address: [r.address?.street_address, r.address?.locality, r.address?.region].filter(Boolean).join(', '),
        lat: parseFloat(r.address?.latitude || '0'),
        lng: parseFloat(r.address?.longitude || '0'),
        cuisines: r.cuisines || [],
        rating: r.ratings?.average_rating,
        deliveryTime: r.delivery_time_estimate ? `${r.delivery_time_estimate} min` : undefined,
        deliveryFee: r.delivery_fee?.amount,
        imageUrl: r.logo,
        platformUrl: `https://www.seamless.com${r.restaurant_url || '/menu/' + r.restaurant_id}`,
      }));

      console.log(`[Seamless] searchRestaurants: found ${restaurants.length} results`);
      return restaurants;
    } catch (err) {
      console.error('[Seamless] searchRestaurants error:', err);
      return [];
    }
  }

  async getMenu(platformRestaurantId: string): Promise<PlatformMenu> {
    try {
      // Get restaurant info (includes menu category IDs)
      const restInfo = await this.apiCall<{
        object: {
          data: {
            content: Array<{
              entity: {
                id: string;
                name: string;
              };
            }>;
            enhanced_feed: Array<{
              id: string;
              name: string;
            }>;
          };
        };
      }>(`/restaurant_gateway/info/volatile/${platformRestaurantId}?orderType=STANDARD&platform=WEB&enhancedFeed=true&weightedItemDataIncluded=true`);

      const feed = restInfo.object?.data?.enhanced_feed || [];
      // Filter out non-menu categories
      const skipCategories = ['Category Navigation', 'Search', 'Offers', 'Best Sellers', 'Order Again', 'Similar options nearby'];
      const menuCategories = feed.filter(f => f.id && f.name && !skipCategories.includes(f.name));

      const categories: PlatformMenu['categories'] = [];

      // Fetch items for each category
      for (const cat of menuCategories) {
        try {
          const feedResult = await this.apiCall<{
            object: {
              data: {
                content: Array<{
                  entity: {
                    item_id: string;
                    item_name: string;
                    item_description?: string;
                    item_price: {
                      delivery?: { value: number };
                      pickup?: { value: number };
                    };
                    media_image?: { base_url: string; public_id: string; format: string };
                  };
                }>;
              };
            };
          }>(`/restaurant_gateway/feed/${platformRestaurantId}/${cat.id}?orderType=STANDARD&platform=WEB&weightedItemDataIncluded=true&task=CATEGORY`);

          const items = (feedResult.object?.data?.content || [])
            .filter(c => c.entity?.item_id)
            .map(c => {
              const e = c.entity;
              const price = e.item_price?.delivery?.value || e.item_price?.pickup?.value || 0;
              const imageUrl = e.media_image
                ? `${e.media_image.base_url}${e.media_image.public_id}.${e.media_image.format}`
                : undefined;

              return {
                platformItemId: e.item_id,
                name: e.item_name,
                description: e.item_description || undefined,
                priceCents: price,
                imageUrl,
              };
            });

          if (items.length > 0) {
            categories.push({ name: cat.name, items });
          }

          // Rate limit: 2-3 second spacing
          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
        } catch (err) {
          console.error(`[Seamless] getMenu: error fetching category ${cat.name}:`, err);
        }
      }

      console.log(`[Seamless] getMenu: ${categories.length} categories, ${categories.reduce((a, c) => a + c.items.length, 0)} items`);
      return { categories };
    } catch (err) {
      console.error('[Seamless] getMenu error:', err);
      return { categories: [] };
    }
  }

  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    try {
      // 1. Create a new cart
      const cart = await this.apiCall<{ id: string }>('/carts', {
        method: 'POST',
        body: JSON.stringify({
          brand: 'SEAMLESS',
          experiments: ['INCLUDE_TIP_IN_MINIMUM', 'IGNORE_MINIMUM_TIP_REQUIREMENT', 'LINEOPTION_ENHANCEMENTS'],
          cart_attributes: [],
        }),
      });

      const cartId = cart.id;

      // 2. Set delivery info — Grubhub requires structured address fields
      const streetAddress = params.deliveryAddress.address.split(',')[0]?.trim() || params.deliveryAddress.address;
      await this.apiCall(`/carts/${cartId}/delivery_info`, {
        method: 'PUT',
        body: JSON.stringify({
          address: {
            region_code: 'US',
            address_lines: [streetAddress],
            coordinates: {
              latitude: String(params.deliveryAddress.lat),
              longitude: String(params.deliveryAddress.lng),
            },
            administrative_area: 'NY',
            locality: 'NEW YORK',
            postal_code: '10010',
          },
          green_indicated: false,
          handoff_options: [],
          delivery_instructions: '',
          email: 'ozen.daniel@gmail.com',
          phone: '8187301347',
        }),
      });

      // 3. Add each item to cart
      for (const item of params.items) {
        await this.apiCall(`/carts/${cartId}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            menu_item_id: item.platformItemId,
            brand: 'SEAMLESS',
            experiments: ['LINEOPTION_ENHANCEMENTS'],
            quantity: item.quantity,
            special_instructions: '',
            options: [],
            restaurant_id: params.platformRestaurantId,
          }),
        });

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
      }

      // 4. Get bill (fee breakdown)
      const bill = await this.apiCall<{
        charges: {
          diner_subtotal: number;
          fees: {
            total: number;
            delivery: number;
            service: number;
            fee_items: Array<{ type: string; calculated_amount: number }>;
          };
        };
      }>(`/carts/${cartId}/bill`);

      const fees = bill.charges?.fees;
      const subtotal = bill.charges?.diner_subtotal || 0;
      const deliveryFee = fees?.delivery || 0;
      const serviceFee = fees?.service || 0;
      const smallOrderFee = (fees?.fee_items || [])
        .filter(f => f.type === 'SMALL_ORDER')
        .reduce((a, f) => a + f.calculated_amount, 0);

      const total = subtotal + (fees?.total || 0);

      console.log(`[Seamless] getFees: subtotal=${subtotal}, delivery=${deliveryFee}, service=${serviceFee}, total=${total}`);
      return {
        subtotalCents: subtotal,
        deliveryFeeCents: deliveryFee,
        serviceFeeCents: serviceFee,
        smallOrderFeeCents: smallOrderFee,
        totalCents: total,
      };
    } catch (err) {
      console.error('[Seamless] getFees error:', err);
      throw new Error(`[Seamless] getFees failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
