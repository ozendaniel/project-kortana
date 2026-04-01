export type Platform = 'doordash' | 'seamless' | 'ubereats';

export interface PlatformCredentials {
  email: string;
  password?: string;
}

export interface PlatformAdapter {
  platform: Platform;

  /** Initialize browser session (called once at server start) */
  initialize(credentials: PlatformCredentials): Promise<void>;

  /** Check if session is still valid */
  isSessionValid(): Promise<boolean>;

  /** Search restaurants near an address */
  searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;
    cuisine?: string;
  }): Promise<PlatformRestaurant[]>;

  /** Get full menu for a restaurant */
  getMenu(platformRestaurantId: string): Promise<PlatformMenu>;

  /** Get real-time fee estimate for an order */
  getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees>;

  /** Phase 2: Build cart and checkout */
  placeOrder?(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number; modifiers?: unknown }>;
    deliveryAddress: { lat: number; lng: number; address: string };
    paymentMethodId?: string;
  }): Promise<PlatformOrderConfirmation>;
}

export interface PlatformRestaurant {
  platformId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
  cuisines: string[];
  rating?: number;
  deliveryTime?: string;
  deliveryFee?: number;       // cents
  imageUrl?: string;
  platformUrl: string;
}

export interface PlatformMenu {
  categories: Array<{
    name: string;
    items: Array<{
      platformItemId: string;
      name: string;
      description?: string;
      priceCents: number;
      imageUrl?: string;
      modifiers?: Array<{
        name: string;
        options: Array<{ name: string; priceCents: number }>;
        required: boolean;
        maxSelections: number;
      }>;
    }>;
  }>;
}

export interface PlatformFees {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  taxCents: number;
  discountCents: number;       // positive = savings (shown as negative on UI)
  totalCents: number;
  estimatedDeliveryTime?: string;
}

export interface PlatformOrderConfirmation {
  orderId: string;
  estimatedDeliveryTime: string;
  totalChargedCents: number;
}
