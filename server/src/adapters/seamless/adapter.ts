import { SeamlessBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
  AuthStatus,
} from '../types.js';

const API_BASE = 'https://api-gtm.grubhub.com';

export class SeamlessAdapter implements PlatformAdapter {
  platform = 'seamless' as const;
  private browser = new SeamlessBrowser();
  private authStatus: AuthStatus = 'not_configured';
  private sessionCookie = '';
  private perimeterXToken = '';
  private authToken = '';

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (loggedIn) {
      console.log('[Seamless] Existing session found and valid.');
      this.authStatus = 'authenticated';
      // Extract auth tokens
      this.authToken = await this.browser.getAuthToken();
      this.sessionCookie = await this.browser.getSessionCookies();
      this.perimeterXToken = await this.browser.getPerimeterXToken();
      console.log(`[Seamless] Auth token: ${this.authToken ? 'found' : 'missing'}`);
    } else {
      console.log('[Seamless] Session expired or not found. Login via Settings page.');
      this.authStatus = 'expired';
    }
  }

  getStatus(): AuthStatus {
    return this.authStatus;
  }

  setStatus(status: AuthStatus): void {
    this.authStatus = status;
  }

  getBrowser(): SeamlessBrowser {
    return this.browser;
  }

  /** Refresh auth tokens after a successful login */
  async refreshTokens(): Promise<void> {
    this.authToken = await this.browser.getAuthToken();
    this.sessionCookie = await this.browser.getSessionCookies();
    this.perimeterXToken = await this.browser.getPerimeterXToken();
    console.log(`[Seamless] Tokens refreshed. Auth token: ${this.authToken ? 'found' : 'missing'}`);
  }

  async isSessionValid(): Promise<boolean> {
    return this.browser.isLoggedIn();
  }

  private ensureAuthenticated(): void {
    if (this.authStatus !== 'authenticated') {
      throw new Error('Seamless session expired. Please reconnect in Settings.');
    }
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
      this.ensureAuthenticated();
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

  /**
   * Paginated search with optional sort/facet control.
   * Used by discovery scripts to iterate through all results.
   */
  async searchRestaurantsPaginated(params: {
    lat: number;
    lng: number;
    pageNum?: number;
    pageSize?: number;
    sortSetId?: string;
    facet?: string;
    query?: string;
  }): Promise<{ restaurants: PlatformRestaurant[]; totalPages: number; currentPage: number }> {
    this.ensureAuthenticated();
    const searchParams = new URLSearchParams({
      orderMethod: 'delivery',
      locationMode: 'DELIVERY',
      facetSet: 'umamiV6',
      pageSize: String(params.pageSize || 100),
      pageNum: String(params.pageNum || 1),
      hideHateos: 'true',
      searchMetrics: 'true',
      location: `POINT(${params.lng} ${params.lat})`,
      preciseLocation: 'true',
      sortSetId: params.sortSetId || 'umamiV3',
      countOmittingTimes: 'true',
    });

    if (params.query) {
      searchParams.set('queryText', params.query);
    }
    if (params.facet) {
      searchParams.set('facet', params.facet);
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
        pager: {
          total_pages: number;
          current_page: number;
        };
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

    const pager = result.search_result?.pager || { total_pages: 1, current_page: 1 };

    return {
      restaurants,
      totalPages: pager.total_pages,
      currentPage: pager.current_page,
    };
  }

  async getMenu(
    platformRestaurantId: string,
    location?: { lat: number; lng: number; address?: string },
  ): Promise<PlatformMenu> {
    // Primary: DOM scraping (gets exactly what the user sees — no ghost items)
    try {
      const domResult = await this.getMenuFromDOM(platformRestaurantId, location);
      if (domResult.categories.length > 0) {
        const itemCount = domResult.categories.reduce((a, c) => a + c.items.length, 0);
        console.log(`[Seamless] getMenu (DOM): ${domResult.categories.length} categories, ${itemCount} items`);
        return domResult;
      }
      console.warn('[Seamless] DOM scraping returned empty menu — falling back to API');
    } catch (err) {
      console.warn(`[Seamless] DOM scraping failed — falling back to API: ${err instanceof Error ? err.message.substring(0, 80) : err}`);
    }

    // Fallback: API-based fetch (may include inactive menu items)
    return this.getMenuFromAPI(platformRestaurantId);
  }

  /**
   * Scrape menu directly from the Seamless website DOM.
   * Opens a FRESH TAB (stale SPA state on the main page breaks rendering),
   * navigates to the restaurant, scrolls incrementally to capture items from
   * the virtualized DOM, then closes the tab.
   *
   * Key insights (proven on Dim Sum Palace — 236 items, 17 categories):
   * 1. Seamless VIRTUALIZES the menu — items enter/leave DOM as you scroll.
   * 2. Category headers (menuVirtualizedSection) and items (menuItem) are in
   *    SEPARATE DOM branches — can't use parent-child containment.
   * 3. Track the "current category" by viewport position of h3 headers.
   * 4. Item IDs are in data-testid="Item{id}-{category}" attributes.
   * 5. Must use a fresh tab — reusing the main page causes stale SPA state.
   */
  private async getMenuFromDOM(
    platformRestaurantId: string,
    location?: { lat: number; lng: number; address?: string },
  ): Promise<PlatformMenu> {
    await this.browser.ensureConnected();
    const context = this.browser.getContext();
    if (!context) throw new Error('No browser context');

    // Use a FRESH tab — stale SPA state on the main page breaks rendering
    const scrapePage = await context.newPage();

    try {
      // Step 1: Boot SPA on seamless.com first (establishes auth context)
      await scrapePage.goto('https://www.seamless.com', {
        waitUntil: 'networkidle',
        timeout: 30000,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      // Step 2: Set delivery address if provided (must be in range for full menu)
      if (location?.address) {
        await this.setDeliveryAddressViaUI(scrapePage, location.address);
      }

      // Step 3: Navigate to restaurant menu page
      await scrapePage.goto(`https://www.seamless.com/menu/${platformRestaurantId}`, {
        waitUntil: 'networkidle',
        timeout: 45000,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      // Step 4: Verify menu rendered (check for menuItem elements)
      const menuCheck = await scrapePage.evaluate(() => ({
        url: window.location.href,
        menuItems: document.querySelectorAll('.menuItem').length,
        outOfRange: document.body.innerText.includes("doesn't deliver") || document.body.innerText.includes('Too far'),
      }));

      if (menuCheck.menuItems === 0) {
        if (menuCheck.outOfRange) {
          console.warn(`[Seamless] Restaurant ${platformRestaurantId} out of delivery range`);
        } else {
          console.log(`[Seamless] DOM: no menu items rendered. URL: ${menuCheck.url}`);
        }
        return { categories: [] };
      }

      // Step 5: Scroll and collect items incrementally
      // Seamless virtualizes the menu: category headers (menuVirtualizedSection)
      // and items (menuItem in [data-testid="regular-sections"]) are in SEPARATE
      // DOM branches. We track the current category by viewport position of h3 headers.
      await scrapePage.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 1000));

      const collectedItems = new Map<string, {
        name: string; priceCents: number; description: string;
        category: string; platformItemId: string;
      }>();

      const SKIP_CATS = ['Best Sellers', 'Most Ordered', 'Order Again', 'Similar options nearby'];

      /** Extract visible items with viewport-based category tracking */
      const extractVisible = () => scrapePage.evaluate((skipCats: string[]) => {
        const skip = new Set(skipCats);
        const items: Array<{
          key: string; name: string; priceCents: number;
          description: string; category: string; platformItemId: string;
        }> = [];
        const priceRe = /(\d+\.\d{2})/;
        const viewportH = window.innerHeight;

        // Determine current category: find the h3 most recently scrolled past
        let currentCat = 'Menu';
        const allHeaders = document.querySelectorAll(
          '[data-testid="regular-sections"] h3, .menuVirtualizedSection .menuSection-title'
        );
        for (const h of allHeaders) {
          const rect = h.getBoundingClientRect();
          if (rect.top < viewportH * 0.6) {
            const text = h.textContent?.trim() || '';
            if (text && text.length < 80 && !skip.has(text)) {
              currentCat = text;
            }
          }
        }

        // Collect items from the regular-sections container
        const container = document.querySelector('[data-testid="regular-sections"]');
        if (!container) return items;

        for (const el of container.querySelectorAll('.menuItem')) {
          const rect = el.getBoundingClientRect();
          if (rect.top > viewportH + 200 || rect.bottom < -200) continue;

          const nameEl = el.querySelector('.menuItemNew-name');
          const name = nameEl?.textContent?.trim() || '';
          if (!name || name.length < 2) continue;

          const priceEl = el.querySelector('.menuItem-priceAmount, .menuItem-priceAmountUnbolded');
          const priceText = priceEl?.textContent?.trim() || '';
          const priceMatch = priceText.match(priceRe);
          const priceCents = priceMatch ? Math.round(parseFloat(priceMatch[1]) * 100) : 0;

          const descEl = el.querySelector('.menuItem-description');
          const description = descEl?.textContent?.trim() || '';

          // Extract item ID from data-testid="Item{id}-{category}"
          let platformItemId = '';
          const testId = el.getAttribute('data-testid') || '';
          const idMatch = testId.match(/Item(\d+)/);
          if (idMatch) platformItemId = idMatch[1];
          if (!platformItemId) {
            platformItemId = `sl-${currentCat}-${name}`.replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 80);
          }

          items.push({
            key: `${name}|${priceCents}`,
            name, priceCents, description,
            category: currentCat,
            platformItemId,
          });
        }
        return items;
      }, SKIP_CATS);

      // Collect before scroll
      for (const item of await extractVisible()) {
        if (!collectedItems.has(item.key)) {
          const { key: _, ...rest } = item;
          collectedItems.set(item.key, rest);
        }
      }

      // Scroll and collect incrementally
      let lastHeight = 0;
      let stableCount = 0;
      for (let i = 0; i < 200; i++) {
        await scrapePage.evaluate((y) => window.scrollTo(0, y), (i + 1) * 400);
        await new Promise(r => setTimeout(r, 350));

        for (const item of await extractVisible()) {
          if (!collectedItems.has(item.key)) {
            const { key: _, ...rest } = item;
            collectedItems.set(item.key, rest);
          }
        }

        const currentHeight = await scrapePage.evaluate(() => document.body.scrollHeight);
        if (currentHeight === lastHeight) {
          stableCount++;
          if (stableCount >= 6) break;
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }
      }

      // Step 6: Build PlatformMenu from collected items
      const categoryMap = new Map<string, Array<{
        platformItemId: string; name: string; priceCents: number; description: string;
      }>>();
      for (const item of collectedItems.values()) {
        const cat = item.category || 'Menu';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push({
          platformItemId: item.platformItemId,
          name: item.name,
          priceCents: item.priceCents,
          description: item.description,
        });
      }

      const categories = Array.from(categoryMap.entries()).map(([name, items]) => ({ name, items }));
      console.log(`[Seamless] DOM scrape: ${collectedItems.size} items, ${categories.length} categories`);

      return { categories };
    } finally {
      // Close the scrape tab (don't pollute the main page state)
      await scrapePage.close().catch(() => {});
    }
  }

  /**
   * Set the Seamless delivery address by interacting with the address bar UI.
   * Used to ensure the restaurant is in delivery range so the full menu renders.
   * Uses ArrowDown+Enter on autocomplete (confirmed working in investigation).
   */
  private async setDeliveryAddressViaUI(page: import('playwright').Page, address: string): Promise<void> {
    try {
      // Navigate to Seamless home to access the address bar
      const currentUrl = page.url();
      if (!currentUrl.includes('seamless.com') || currentUrl.includes('/menu/') || currentUrl.includes('/login')) {
        await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
      }

      // Look for the address input — Seamless has it in the top nav
      const addressInput = await page.$('input[aria-label*="address" i], input[placeholder*="address" i], input[name*="address" i], #addressAutocomplete');
      if (!addressInput) {
        console.log('[Seamless] Address input not found — using current saved address');
        return;
      }

      // Click to focus, then type via page.keyboard (survives React re-renders)
      await addressInput.click({ clickCount: 3 }); // select all
      await new Promise(r => setTimeout(r, 300));
      await page.keyboard.type(address, { delay: 30 });
      await new Promise(r => setTimeout(r, 2500)); // wait for autocomplete dropdown

      // Select the first autocomplete suggestion via ArrowDown+Enter (keyboard-level)
      await page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 500));
      await page.keyboard.press('Enter');

      // Wait for navigation from address selection
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      console.log(`[Seamless] Address set to: ${address}`);
    } catch (err) {
      console.warn(`[Seamless] Failed to set address: ${err instanceof Error ? err.message.substring(0, 60) : err}`);
    }
  }

  /**
   * Fallback: API-based menu fetch. May include inactive/ghost items
   * since the API doesn't distinguish active vs inactive menu sets.
   */
  private async getMenuFromAPI(platformRestaurantId: string): Promise<PlatformMenu> {
    try {
      const restInfo = await this.apiCall<{
        object: {
          data: {
            enhanced_feed: Array<{ id: string; name: string }>;
          };
        };
      }>(`/restaurant_gateway/info/volatile/${platformRestaurantId}?orderType=STANDARD&platform=WEB&enhancedFeed=true&weightedItemDataIncluded=true`);

      const feed = restInfo.object?.data?.enhanced_feed || [];
      const skipCategories = ['Category Navigation', 'Search', 'Offers', 'Best Sellers', 'Order Again', 'Similar options nearby'];
      const allMenuCategories = feed.filter(f => f.id && f.name && !skipCategories.includes(f.name));

      // Deduplicate by category name — keep the LAST occurrence
      const categoryByName = new Map<string, typeof allMenuCategories[0]>();
      for (const cat of allMenuCategories) {
        categoryByName.set(cat.name, cat);
      }
      const menuCategories = Array.from(categoryByName.values());

      const categories: PlatformMenu['categories'] = [];

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

          await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));
        } catch (err) {
          console.error(`[Seamless] getMenuFromAPI: error fetching category ${cat.name}:`, err);
        }
      }

      console.log(`[Seamless] getMenu (API fallback): ${categories.length} categories, ${categories.reduce((a, c) => a + c.items.length, 0)} items ⚠ may include ghost items`);
      return { categories };
    } catch (err) {
      console.error('[Seamless] getMenuFromAPI error:', err);
      return { categories: [] };
    }
  }

  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    try {
      this.ensureAuthenticated();
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

        // Rate limit between items (skip after last item)
        if (params.items.indexOf(item) < params.items.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
        }
      }

      // 4. Get bill (fee breakdown)
      const bill = await this.apiCall<{
        charges: {
          diner_subtotal: number;
          diner_grand_total: number;
          fees: {
            total: number;
            delivery: number;
            service: number;
            fee_items: Array<{ type: string; calculated_amount: number }>;
          };
          taxes: {
            total: number;
          };
        };
      }>(`/carts/${cartId}/bill`);

      const fees = bill.charges?.fees;
      const subtotal = bill.charges?.diner_subtotal || 0;
      const deliveryFee = fees?.delivery || 0;
      const serviceFee = fees?.service || 0;
      const taxCents = bill.charges?.taxes?.total || 0;
      const smallOrderFee = (fees?.fee_items || [])
        .filter(f => f.type === 'SMALL_ORDER')
        .reduce((a, f) => a + f.calculated_amount, 0);

      // Grand total includes subtotal + fees + tax (no tip)
      const total = bill.charges?.diner_grand_total || (subtotal + (fees?.total || 0) + taxCents);

      console.log(`[Seamless] getFees: subtotal=${subtotal}, delivery=${deliveryFee}, service=${serviceFee}, tax=${taxCents}, total=${total}`);
      return {
        subtotalCents: subtotal,
        deliveryFeeCents: deliveryFee,
        serviceFeeCents: serviceFee,
        smallOrderFeeCents: smallOrderFee,
        taxCents,
        discountCents: 0,
        totalCents: total,
      };
    } catch (err) {
      console.error('[Seamless] getFees error:', err);
      throw new Error(`[Seamless] getFees failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
