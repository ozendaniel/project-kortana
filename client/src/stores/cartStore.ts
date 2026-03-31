import { create } from 'zustand';

export interface CartItem {
  itemId: string;
  name: string;
  quantity: number;
  platforms: Record<string, { priceCents: number; available: boolean }>;
}

interface CartState {
  restaurantId: string | null;
  restaurantName: string | null;
  items: CartItem[];
  deliveryAddress: { lat: number; lng: number; address: string } | null;

  setRestaurant: (id: string, name: string) => void;
  setDeliveryAddress: (address: { lat: number; lng: number; address: string }) => void;
  addItem: (item: Omit<CartItem, 'quantity'>) => void;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
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
      const existing = state.items.find((i) => i.itemId === item.itemId);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.itemId === item.itemId ? { ...i, quantity: i.quantity + 1 } : i
          ),
        };
      }
      return { items: [...state.items, { ...item, quantity: 1 }] };
    }),

  removeItem: (itemId) =>
    set((state) => ({
      items: state.items.filter((i) => i.itemId !== itemId),
    })),

  updateQuantity: (itemId, quantity) =>
    set((state) => {
      if (quantity <= 0) {
        return { items: state.items.filter((i) => i.itemId !== itemId) };
      }
      return {
        items: state.items.map((i) => (i.itemId === itemId ? { ...i, quantity } : i)),
      };
    }),

  clearCart: () => set({ restaurantId: null, restaurantName: null, items: [] }),

  totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
}));
