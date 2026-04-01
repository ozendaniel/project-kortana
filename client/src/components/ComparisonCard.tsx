import type { PlatformComparison } from '../api/client';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface ComparisonCardProps {
  platform: string;
  comparison: PlatformComparison;
  isCheapest: boolean;
  savings?: number;
}

export default function ComparisonCard({ platform, comparison, isCheapest, savings }: ComparisonCardProps) {
  const platformLabel = platform === 'doordash' ? 'DoorDash' : platform === 'seamless' ? 'Seamless' : 'Uber Eats';
  const platformColor = platform === 'doordash' ? 'red' : platform === 'seamless' ? 'orange' : 'green';

  return (
    <div
      className={`bg-white rounded-lg border-2 p-6 ${
        isCheapest ? 'border-green-500 ring-2 ring-green-100' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className={`text-lg font-semibold text-${platformColor}-600`}>{platformLabel}</h3>
        {isCheapest && (
          <span className="bg-green-100 text-green-700 text-xs font-bold px-2.5 py-1 rounded-full">
            Best Price {savings ? `— Save ${formatCents(savings)}` : ''}
          </span>
        )}
      </div>

      {!comparison.available && comparison.missingItems.length > 0 && (
        <div className="mb-3 p-2 bg-yellow-50 rounded text-sm text-yellow-700">
          Missing: {comparison.missingItems.join(', ')}
        </div>
      )}

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Items subtotal</span>
          <span>{formatCents(comparison.itemSubtotalCents)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Delivery fee</span>
          <span>{formatCents(comparison.deliveryFeeCents)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Service fee</span>
          <span>{formatCents(comparison.serviceFeeCents)}</span>
        </div>
        {comparison.smallOrderFeeCents > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-500">Small order fee</span>
            <span>{formatCents(comparison.smallOrderFeeCents)}</span>
          </div>
        )}
        {comparison.taxCents > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-500">Tax</span>
            <span>{formatCents(comparison.taxCents)}</span>
          </div>
        )}
        {comparison.discountCents > 0 && (
          <div className="flex justify-between text-green-600">
            <span>Discount</span>
            <span>-{formatCents(comparison.discountCents)}</span>
          </div>
        )}
        <div className="flex justify-between pt-2 border-t border-gray-100 font-bold text-lg">
          <span>Total</span>
          <span>{formatCents(comparison.totalCents)}</span>
        </div>
        <div className="flex justify-between text-gray-400 text-xs">
          <span>+ Optional tip (5%)</span>
          <span>+{formatCents(comparison.tipCents)}</span>
        </div>
        <div className="flex justify-between text-gray-500 text-sm">
          <span>Total w/ tip</span>
          <span>{formatCents(comparison.totalWithTipCents)}</span>
        </div>
        {comparison.estimatedDeliveryTime && (
          <p className="text-gray-400 text-xs mt-1">{comparison.estimatedDeliveryTime}</p>
        )}
      </div>

      <a
        href={comparison.orderUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`mt-4 block w-full py-2.5 text-center font-medium rounded-lg transition-colors ${
          isCheapest
            ? 'bg-green-600 text-white hover:bg-green-700'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        }`}
      >
        Order on {platformLabel}
      </a>
    </div>
  );
}
