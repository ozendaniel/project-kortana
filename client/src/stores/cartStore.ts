import { create } from 'zustand';
import type { ModifierSelection } from '../api/client';

export interface CartItem {
  /** Unique key for this cart line. itemId for simple items, itemId#hash for modified items */
  cartLineId: string;
  itemId: string;
  name: string;
  quantity: number;
  platforms: Record<string, { priceCents: number; available: boolean }>;
  modifierSelections?: ModifierSelection[];
  /** Human-readable summary like "Chocolate, Large" */
  modifierSummary?: string;
}

/** Build a stable cart line key from itemId + selections */
function cartLineKey(itemId: string, selections?: ModifierSelection[]): string {
  if (!selections || selections.length === 0) return itemId;
  const sorted = [...selections].sort((a, b) => a.groupId.localeCompare(b.groupId));
  const key = sorted.map(s => `${s.groupId}:${s.optionIds.slice().sort().join(',')}`).join('|');
  return `${itemId}#${key}`;
}

interface CartState {
  restaurantId: string | null;
  restaurantName: string | null;
  items: CartItem[];
  deliveryAddress: { lat: number; lng: number; address: string } | null;

  setRestaurant: (id: string, name: string) => void;
  setDeliveryAddress: (address: { lat: number; lng: number; address: string }) => void;
  addItem: (item: Omit<CartItem, 'quantity' | 'cartLineId'>) => void;
  removeItem: (cartLineId: string) => void;
  updateQuantity: (cartLineId: string, quantity: number) => void;
  clearCart: () => void;
  totalItems: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  restaurantId: null,
  restaurantName: null,
  items: [],
  deliveryAddress: null,

  setRestaurant: (id, name) => set({ restaurantId: id, restaurantName: name, items: [] }),

  setDeliveryAddress: (address) => set({ deliveryAddress: address }),

  addItem: (item) =>
    set((state) => {
      const lineId = cartLineKey(item.itemId, item.modifierSelections);
      const existing = state.items.find((i) => i.cartLineId === lineId);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.cartLineId === lineId ? { ...i, quantity: i.quantity + 1 } : i
          ),
        };
      }
      return { items: [...state.items, { ...item, cartLineId: lineId, quantity: 1 }] };
    }),

  removeItem: (cartLineId) =>
    set((state) => ({
      items: state.items.filter((i) => i.cartLineId !== cartLineId),
    })),

  updateQuantity: (cartLineId, quantity) =>
    set((state) => {
      if (quantity <= 0) {
        return { items: state.items.filter((i) => i.cartLineId !== cartLineId) };
      }
      return {
        items: state.items.map((i) => (i.cartLineId === cartLineId ? { ...i, quantity } : i)),
      };
    }),

  clearCart: () => set({ restaurantId: null, restaurantName: null, items: [] }),

  totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
}));
