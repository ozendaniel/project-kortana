import { DoorDashBrowser } from './browser.js';
import type {
  PlatformAdapter,
  PlatformCredentials,
  PlatformRestaurant,
  PlatformMenu,
  PlatformFees,
  PlatformOrderConfirmation,
} from '../types.js';
import fs from 'fs';
import path from 'path';

const QUERIES_DIR = path.join(__dirname, 'queries');

function loadQuery(filename: string): string {
  return fs.readFileSync(path.join(QUERIES_DIR, filename), 'utf-8');
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
      // In Phase 1, user logs in manually in the browser window.
      // The persistent browser profile will save the session for future launches.
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
    // TODO: Load homePageFacetFeed.graphql query
    // 1. Set delivery address via addConsumerAddress mutation
    // 2. Execute homePageFacetFeed query with search filters
    // 3. Map response to PlatformRestaurant[]
    console.log('[DoorDash] searchRestaurants — not yet implemented');
    return [];
  }

  async getMenu(platformRestaurantId: string): Promise<PlatformMenu> {
    // TODO: Load storepageFeed.graphql query
    // 1. Execute storepageFeed query with restaurant ID
    // 2. Parse categories and items from response
    // 3. Map to PlatformMenu format (prices in cents)
    console.log('[DoorDash] getMenu — not yet implemented');
    return { categories: [] };
  }

  async getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees> {
    // TODO: Simulate adding items to cart and reading checkout preview
    // 1. Clear existing cart
    // 2. Add each item via addCartItem mutation
    // 3. Read cart summary for fee breakdown
    console.log('[DoorDash] getFees — not yet implemented');
    return {
      subtotalCents: 0,
      deliveryFeeCents: 0,
      serviceFeeCents: 0,
      smallOrderFeeCents: 0,
      totalCents: 0,
    };
  }
}
