import { useCartStore } from '../stores/cartStore';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface CartPanelProps {
  onCompare: () => void;
}

export default function CartPanel({ onCompare }: CartPanelProps) {
  const { items, restaurantName, updateQuantity, removeItem, clearCart } = useCartStore();

  if (items.length === 0) {
    return (
      <div className="sticky top-24 bg-surface border border-border-subtle rounded-sm p-5">
        <h2 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase">
          Cart
        </h2>
        <p className="text-xs text-text-muted mt-3">Add items to compare prices across platforms</p>
      </div>
    );
  }

  return (
    <div className="sticky top-24 bg-surface border border-border-subtle rounded-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
        <h2 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase">
          Cart
        </h2>
        <button onClick={clearCart} className="text-[10px] font-mono text-text-muted hover:text-coral transition-colors tracking-wide uppercase">
          Clear
        </button>
      </div>

      {restaurantName && (
        <div className="px-5 py-2 border-b border-border-subtle">
          <p className="text-xs text-text-secondary truncate">{restaurantName}</p>
        </div>
      )}

      {/* Items */}
      <div className="px-5 py-3 space-y-3 max-h-80 overflow-y-auto">
        {items.map((item) => (
          <div key={item.itemId} className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary truncate">{item.name}</p>
              <div className="flex gap-2 mt-0.5">
                {Object.entries(item.platforms).sort(([a], [b]) => (a === 'doordash' ? -1 : b === 'doordash' ? 1 : 0)).map(([p, v]) => (
                  <span key={p} className={`price text-[10px] ${p === 'doordash' ? 'text-dd' : 'text-sl'}`}>
                    {formatCents(v.priceCents * item.quantity)}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => updateQuantity(item.itemId, item.quantity - 1)}
                className="w-5 h-5 flex items-center justify-center text-xs font-mono text-text-muted bg-base rounded-sm hover:text-text-primary transition-colors"
              >
                &minus;
              </button>
              <span className="price text-xs w-4 text-center text-text-primary">{item.quantity}</span>
              <button
                onClick={() => updateQuantity(item.itemId, item.quantity + 1)}
                className="w-5 h-5 flex items-center justify-center text-xs font-mono text-text-muted bg-base rounded-sm hover:text-text-primary transition-colors"
              >
                +
              </button>
              <button
                onClick={() => removeItem(item.itemId)}
                className="w-5 h-5 flex items-center justify-center text-xs text-text-muted hover:text-coral transition-colors ml-1"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Compare button */}
      <div className="px-5 py-4 border-t border-border-subtle">
        <button
          onClick={onCompare}
          className="w-full py-2.5 bg-lime text-base font-semibold text-sm rounded-sm hover:bg-lime-dim transition-colors tracking-wide"
        >
          Compare Prices
        </button>
      </div>
    </div>
  );
}
