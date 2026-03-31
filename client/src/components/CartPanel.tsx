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
      <div className="sticky top-8 bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="font-semibold text-gray-900 mb-2">Your Cart</h2>
        <p className="text-sm text-gray-400">Add items from the menu to compare prices</p>
      </div>
    );
  }

  return (
    <div className="sticky top-8 bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">Your Cart</h2>
        <button onClick={clearCart} className="text-xs text-gray-400 hover:text-red-500">
          Clear
        </button>
      </div>

      {restaurantName && (
        <p className="text-sm text-gray-500">{restaurantName}</p>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.itemId} className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
              <div className="flex gap-2 text-xs text-gray-400">
                {Object.entries(item.platforms).map(([p, v]) => (
                  <span key={p}>
                    {p === 'doordash' ? 'DD' : 'SL'}: {formatCents(v.priceCents * item.quantity)}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 ml-2">
              <button
                onClick={() => updateQuantity(item.itemId, item.quantity - 1)}
                className="w-6 h-6 flex items-center justify-center rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                -
              </button>
              <span className="text-sm w-4 text-center">{item.quantity}</span>
              <button
                onClick={() => updateQuantity(item.itemId, item.quantity + 1)}
                className="w-6 h-6 flex items-center justify-center rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
              >
                +
              </button>
              <button
                onClick={() => removeItem(item.itemId)}
                className="text-gray-300 hover:text-red-500 ml-1"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onCompare}
        className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
      >
        Compare Prices
      </button>
    </div>
  );
}
