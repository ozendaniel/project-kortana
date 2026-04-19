import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  compareOrder,
  preflightCompare,
  refreshFeeCache,
  type ComparisonResult,
  type PlatformComparison,
  type PreflightAddress,
  type PreflightResponse,
} from '../api/client';
import { useCartStore } from '../stores/cartStore';
import ComparisonCard from './ComparisonCard';
import ComparisonErrorCard from './ComparisonErrorCard';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Rough great-circle distance (meters) for lat/lng comparisons.
function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DD_MATCH_RADIUS_METERS = 500;

/**
 * Deterministic signature over the inputs that must all match for two compare
 * results to be mergeable. Changing the cart (items, qty, modifiers) or the
 * address produces a different key.
 *
 * Both the normalized address string AND the lat/lng are included because
 * each independently affects the fees:
 *   - Address string: distinct apts in the same building share coords but are
 *     user-distinct deliveries → must NOT collide.
 *   - Coords: DD's `setDeliveryAddress` picks the nearest saved account
 *     address by lat/lng, and SL sends lat/lng in `delivery_info`. Same
 *     string can geocode to different coords (re-geocode drift, duplicate
 *     street names across cities) → must NOT collide.
 * Coords are rounded to 6 decimals (~11cm) to avoid float-equality noise.
 */
function makeCompareKey(
  restaurantId: string | null,
  items: Array<{ itemId: string; quantity: number; modifierSelections?: Array<{ groupId: string; optionIds: string[] }> }>,
  address: { lat: number; lng: number; address: string } | null
): string {
  if (!restaurantId || !address) return '';
  const normItems = [...items]
    .map((i) => ({
      id: i.itemId,
      q: i.quantity,
      m: (i.modifierSelections || [])
        .map((s) => ({ g: s.groupId, o: [...s.optionIds].sort() }))
        .sort((a, b) => a.g.localeCompare(b.g)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const normAddress = address.address.trim().replace(/\s+/g, ' ').toLowerCase();
  const lat = Math.round(address.lat * 1_000_000) / 1_000_000;
  const lng = Math.round(address.lng * 1_000_000) / 1_000_000;
  return `${restaurantId}|${normAddress}|${lat},${lng}|${JSON.stringify(normItems)}`;
}

export default function ComparisonView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { restaurantId, restaurantName, items, deliveryAddress, setDeliveryAddress } = useCartStore();

  const [confirmed, setConfirmed] = useState(false);

  const compareKey = useMemo(
    () => makeCompareKey(restaurantId, items, deliveryAddress),
    [restaurantId, items, deliveryAddress]
  );
  const compareKeyRef = useRef(compareKey);
  compareKeyRef.current = compareKey;

  // Reset the confirm gate whenever the cart or address changes so the user
  // must explicitly confirm the new inputs before we hit the live adapters.
  useEffect(() => {
    setConfirmed(false);
  }, [compareKey]);

  const preflight = useQuery({
    queryKey: ['preflight', restaurantId],
    queryFn: () => preflightCompare(restaurantId!),
    enabled: !!restaurantId,
    staleTime: 60 * 1000,
  });

  const compareMutation = useMutation({
    mutationFn: async (opts: { forceRefresh?: boolean; onlyPlatforms?: Array<'doordash' | 'seamless'>; expectKey: string }) => {
      const result = await compareOrder(
        restaurantId!,
        deliveryAddress!,
        items.map((i) => ({
          itemId: i.itemId,
          quantity: i.quantity,
          modifierSelections: i.modifierSelections,
        })),
        { forceRefresh: opts.forceRefresh, onlyPlatforms: opts.onlyPlatforms }
      );
      return { result, requestKey: opts.expectKey };
    },
    onSuccess: ({ result, requestKey }) => {
      // Guard: if the user changed the cart or address while this mutation was
      // in flight, `compareKeyRef.current` no longer matches `requestKey`. Drop
      // the response — it was for a now-stale input set.
      if (requestKey !== compareKeyRef.current) {
        console.log('[Compare] Discarding response for stale key (cart/address changed mid-flight)');
        return;
      }

      queryClient.setQueryData<ComparisonResult>(['compare', requestKey], (prev) => {
        if (!prev) return result;
        const merged: ComparisonResult = { ...prev };
        if (result.doordash) merged.doordash = result.doordash;
        if (result.seamless) merged.seamless = result.seamless;
        const oks: Array<{ platform: string; total: number }> = [];
        if (merged.doordash?.kind === 'ok' && merged.doordash.available && merged.doordash.totalCents > 0) {
          oks.push({ platform: 'doordash', total: merged.doordash.totalCents });
        }
        if (merged.seamless?.kind === 'ok' && merged.seamless.available && merged.seamless.totalCents > 0) {
          oks.push({ platform: 'seamless', total: merged.seamless.totalCents });
        }
        oks.sort((a, b) => a.total - b.total);
        merged.cheapest = oks[0]?.platform ?? null;
        merged.savingsCents = oks.length > 1 && oks[0] && oks[1] ? oks[1].total - oks[0].total : 0;
        return merged;
      });
    },
  });

  // Read comparison for the CURRENT input signature only. Prior signatures'
  // entries still exist in the QueryClient cache but are not rendered — React
  // Query GC will clean them up.
  const comparison = queryClient.getQueryData<ComparisonResult>(['compare', compareKey]);

  const ddStatus = preflight.data?.platforms?.doordash;
  const slStatus = preflight.data?.platforms?.seamless;
  const ddAddresses: PreflightAddress[] = ddStatus?.accountAddresses || [];
  const ddClosest = useMemo(() => findClosestAccountAddress(ddAddresses, deliveryAddress), [ddAddresses, deliveryAddress]);

  const ddAddressMismatch =
    ddStatus?.ready &&
    deliveryAddress &&
    ddAddresses.length > 0 &&
    (!ddClosest || metersBetween(deliveryAddress, ddClosest) > DD_MATCH_RADIUS_METERS);

  const runCompare = async (opts?: { forceRefresh?: boolean; onlyPlatforms?: Array<'doordash' | 'seamless'> }) => {
    if (!compareKey) return;
    if (opts?.forceRefresh) {
      await refreshFeeCache(restaurantId || undefined);
    }
    compareMutation.mutate({ ...(opts || {}), expectKey: compareKey });
  };

  const handleConfirm = () => {
    setConfirmed(true);
    runCompare();
  };

  const handleUseDdAddress = (addr: PreflightAddress) => {
    // Address change → compareKey flips. The useEffect resets `confirmed` and
    // the old query-cache entry becomes unreachable. No manual removal needed.
    setDeliveryAddress({ lat: addr.lat, lng: addr.lng, address: addr.address });
  };

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

      <AddressConfirmBlock
        deliveryAddress={deliveryAddress}
        ddAddresses={ddAddresses}
        ddAddressMismatch={!!ddAddressMismatch}
        preflight={preflight.data}
        preflightLoading={preflight.isLoading}
        onUseDdAddress={handleUseDdAddress}
        onConfirm={handleConfirm}
        onEdit={() => navigate('/')}
        onRefresh={() => runCompare({ forceRefresh: true })}
        confirmed={confirmed}
        canCompare={!!deliveryAddress && (ddStatus?.ready || slStatus?.ready) === true}
        isComparing={compareMutation.isPending}
      />

      {confirmed && compareMutation.isPending && !comparison && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="skeleton h-72 rounded-sm" />
          <div className="skeleton h-72 rounded-sm" style={{ animationDelay: '100ms' }} />
        </div>
      )}

      {compareMutation.isError && !comparison && (
        <p className="text-coral text-sm font-mono">Error comparing prices. Try again.</p>
      )}

      {comparison && (
        <>
          {comparison.savingsCents > 0 && comparison.cheapest && (
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
            {(['doordash', 'seamless'] as const).map((platform) => {
              const result = comparison[platform];
              if (!result) return null;
              if (result.kind === 'error') {
                return (
                  <ComparisonErrorCard
                    key={platform}
                    platform={platform}
                    error={result}
                    onRetry={() => runCompare({ forceRefresh: true, onlyPlatforms: [platform] })}
                  />
                );
              }
              return (
                <ComparisonCard
                  key={platform}
                  platform={platform}
                  comparison={result as PlatformComparison}
                  isCheapest={comparison.cheapest === platform}
                  savings={comparison.cheapest === platform ? comparison.savingsCents : undefined}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function findClosestAccountAddress(
  addrs: PreflightAddress[],
  target: { lat: number; lng: number } | null
): PreflightAddress | null {
  if (!target || addrs.length === 0) return null;
  let best: PreflightAddress = addrs[0]!;
  let bestDist = metersBetween(target, best);
  for (let i = 1; i < addrs.length; i++) {
    const a = addrs[i]!;
    const d = metersBetween(target, a);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

interface AddressConfirmBlockProps {
  deliveryAddress: { lat: number; lng: number; address: string } | null;
  ddAddresses: PreflightAddress[];
  ddAddressMismatch: boolean;
  preflight: PreflightResponse | undefined;
  preflightLoading: boolean;
  onUseDdAddress: (addr: PreflightAddress) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  confirmed: boolean;
  canCompare: boolean;
  isComparing: boolean;
}

function AddressConfirmBlock({
  deliveryAddress,
  ddAddresses,
  ddAddressMismatch,
  preflight,
  preflightLoading,
  onUseDdAddress,
  onConfirm,
  onEdit,
  onRefresh,
  confirmed,
  canCompare,
  isComparing,
}: AddressConfirmBlockProps) {
  const dd = preflight?.platforms?.doordash;
  const sl = preflight?.platforms?.seamless;

  return (
    <div className="bg-surface border border-border-subtle rounded-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono text-text-muted tracking-widest uppercase mb-1">
            Delivery address
          </p>
          <p className="text-sm text-text-primary break-words">
            {deliveryAddress?.address || <span className="text-text-muted italic">No address set</span>}
          </p>
        </div>
        <button
          onClick={onEdit}
          className="text-xs font-mono text-lime hover:text-lime-dim transition-colors whitespace-nowrap"
        >
          Change
        </button>
      </div>

      {preflightLoading && (
        <p className="text-[11px] font-mono text-text-muted">Checking platform connections…</p>
      )}

      {dd && !dd.ready && (
        <PlatformBanner
          platform="DoorDash"
          tone="warn"
          reason={dd.reason}
        />
      )}
      {sl && !sl.ready && (
        <PlatformBanner
          platform="Seamless"
          tone="warn"
          reason={sl.reason}
        />
      )}

      {ddAddressMismatch && ddAddresses.length > 0 && (
        <div className="bg-amber-bg border border-amber-accent/20 rounded-sm p-3">
          <p className="text-xs text-amber-accent font-mono mb-2">
            DoorDash account has no saved address near this location — live DD fees will use the nearest saved address below.
          </p>
          <div className="flex flex-col gap-1.5">
            {ddAddresses.map((a) => (
              <button
                key={a.id}
                onClick={() => onUseDdAddress(a)}
                className="text-left text-xs text-text-secondary hover:text-text-primary transition-colors font-mono truncate"
              >
                &rarr; Use "{a.address}"
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        {!confirmed ? (
          <button
            onClick={onConfirm}
            disabled={!canCompare || isComparing}
            className="flex-1 py-2.5 text-center text-sm font-semibold rounded-sm bg-lime text-base hover:bg-lime-dim transition-colors disabled:bg-surface-hover disabled:text-text-muted disabled:cursor-not-allowed"
          >
            {canCompare ? 'Confirm & compare' : 'Address & accounts required'}
          </button>
        ) : (
          <button
            onClick={onRefresh}
            disabled={isComparing}
            className="flex-1 py-2.5 text-center text-sm font-semibold rounded-sm bg-surface-hover text-text-secondary border border-border hover:text-text-primary transition-colors disabled:opacity-50"
          >
            {isComparing ? 'Refreshing…' : 'Refresh live fees'}
          </button>
        )}
      </div>
    </div>
  );
}

function PlatformBanner({ platform, tone, reason }: { platform: string; tone: 'warn'; reason?: string }) {
  const message =
    reason === 'session_expired'
      ? `${platform} session expired.`
      : reason === 'adapter_unavailable'
      ? `${platform} is offline — try again in a moment.`
      : `${platform} is not ready.`;
  const showReconnect = reason === 'session_expired';
  const pLower = platform.toLowerCase();
  return (
    <div className={tone === 'warn' ? 'bg-amber-bg border border-amber-accent/20 rounded-sm p-3 flex items-center justify-between gap-3' : ''}>
      <p className="text-xs text-amber-accent font-mono">{message}</p>
      {showReconnect && (
        <a
          href={`/settings?reconnect=${pLower}`}
          className="text-xs font-mono text-lime hover:text-lime-dim transition-colors whitespace-nowrap"
        >
          Reconnect &rarr;
        </a>
      )}
    </div>
  );
}
