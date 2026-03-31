import { useQuery } from '@tanstack/react-query';
import { compareOrder } from '../api/client';
import { useCartStore } from '../stores/cartStore';

export function useComparison() {
  const { restaurantId, items, deliveryAddress } = useCartStore();

  return useQuery({
    queryKey: ['compare', restaurantId, items.map((i) => `${i.itemId}:${i.quantity}`)],
    queryFn: () =>
      compareOrder(
        restaurantId!,
        deliveryAddress!,
        items.map((i) => ({ itemId: i.itemId, quantity: i.quantity }))
      ),
    enabled: !!restaurantId && items.length > 0 && !!deliveryAddress,
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
}
