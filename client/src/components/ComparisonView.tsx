import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { compareOrder } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import ComparisonCard from './ComparisonCard';

export default function ComparisonView() {
  const navigate = useNavigate();
  const { restaurantId, restaurantName, items, deliveryAddress } = useCartStore();

  // Use delivery address or a default NYC location for Phase 1
  const effectiveAddress = deliveryAddress || { lat: 40.7359, lng: -73.9911, address: 'New York, NY' };

  const { data: comparison, isLoading, error } = useQuery({
    queryKey: ['compare', restaurantId, items],
    queryFn: () =>
      compareOrder(
        restaurantId!,
        effectiveAddress,
        items.map((i) => ({ itemId: i.itemId, quantity: i.quantity }))
      ),
    enabled: !!restaurantId && items.length > 0,
  });

  if (!restaurantId || items.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 mb-4">No items in cart. Add items from a restaurant first.</p>
        <button
          onClick={() => navigate('/')}
          className="text-blue-600 hover:underline"
        >
          Search restaurants
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <button onClick={() => navigate(-1)} className="text-sm text-blue-600 hover:underline mb-2">
          &larr; Back to menu
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Price Comparison</h1>
        <p className="text-gray-500">
          {restaurantName} &mdash; {items.reduce((s, i) => s + i.quantity, 0)} items
        </p>
      </div>

      {isLoading && <p className="text-gray-400">Comparing prices across platforms...</p>}
      {error && <p className="text-red-500">Error comparing prices. Try again.</p>}

      {comparison && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {comparison.doordash && (
            <ComparisonCard
              platform="doordash"
              comparison={comparison.doordash}
              isCheapest={comparison.cheapest === 'doordash'}
              savings={comparison.cheapest === 'doordash' ? comparison.savingsCents : undefined}
            />
          )}
          {comparison.seamless && (
            <ComparisonCard
              platform="seamless"
              comparison={comparison.seamless}
              isCheapest={comparison.cheapest === 'seamless'}
              savings={comparison.cheapest === 'seamless' ? comparison.savingsCents : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}
