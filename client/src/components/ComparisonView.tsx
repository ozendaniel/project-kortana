import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { compareOrder } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import ComparisonCard from './ComparisonCard';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ComparisonView() {
  const navigate = useNavigate();
  const { restaurantId, restaurantName, items, deliveryAddress } = useCartStore();
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
      <div className="text-center py-20 animate-fade-up">
        <p className="font-display text-2xl italic text-text-secondary mb-4">Nothing to compare yet</p>
        <p className="text-sm text-text-muted mb-6">Add items from a restaurant to see price differences</p>
        <button
          onClick={() => navigate('/')}
          className="text-sm font-mono text-lime hover:text-lime-dim transition-colors tracking-wide"
        >
          &larr; SEARCH RESTAURANTS
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate(-1)}
          className="text-xs font-mono text-text-muted hover:text-text-secondary transition-colors mb-3 block tracking-wide"
        >
          &larr; BACK
        </button>
        <h1 className="font-display text-3xl text-text-primary tracking-tight italic">
          Price Comparison
        </h1>
        <div className="flex items-baseline gap-3 mt-1">
          <span className="text-sm text-text-secondary">{restaurantName}</span>
          <span className="text-xs font-mono text-text-muted">
            {items.reduce((s, i) => s + i.quantity, 0)} items
          </span>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="skeleton h-72 rounded-sm" />
          <div className="skeleton h-72 rounded-sm" style={{ animationDelay: '100ms' }} />
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-coral text-sm font-mono">Error comparing prices. Try again.</p>
      )}

      {/* Comparison cards */}
      {comparison && (
        <>
          {/* Savings hero */}
          {comparison.savingsCents > 0 && (
            <div className="text-center py-6 animate-count-up">
              <p className="text-xs font-mono text-text-muted tracking-widest uppercase mb-2">
                Savings with {comparison.cheapest === 'doordash' ? 'DoorDash' : 'Seamless'}
              </p>
              <p className="price text-5xl font-bold text-lime">
                {formatCents(comparison.savingsCents)}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger">
            {/* Show cheapest first */}
            {comparison.cheapest === 'seamless' && comparison.seamless && (
              <ComparisonCard
                platform="seamless"
                comparison={comparison.seamless}
                isCheapest={true}
                savings={comparison.savingsCents}
              />
            )}
            {comparison.cheapest === 'doordash' && comparison.doordash && (
              <ComparisonCard
                platform="doordash"
                comparison={comparison.doordash}
                isCheapest={true}
                savings={comparison.savingsCents}
              />
            )}
            {/* Then the other */}
            {comparison.cheapest !== 'doordash' && comparison.doordash && (
              <ComparisonCard
                platform="doordash"
                comparison={comparison.doordash}
                isCheapest={comparison.cheapest === 'doordash'}
                savings={comparison.cheapest === 'doordash' ? comparison.savingsCents : undefined}
              />
            )}
            {comparison.cheapest !== 'seamless' && comparison.seamless && (
              <ComparisonCard
                platform="seamless"
                comparison={comparison.seamless}
                isCheapest={comparison.cheapest === 'seamless'}
                savings={comparison.cheapest === 'seamless' ? comparison.savingsCents : undefined}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
