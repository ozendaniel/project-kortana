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
  hasModifiers?: boolean;
}

export interface ModifierOption {
  id: string;
  name: string;
  description?: string;
  priceDeltaCents: number;
  isDefault: boolean;
  defaultQuantity: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelection: number;
  maxSelection: number;
  selectionMode: 'single_select' | 'multi_select';
  isOptional: boolean;
  options: ModifierOption[];
  subtitle?: string;
}

export interface ModifierSelection {
  groupId: string;
  optionIds: string[];
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

export async function getItemModifiers(itemId: string): Promise<ModifierGroup[]> {
  const { data } = await api.get(`/menus/items/${itemId}/modifiers`);
  return data.modifierGroups || [];
}

export async function compareOrder(
  restaurantId: string,
  address: { lat: number; lng: number; address: string },
  items: Array<{ itemId: string; quantity: number; modifierSelections?: ModifierSelection[] }>
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

// Menu item search types
export interface ItemSearchMatchingItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  platforms: Record<string, { priceCents: number }>;
}

export interface ItemSearchResultEntry {
  restaurant: {
    id: string;
    name: string;
    address: string;
    platforms: Record<string, { available: boolean }>;
  };
  matchingItems: ItemSearchMatchingItem[];
  totalMatches: number;
}

export interface ItemSearchResponse {
  results: ItemSearchResultEntry[];
  location: { lat: number; lng: number; formattedAddress: string };
  totalItems: number;
}

export async function searchMenuItems(
  address: string,
  query: string,
  options?: { radius?: number; cuisine?: string; limit?: number }
): Promise<ItemSearchResponse> {
  const params = new URLSearchParams({ address, q: query });
  if (options?.radius) params.set('radius', String(options.radius));
  if (options?.cuisine) params.set('cuisine', options.cuisine);
  if (options?.limit) params.set('limit', String(options.limit));
  const { data } = await api.get(`/menu-items/search?${params}`);
  return data;
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
