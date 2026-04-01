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
  const label = platform === 'doordash' ? 'DoorDash' : platform === 'seamless' ? 'Seamless' : 'Uber Eats';
  const abbr = platform === 'doordash' ? 'DD' : 'SL';
  const accent = platform === 'doordash' ? 'text-dd' : 'text-sl';
  const accentBg = platform === 'doordash' ? 'bg-dd-bg' : 'bg-sl-bg';

  const feeLines: Array<{ label: string; cents: number; highlight?: boolean }> = [
    { label: 'Subtotal', cents: comparison.itemSubtotalCents },
    { label: 'Delivery', cents: comparison.deliveryFeeCents },
    { label: 'Service', cents: comparison.serviceFeeCents },
  ];
  if (comparison.smallOrderFeeCents > 0) {
    feeLines.push({ label: 'Small order fee', cents: comparison.smallOrderFeeCents });
  }
  if (comparison.taxCents > 0) {
    feeLines.push({ label: 'Tax', cents: comparison.taxCents });
  }
  if (comparison.discountCents > 0) {
    feeLines.push({ label: 'Discount', cents: -comparison.discountCents, highlight: true });
  }

  return (
    <div
      className={`relative bg-surface border rounded-sm overflow-hidden transition-all ${
        isCheapest
          ? 'border-lime/30 winner-stripe'
          : 'border-border-subtle'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded-sm ${accentBg} ${accent}`}>
            {abbr}
          </span>
          <span className="text-sm font-medium text-text-primary">{label}</span>
        </div>
        {isCheapest && (
          <span className="text-[10px] font-mono font-bold text-lime tracking-wider uppercase animate-count-up">
            Best Price
          </span>
        )}
      </div>

      {/* Missing items warning */}
      {!comparison.available && comparison.missingItems.length > 0 && (
        <div className="px-5 py-2 bg-amber-bg border-b border-border-subtle">
          <p className="text-xs text-amber-accent font-mono">
            Missing: {comparison.missingItems.join(', ')}
          </p>
        </div>
      )}

      {/* Fee breakdown — receipt style */}
      <div className="px-5 py-4 space-y-0">
        {feeLines.map((line, i) => (
          <div key={i} className="flex justify-between py-1.5 receipt-dots last:border-0">
            <span className="text-xs text-text-secondary">{line.label}</span>
            <span className={`price text-xs ${line.highlight ? 'text-lime' : 'text-text-primary'}`}>
              {line.highlight ? '-' : ''}{formatCents(Math.abs(line.cents))}
            </span>
          </div>
        ))}

        {/* Total */}
        <div className="flex justify-between items-baseline pt-3 mt-2 border-t border-border">
          <span className="text-xs font-mono text-text-secondary tracking-wide uppercase">Total</span>
          <span className={`price text-xl font-bold ${isCheapest ? 'text-lime' : 'text-text-primary'}`}>
            {formatCents(comparison.totalCents)}
          </span>
        </div>

        {/* Tip line */}
        <div className="flex justify-between py-1 mt-1">
          <span className="text-[10px] text-text-muted">w/ 5% tip</span>
          <span className="price text-[10px] text-text-muted">
            {formatCents(comparison.totalWithTipCents)}
          </span>
        </div>

        {/* Savings callout */}
        {isCheapest && savings && savings > 0 && (
          <div className="mt-3 py-2 px-3 bg-lime-glow border border-lime/15 rounded-sm animate-count-up">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-lime/70 font-mono">You save</span>
              <span className="price text-lg font-bold text-lime">
                {formatCents(savings)}
              </span>
            </div>
          </div>
        )}

        {comparison.estimatedDeliveryTime && (
          <p className="text-[10px] font-mono text-text-muted mt-2 tracking-wide">
            ETA {comparison.estimatedDeliveryTime}
          </p>
        )}
      </div>

      {/* Order button */}
      <div className="px-5 pb-5">
        <a
          href={comparison.orderUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`block w-full py-2.5 text-center text-sm font-semibold rounded-sm transition-colors ${
            isCheapest
              ? 'bg-lime text-base hover:bg-lime-dim'
              : 'bg-surface-hover text-text-secondary border border-border hover:text-text-primary hover:border-border'
          }`}
        >
          Order on {label}
        </a>
      </div>
    </div>
  );
}
