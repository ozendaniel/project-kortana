import { useCartStore } from '../stores/cartStore';

/**
 * Convenience hook that wraps the cart store for components.
 * Returns computed values alongside actions.
 */
export function useCart() {
  const store = useCartStore();

  const subtotalByPlatform = (platform: string): number => {
    return store.items.reduce((sum, item) => {
      const platformData = item.platforms[platform];
      if (!platformData) return sum;
      return sum + platformData.priceCents * item.quantity;
    }, 0);
  };

  const itemCount = store.items.reduce((sum, i) => sum + i.quantity, 0);

  return {
    ...store,
    itemCount,
    subtotalByPlatform,
    isEmpty: store.items.length === 0,
  };
}
