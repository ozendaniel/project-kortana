import { SeamlessBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
  PlatformOrderConfirmation,
} from '../types.js';

// Seamless/Grubhub REST base — to be confirmed via DevTools capture
const API_BASE = 'https://api-gtm.grubhub.com';

export class SeamlessAdapter implements PlatformAdapter {
  platform = 'seamless' as const;
  private browser = new SeamlessBrowser();
  private sessionCookie = '';

  async initialize(credentials: PlatformCredentials): Promise<void> {
    await this.browser.launch();
    const loggedIn = await this.browser.isLoggedIn();

    if (!loggedIn) {
      console.log('[Seamless] Session expired or not found. Attempting login...');
      // TODO: Automate login — Seamless uses email/password (no OTP)
      // 1. Navigate to login page
      // 2. Fill email and password
      // 3. Submit and wait for redirect
      console.log('[Seamless] Automated login not yet implemented — please log in manually in browser window.');
    } else {
      console.log('[Seamless] Existing session found and valid.');
    }

    // Extract session cookies for direct HTTP calls
    this.sessionCookie = await this.browser.getSessionCookies();
  }

  async isSessionValid(): Promise<boolean> {
    return this.browser.isLoggedIn();
  }

  /** Make an authenticated REST call to Seamless/Grubhub API */
  private async apiCall<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.sessionCookie,
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Seamless API ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]> {
    // TODO: Capture exact endpoint and params via DevTools
    // Expected: GET /restaurants/search?lat={lat}&lng={lng}&...
    console.log('[Seamless] searchRestaurants — not yet implemented');
    return [];
  }

  async getMenu(platformRestaurantId: string): Promise<PlatformMenu> {
    // TODO: GET /restaurant/{id}/menu
    console.log('[Seamless] getMenu — not yet implemented');
    return { categories: [] };
  }

  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    // TODO: POST /cart/add for each item, then GET /cart/checkout_summary
    console.log('[Seamless] getFees — not yet implemented');
    return {
      subtotalCents: 0,
      deliveryFeeCents: 0,
      serviceFeeCents: 0,
      smallOrderFeeCents: 0,
      totalCents: 0,
    };
  }
}
