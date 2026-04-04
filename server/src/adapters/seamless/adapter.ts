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
   * Opens a NEW tab (separate from the API page), navigates to the restaurant page,
   * scrolls to load all categories, extracts items, and closes the tab.
   * This gets exactly what the user sees — no ghost items from inactive menu sets.
   */
  private async getMenuFromDOM(
    platformRestaurantId: string,
    location?: { lat: number; lng: number; address?: string },
  ): Promise<PlatformMenu> {
    await this.browser.ensureConnected();

    // Use the MAIN page for scraping — Seamless's PerimeterX blocks new tabs.
    // The main page has the established session context that allows the SPA to load.
    // We navigate to the restaurant page, scrape, then navigate back to seamless.com.
    const scrapePage = await this.browser.ensurePage();

    try {
      // If location provided, set delivery address near the restaurant first
      if (location?.address) {
        await this.setDeliveryAddressViaUI(scrapePage, location.address);
      }

      // Navigate to restaurant menu page
      await scrapePage.goto(`https://www.seamless.com/menu/${platformRestaurantId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for menu items to render (SPA — content loads asynchronously)
      try {
        await scrapePage.waitForSelector('.menuItemNew-name, .menuItem-name, .restaurant-menu-item', {
          timeout: 20000,
        });
      } catch {
        // Debug: check what IS on the page
        const debug = await scrapePage.evaluate(() => ({
          url: window.location.href,
          textLen: document.body.innerText.length,
          menuItems: document.querySelectorAll('.menuItem').length,
          menuItemNames: document.querySelectorAll('.menuItemNew-name').length,
          restMenuItem: document.querySelectorAll('.restaurant-menu-item').length,
          outOfRange: document.body.innerText.includes("doesn't deliver") || document.body.innerText.includes('Out of range'),
          allClassesWithMenu: [...new Set(
            Array.from(document.querySelectorAll('*'))
              .flatMap(el => typeof el.className === 'string' ? el.className.split(/\s+/).filter(c => /menu/i.test(c)) : [])
          )].slice(0, 15),
        }));
        console.log(`[Seamless] DOM debug: ${JSON.stringify(debug)}`);

        if (debug.outOfRange) {
          console.warn(`[Seamless] Restaurant ${platformRestaurantId} out of delivery range`);
        }
      }

      // Wait for initial render to settle
      await new Promise(r => setTimeout(r, 3000));

      // Scroll incrementally to load all lazy-rendered categories
      let lastHeight = 0;
      for (let i = 0; i < 60; i++) {
        const currentHeight = await scrapePage.evaluate(() => document.body.scrollHeight);
        if (currentHeight === lastHeight && i > 5) break;
        lastHeight = currentHeight;
        await scrapePage.evaluate((y) => window.scrollTo(0, y), (i + 1) * 600);
        await new Promise(r => setTimeout(r, 300));
      }
      await new Promise(r => setTimeout(r, 2000));

    // Debug: check what's on the page before extraction
    const preDebug = await scrapePage.evaluate(() => ({
      menuSections: document.querySelectorAll('.menuSection, .menuVirtualizedSection').length,
      menuItems: document.querySelectorAll('.menuItem').length,
      menuItemNames: document.querySelectorAll('.menuItemNew-name').length,
      url: window.location.href,
      title: document.title,
      bodyTextSample: document.body.innerText.substring(0, 300),
    }));
    console.log(`[Seamless] DOM pre-extract: sections=${preDebug.menuSections} items=${preDebug.menuItems} names=${preDebug.menuItemNames}`);
    console.log(`[Seamless] DOM title: ${preDebug.title}`);
    if (preDebug.menuItems === 0) {
      console.log(`[Seamless] DOM body sample: ${preDebug.bodyTextSample.substring(0, 200)}`);
    }

    // Extract menu items from the DOM
    const menuData = await scrapePage.evaluate(() => {
      const categories: Array<{
        name: string;
        items: Array<{ platformItemId: string; name: string; priceCents: number; description: string }>;
      }> = [];

      // Find menu sections (each contains a category header + items)
      const sections = document.querySelectorAll(
        '.menuSection, .menuVirtualizedSection, [class*="restaurant-menu-section"]'
      );

      for (const section of sections) {
        // Get category name from section header
        const headerEl = section.querySelector(
          '.menuSection-title, .menuSection-headerTitle, .menuVirtualizedSection-header, h2, h3'
        );
        const catName = headerEl?.textContent?.trim() || '';
        if (!catName || catName.length > 80) continue;
        // Skip non-menu sections
        if (['Best Sellers', 'Order Again', 'Similar options nearby'].includes(catName)) continue;

        const items: Array<{ platformItemId: string; name: string; priceCents: number; description: string }> = [];

        const itemEls = section.querySelectorAll(
          '.menuItem, .restaurant-menu-item, .restaurant-flatten-menu-item, [class*="menuItem-container"]'
        );

        for (const itemEl of itemEls) {
          // Extract item name
          const nameEl = itemEl.querySelector(
            '.menuItemNew-name, [class*="menuItemNew-name"], [class*="menuItem-name"]'
          );
          const name = nameEl?.textContent?.trim() || '';
          if (!name || name.length < 2) continue;

          // Extract price
          const priceEl = itemEl.querySelector(
            '.menuItem-priceAmount, .menuItem-priceAmountUnbolded, [class*="menuItem-price"]'
          );
          const priceText = priceEl?.textContent?.trim() || '';
          const priceMatch = priceText.match(/\$?(\d+\.\d{2})/);
          const priceCents = priceMatch ? Math.round(parseFloat(priceMatch[1]) * 100) : 0;

          // Extract description (optional)
          const descEl = itemEl.querySelector(
            '.menuItem-description, [class*="menuItem-desc"]'
          );
          const description = descEl?.textContent?.trim() || '';

          // Extract platform item ID from data attributes or click handler
          let platformItemId = '';
          // Try data attributes
          platformItemId = itemEl.getAttribute('data-item-id')
            || itemEl.getAttribute('data-testid')
            || '';
          // Try extracting from link href (e.g. /menu/restaurant/item/12345)
          if (!platformItemId) {
            const link = itemEl.querySelector('a[href*="item/"], button[data-item-id]');
            const href = link?.getAttribute('href') || '';
            const idMatch = href.match(/item\/(\d+)/);
            if (idMatch) platformItemId = idMatch[1];
          }
          // Fallback: generate deterministic ID from name + category
          if (!platformItemId) {
            platformItemId = `sl-${catName}-${name}`.replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 80);
          }

          items.push({ platformItemId, name, priceCents, description });
        }

        if (items.length > 0) {
          categories.push({ name: catName, items });
        }
      }

      return categories;
    });

    return { categories: menuData };
    } finally {
      // Navigate back to seamless.com so the main page is ready for API calls
      await scrapePage.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /**
   * Set the Seamless delivery address by interacting with the address bar UI.
   * Used to ensure the restaurant is in delivery range so the full menu renders.
   */
  private async setDeliveryAddressViaUI(page: import('playwright').Page, address: string): Promise<void> {
    try {
      // Navigate to Seamless home to access the address bar
      await page.goto('https://www.seamless.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));

      // Look for the address input — Seamless has it in the top nav
      const addressInput = await page.$('input[aria-label*="address" i], input[placeholder*="address" i], input[name*="address" i], #addressAutocomplete');
      if (!addressInput) {
        console.log('[Seamless] Address input not found — using current saved address');
        return;
      }

      // Clear and type the new address
      await addressInput.click({ clickCount: 3 }); // select all
      await addressInput.fill(address);
      await new Promise(r => setTimeout(r, 2000)); // wait for autocomplete

      // Select the first autocomplete suggestion
      const suggestion = await page.$('.pac-item, [class*="suggestion"], [class*="autocomplete"] li, [role="option"]');
      if (suggestion) {
        await suggestion.click();
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[Seamless] Address set to: ${address}`);
      } else {
        // Try pressing Enter if no suggestion dropdown
        await addressInput.press('Enter');
        await new Promise(r => setTimeout(r, 2000));
      }
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
