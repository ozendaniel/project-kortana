import type { PlatformError } from '../api/client';

interface ComparisonErrorCardProps {
  platform: 'doordash' | 'seamless';
  error: PlatformError;
  onRetry: () => void;
}

const PLATFORM_LABELS: Record<string, { label: string; abbr: string; accent: string; accentBg: string }> = {
  doordash: { label: 'DoorDash', abbr: 'DD', accent: 'text-dd', accentBg: 'bg-dd-bg' },
  seamless: { label: 'Seamless', abbr: 'SL', accent: 'text-sl', accentBg: 'bg-sl-bg' },
};

function reasonCopy(reason: PlatformError['reason'], label: string, message: string): { headline: string; body: string } {
  switch (reason) {
    case 'session_expired':
      return {
        headline: 'Session expired',
        body: `Your ${label} session timed out. Reconnect to get live fees.`,
      };
    case 'adapter_unavailable':
      return {
        headline: `${label} is offline`,
        body: `${label} can't be reached right now — the server may be restarting or a data job is holding the browser. Try again in a moment.`,
      };
    case 'out_of_delivery_range':
      return {
        headline: 'Out of delivery range',
        body: `${label} doesn't deliver to this address for this restaurant.`,
      };
    case 'item_unavailable':
      return {
        headline: 'Item unavailable',
        body: message || `One or more items aren't available on ${label} right now.`,
      };
    case 'address_mismatch_doordash':
      return {
        headline: 'Address mismatch',
        body: `DoorDash couldn't match this delivery address to an address on your account.`,
      };
    default:
      return {
        headline: `${label} error`,
        body: message || `${label} live fee lookup failed. Try again.`,
      };
  }
}

export default function ComparisonErrorCard({ platform, error, onRetry }: ComparisonErrorCardProps) {
  const { label, abbr, accent, accentBg } = PLATFORM_LABELS[platform]!;
  const { headline, body } = reasonCopy(error.reason, label, error.message);
  const showReconnect = error.reason === 'session_expired';

  return (
    <div className="relative bg-surface border border-border-subtle rounded-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded-sm ${accentBg} ${accent}`}>
            {abbr}
          </span>
          <span className="text-sm font-medium text-text-primary">{label}</span>
        </div>
        <span className="text-[10px] font-mono font-bold text-coral tracking-wider uppercase">
          Unavailable
        </span>
      </div>

      <div className="px-5 py-6">
        <p className="font-display text-lg italic text-text-primary mb-2">{headline}</p>
        <p className="text-xs text-text-secondary mb-5 leading-relaxed">{body}</p>

        <div className="flex flex-col gap-2">
          {showReconnect && (
            <a
              href={`/settings?reconnect=${platform}`}
              className="block w-full py-2.5 text-center text-sm font-semibold rounded-sm bg-lime text-base hover:bg-lime-dim transition-colors"
            >
              Reconnect {label}
            </a>
          )}
          {error.canRetry && (
            <button
              onClick={onRetry}
              className="block w-full py-2.5 text-center text-sm font-semibold rounded-sm bg-surface-hover text-text-secondary border border-border hover:text-text-primary transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
