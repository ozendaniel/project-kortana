import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMenu, type ModifierSelection, type UnifiedMenuItem } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import CartPanel from './CartPanel';
import ModifierModal from './ModifierModal';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function MenuView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const highlightQuery = searchParams.get('q')?.toLowerCase() || '';
  const firstHighlightSet = useRef(false);
  const addItem = useCartStore((s) => s.addItem);
  const restaurantId = useCartStore((s) => s.restaurantId);
  const setRestaurant = useCartStore((s) => s.setRestaurant);

  // Modifier modal state
  const [modifierItem, setModifierItem] = useState<UnifiedMenuItem | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['menu', id],
    queryFn: () => getMenu(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (data?.restaurant && data.restaurant.id !== restaurantId) {
      setRestaurant(data.restaurant.id, data.restaurant.name);
    }
  }, [data?.restaurant?.id]);

  // Reset first-highlight tracker when data changes
  useEffect(() => {
    firstHighlightSet.current = false;
  }, [data?.menu]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="skeleton h-16 rounded-sm" />
        ))}
      </div>
    );
  }
  if (error || !data) return <p className="text-coral text-sm font-mono">Error loading menu.</p>;

  const { restaurant, menu } = data;

  const handleAddItem = (item: UnifiedMenuItem) => {
    if (item.hasModifiers) {
      setModifierItem(item);
      return;
    }
    addItem({
      itemId: item.id,
      name: item.name,
      platforms: Object.fromEntries(
        Object.entries(item.platforms).map(([p, v]) => [p, { priceCents: v.priceCents, available: v.available }])
      ),
    });
  };

  const handleModifierConfirm = (selections: ModifierSelection[], summary: string) => {
    if (!modifierItem) return;
    addItem({
      itemId: modifierItem.id,
      name: modifierItem.name,
      platforms: Object.fromEntries(
        Object.entries(modifierItem.platforms).map(([p, v]) => [p, { priceCents: v.priceCents, available: v.available }])
      ),
      modifierSelections: selections,
      modifierSummary: summary,
    });
    setModifierItem(null);
  };

  return (
    <div className="flex gap-6 animate-fade-up">
      {/* Menu */}
      <div className="flex-1 min-w-0 space-y-6">
        <div>
          <button
            onClick={() => navigate('/')}
            className="text-xs font-mono text-text-muted hover:text-text-secondary transition-colors mb-3 block tracking-wide"
          >
            &larr; BACK
          </button>
          <h1 className="font-display text-3xl text-text-primary tracking-tight italic">
            {restaurant.name}
          </h1>
          {restaurant.address && (
            <p className="text-xs text-text-muted mt-1">{restaurant.address}</p>
          )}
        </div>

        {menu.map((category, catIdx) => (
          <div key={category.category} style={{ animationDelay: `${catIdx * 80}ms` }} className="animate-fade-up">
            <h2 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase mb-3 pb-2 border-b border-border-subtle">
              {category.category}
            </h2>
            <div className="space-y-0.5">
              {category.items.map((item) => {
                const prices = Object.entries(item.platforms)
                  .sort(([a], [b]) => (a === 'doordash' ? -1 : b === 'doordash' ? 1 : 0));
                const priceDiff = prices.length === 2 && prices[0] && prices[1]
                  ? Math.abs(prices[0][1].priceCents - prices[1][1].priceCents)
                  : 0;
                const isHighlighted = highlightQuery && item.name.toLowerCase().includes(highlightQuery);

                return (
                  <div
                    key={item.id}
                    ref={isHighlighted && !firstHighlightSet.current ? (el) => {
                      if (el) {
                        firstHighlightSet.current = true;
                        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
                      }
                    } : undefined}
                    className={`group flex items-center gap-3 py-3 px-3 -mx-3 rounded-sm hover:bg-surface transition-colors ${
                      isHighlighted ? 'border border-lime/30 bg-lime/5' : ''
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <h3 className="text-sm font-medium text-text-primary truncate">
                          {item.name}
                        </h3>
                        {item.hasModifiers && (
                          <span className="shrink-0 text-[10px] font-mono text-amber-accent tracking-wide">
                            CUSTOM
                          </span>
                        )}
                        {priceDiff > 0 && (
                          <span className="shrink-0 text-[10px] font-mono text-lime/60">
                            {formatCents(priceDiff)} diff
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="text-xs text-text-muted mt-0.5 line-clamp-1">{item.description}</p>
                      )}
                    </div>

                    {/* Prices */}
                    <div className="flex gap-3 shrink-0">
                      {prices.map(([platform, info]) => (
                        <span
                          key={platform}
                          className={`price text-xs font-medium ${
                            platform === 'doordash' ? 'text-dd' : 'text-sl'
                          }`}
                        >
                          {formatCents(info.priceCents)}
                        </span>
                      ))}
                    </div>

                    {/* Add button */}
                    <button
                      onClick={() => handleAddItem(item)}
                      className="opacity-0 group-hover:opacity-100 shrink-0 w-7 h-7 flex items-center justify-center text-sm font-mono font-bold text-lime bg-lime/10 border border-lime/20 rounded-sm hover:bg-lime/20 transition-all"
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Cart sidebar */}
      <div className="w-72 shrink-0 hidden lg:block">
        <CartPanel onCompare={() => navigate('/compare')} />
      </div>

      {/* Mobile cart bar */}
      <MobileCartBar onCompare={() => navigate('/compare')} />

      {/* Modifier modal */}
      {modifierItem && (
        <ModifierModal
          itemId={modifierItem.id}
          itemName={modifierItem.name}
          onConfirm={handleModifierConfirm}
          onClose={() => setModifierItem(null)}
        />
      )}
    </div>
  );
}

function MobileCartBar({ onCompare }: { onCompare: () => void }) {
  const items = useCartStore((s) => s.items);
  const total = items.reduce((sum, i) => sum + i.quantity, 0);
  if (total === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 lg:hidden z-40 bg-surface border-t border-border p-4 animate-slide-down">
      <button
        onClick={onCompare}
        className="w-full py-3 bg-lime text-base font-semibold text-sm rounded-sm flex items-center justify-center gap-2"
      >
        <span className="font-mono">{total}</span>
        <span>Compare Prices</span>
      </button>
    </div>
  );
}
