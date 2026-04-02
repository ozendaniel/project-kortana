import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// Types
export interface Restaurant {
  id: string;
  name: string;
  address: string;
  locations?: Array<{ id: string; address: string }>;
  cuisines: string[];
  platforms: {
    doordash?: { available: boolean; deliveryTime?: string; deliveryFee?: number };
    seamless?: { available: boolean; deliveryTime?: string; deliveryFee?: number };
  };
  imageUrl?: string;
}

export interface UnifiedMenuItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  platforms: Record<string, { itemId: string; priceCents: number; available: boolean }>;
}

export interface MenuCategory {
  category: string;
  items: UnifiedMenuItem[];
}

export interface PlatformComparison {
  available: boolean;
  itemSubtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  taxCents: number;
  discountCents: number;
  tipCents: number;
  totalCents: number;
  totalWithTipCents: number;
  estimatedDeliveryTime?: string;
  missingItems: string[];
  orderUrl: string;
}

export interface ComparisonResult {
  doordash?: PlatformComparison;
  seamless?: PlatformComparison;
  cheapest: string | null;
  savingsCents: number;
}

export interface SavingsData {
  totalOrders: number;
  totalSavingsCents: number;
  averageSavingsPerOrderCents: number;
  platformBreakdown: Record<string, { timesChosen: number; totalSpentCents: number }>;
  recentOrders: unknown[];
}

// API functions
export interface SearchResult {
  restaurants: Restaurant[];
  location: { lat: number; lng: number; formattedAddress: string };
}

export async function searchRestaurants(
  address: string,
  query?: string,
  options?: { radius?: number; cuisine?: string }
): Promise<SearchResult> {
  const params = new URLSearchParams({ address });
  if (query) params.set('q', query);
  if (options?.radius) params.set('radius', String(options.radius));
  if (options?.cuisine) params.set('cuisine', options.cuisine);
  const { data } = await api.get(`/restaurants/search?${params}`);
  return { restaurants: data.restaurants, location: data.location };
}

export async function getMenu(restaurantId: string): Promise<{ restaurant: { id: string; name: string; address: string }; menu: MenuCategory[] }> {
  const { data } = await api.get(`/menus/${restaurantId}`);
  return data;
}

export async function compareOrder(
  restaurantId: string,
  address: { lat: number; lng: number; address: string },
  items: Array<{ itemId: string; quantity: number }>
): Promise<ComparisonResult> {
  const { data } = await api.post('/compare', { restaurantId, address, items });
  return data.comparison;
}

export async function getSavings(): Promise<SavingsData> {
  const { data } = await api.get('/savings');
  return data;
}

export interface AuthStatusResponse {
  doordash: string;
  seamless: string;
}

export async function getAuthStatus(): Promise<AuthStatusResponse> {
  const { data } = await api.get('/auth/status');
  return data;
}

export async function logoutPlatform(platform: string): Promise<void> {
  await api.post(`/auth/logout/${platform}`);
}

export async function logOrder(order: {
  restaurantId: string;
  platformUsed: string;
  items: unknown[];
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  totalCents: number;
  comparisonData: unknown;
  savingsCents: number;
}): Promise<{ orderId: string }> {
  const { data } = await api.post('/orders', order);
  return data;
}
