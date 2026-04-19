import crypto from 'crypto';
import { db } from '../db/client.js';
import type { PlatformAdapter, PlatformFees, LiveFeeErrorReason, Platform } from '../adapters/types.js';
import { LiveFeeError } from '../adapters/types.js';

interface CartItem {
  itemId: string;
  quantity: number;
  modifierSelections?: Array<{ groupId: string; optionIds: string[] }>;
}

export interface PlatformComparison {
  kind: 'ok';
  available: boolean;
  itemSubtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  taxCents: number;
  discountCents: number;
  tipCents: number;
  totalCents: number;
  totalWithTipCents: number;
  estimatedDeliveryTime?: string;
  missingItems: string[];
  orderUrl: string;
}

export interface PlatformError {
  kind: 'error';
  reason: LiveFeeErrorReason;
  message: string;
  canRetry: boolean;
  orderUrl: string;
}

export type PlatformResult = PlatformComparison | PlatformError;

export interface ComparisonResult {
  doordash?: PlatformResult;
  seamless?: PlatformResult;
  ubereats?: PlatformResult;
  cheapest: string | null;
  savingsCents: number;
}

const FEE_CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { fees: PlatformFees; expiresAt: number };
const feeCache = new Map<string, CacheEntry>();

function cacheKey(platform: string, restaurantId: string, items: CartItem[], address: { lat: number; lng: number; address: string }): string {
  const normalizedItems = [...items]
    .map((i) => ({
      itemId: i.itemId,
      quantity: i.quantity,
      mods: (i.modifierSelections || [])
        .map((s) => ({ g: s.groupId, o: [...s.optionIds].sort() }))
        .sort((a, b) => a.g.localeCompare(b.g)),
    }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  const itemsHash = crypto.createHash('sha1').update(JSON.stringify(normalizedItems)).digest('hex').substring(0, 12);
  // Key on BOTH the normalized address string AND the lat/lng. Each matters
  // independently for fees:
  //   - String: distinct apts in the same building share coords but are
  //     distinct deliveries → must NOT collide.
  //   - Coords: DD.setDeliveryAddress picks the nearest saved account address
  //     by lat/lng; SL delivery_info takes lat/lng. Same string can geocode to
  //     different coords (re-geocode drift, duplicate street names) → must NOT
  //     collide either.
  // Coords rounded to 6 decimals (~11cm) to avoid float-equality noise.
  const normAddress = address.address.trim().replace(/\s+/g, ' ').toLowerCase();
  const lat = Math.round(address.lat * 1_000_000) / 1_000_000;
  const lng = Math.round(address.lng * 1_000_000) / 1_000_000;
  const addressHash = crypto
    .createHash('sha1')
    .update(`${normAddress}|${lat},${lng}`)
    .digest('hex')
    .substring(0, 12);
  return `${platform}|${restaurantId}|${itemsHash}|${addressHash}`;
}

function getCachedFees(key: string): PlatformFees | null {
  const entry = feeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    feeCache.delete(key);
    return null;
  }
  return entry.fees;
}

function setCachedFees(key: string, fees: PlatformFees): void {
  feeCache.set(key, { fees, expiresAt: Date.now() + FEE_CACHE_TTL_MS });
}

export function clearFeeCache(restaurantId?: string): void {
  if (!restaurantId) {
    feeCache.clear();
    return;
  }
  for (const k of feeCache.keys()) {
    if (k.includes(`|${restaurantId}|`)) feeCache.delete(k);
  }
}

export async function compareOrder(
  restaurantId: string,
  items: CartItem[],
  deliveryAddress: { lat: number; lng: number; address: string },
  adapters?: Map<string, PlatformAdapter>,
  options?: { forceRefresh?: boolean; onlyPlatforms?: Platform[] }
): Promise<ComparisonResult> {
  const restaurant = await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
  if (restaurant.rows.length === 0) throw new Error(`Restaurant ${restaurantId} not found`);
  const rest = restaurant.rows[0];

  const result: ComparisonResult = { cheapest: null, savingsCents: 0 };
  const totals: Array<{ platform: string; total: number }> = [];

  const allPlatforms: Platform[] = [];
  if (rest.doordash_id) allPlatforms.push('doordash');
  if (rest.seamless_id) allPlatforms.push('seamless');
  if (rest.ubereats_id) allPlatforms.push('ubereats');
  const platforms = options?.onlyPlatforms ? allPlatforms.filter((p) => options.onlyPlatforms!.includes(p)) : allPlatforms;

  const platformPromises = platforms.map(async (platform) => {
    const adapter = adapters?.get(platform);
    const orderUrl = rest[`${platform}_url`] || '';

    if (!adapter) {
      result[platform] = {
        kind: 'error',
        reason: 'adapter_unavailable',
        message: `${platform} adapter is not running. The server may be restarting or a menu populate is in progress.`,
        canRetry: true,
        orderUrl,
      };
      return;
    }

    try {
      const comparison = await fetchLiveFees(
        adapter,
        rest,
        items,
        restaurantId,
        platform,
        deliveryAddress,
        options?.forceRefresh ?? false
      );
      result[platform] = comparison;
      if (comparison.available && comparison.totalCents > 0) {
        totals.push({ platform, total: comparison.totalCents });
      }
    } catch (err) {
      if (err instanceof LiveFeeError) {
        result[platform] = {
          kind: 'error',
          reason: err.reason,
          message: err.message,
          canRetry: err.canRetry,
          orderUrl,
        };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Compare] Unexpected error for ${platform}:`, err);
        result[platform] = {
          kind: 'error',
          reason: 'unknown',
          message: msg.substring(0, 200),
          canRetry: true,
          orderUrl,
        };
      }
    }
  });

  await Promise.all(platformPromises);

  if (totals.length > 0) {
    totals.sort((a, b) => a.total - b.total);
    result.cheapest = totals[0].platform;
    result.savingsCents = totals.length > 1 ? totals[1].total - totals[0].total : 0;
  }

  return result;
}

async function fetchLiveFees(
  adapter: PlatformAdapter,
  rest: Record<string, any>,
  items: CartItem[],
  restaurantId: string,
  platform: string,
  deliveryAddress: { lat: number; lng: number; address: string },
  forceRefresh: boolean
): Promise<PlatformComparison> {
  const platformId = rest[`${platform}_id`];
  const platformItems = await mapItemsToPlatform(items, restaurantId, platform);
  const missingItems = platformItems.filter((i) => !i.platformItemId);
  const availableItems = platformItems.filter((i) => i.platformItemId);

  if (availableItems.length === 0) {
    return {
      kind: 'ok',
      available: false,
      itemSubtotalCents: 0,
      deliveryFeeCents: 0,
      serviceFeeCents: 0,
      smallOrderFeeCents: 0,
      taxCents: 0,
      discountCents: 0,
      tipCents: 0,
      totalCents: 0,
      totalWithTipCents: 0,
      missingItems: missingItems.map((i) => i.name),
      orderUrl: rest[`${platform}_url`] || '',
    };
  }

  const key = cacheKey(platform, restaurantId, items, deliveryAddress);
  let fees: PlatformFees | null = forceRefresh ? null : getCachedFees(key);
  if (fees) {
    console.log(`[Compare] ${platform} cache hit`);
  } else {
    fees = await adapter.getFees({
      platformRestaurantId: platformId,
      items: availableItems.map((i) => ({
        platformItemId: i.platformItemId!,
        quantity: i.quantity,
        name: i.name,
        description: i.description || undefined,
        unitPriceCents: i.unitPriceCents,
        menuPlatformId: i.menuPlatformId || undefined,
        modifierGroups: i.modifierGroups || undefined,
        modifierSelections: i.modifierSelections,
      })),
      deliveryAddress,
    });
    setCachedFees(key, fees);
  }

  let modifierDeltaCents = 0;
  for (const item of availableItems) {
    const hasUserSelections = item.modifierSelections && item.modifierSelections.length > 0;
    const platformHasNoMods = !item.modifierGroups || (Array.isArray(item.modifierGroups) && item.modifierGroups.length === 0);
    if (hasUserSelections && platformHasNoMods) {
      const ddResult = await db.query(
        `SELECT mi.modifier_groups FROM menu_items mi
         WHERE mi.restaurant_id = $1 AND mi.platform = 'doordash'
           AND (mi.id = $2 OR mi.matched_item_id = $2)
           AND mi.modifier_groups IS NOT NULL AND jsonb_array_length(mi.modifier_groups) > 0
         LIMIT 1`,
        [restaurantId, item.itemId]
      );
      const ddGroups = ddResult.rows[0]?.modifier_groups;
      if (ddGroups && Array.isArray(ddGroups)) {
        for (const sel of item.modifierSelections!) {
          const group = ddGroups.find((g: any) => g.id === sel.groupId);
          if (!group) continue;
          for (const optId of sel.optionIds) {
            const opt = group.options?.find((o: any) => o.id === optId);
            if (opt?.priceDeltaCents) modifierDeltaCents += opt.priceDeltaCents * item.quantity;
          }
        }
      }
    }
  }
  const adjusted: PlatformFees = { ...fees };
  if (modifierDeltaCents > 0) {
    const servicePct = adjusted.subtotalCents > 0 ? adjusted.serviceFeeCents / adjusted.subtotalCents : 0.15;
    adjusted.subtotalCents += modifierDeltaCents;
    adjusted.serviceFeeCents = Math.round(adjusted.subtotalCents * servicePct);
    adjusted.totalCents =
      adjusted.subtotalCents +
      adjusted.deliveryFeeCents +
      adjusted.serviceFeeCents +
      adjusted.smallOrderFeeCents +
      adjusted.taxCents -
      adjusted.discountCents;
    console.log(`[Compare] Applied modifier price delta: +${modifierDeltaCents}c to ${platform} subtotal`);
  }

  const tipCents = Math.round(adjusted.subtotalCents * 0.05);

  return {
    kind: 'ok',
    available: missingItems.length === 0,
    itemSubtotalCents: adjusted.subtotalCents,
    deliveryFeeCents: adjusted.deliveryFeeCents,
    serviceFeeCents: adjusted.serviceFeeCents,
    smallOrderFeeCents: adjusted.smallOrderFeeCents,
    taxCents: adjusted.taxCents,
    discountCents: adjusted.discountCents,
    tipCents,
    totalCents: adjusted.totalCents,
    totalWithTipCents: adjusted.totalCents + tipCents,
    estimatedDeliveryTime: adjusted.estimatedDeliveryTime,
    missingItems: missingItems.map((i) => i.name),
    orderUrl: rest[`${platform}_url`] || '',
  };
}

interface MappedItem {
  itemId: string;
  name: string;
  description: string | null;
  platformItemId: string | null;
  unitPriceCents: number;
  menuPlatformId: string | null;
  modifierGroups: import('./modifiers.js').ModifierGroup[] | null;
  quantity: number;
  modifierSelections?: import('./modifiers.js').ModifierSelection[];
}

async function mapItemsToPlatform(
  items: CartItem[],
  restaurantId: string,
  platform: string
): Promise<MappedItem[]> {
  const mapped: MappedItem[] = [];

  for (const item of items) {
    const result = await db.query(
      `SELECT mi.platform_item_id, mi.original_name, mi.description,
              mi.price_cents, mi.menu_platform_id, mi.modifier_groups
       FROM menu_items mi
       WHERE mi.restaurant_id = $1
         AND mi.platform = $2
         AND (mi.id = $3 OR mi.matched_item_id = $3)
       LIMIT 1`,
      [restaurantId, platform, item.itemId]
    );

    const row = result.rows[0];
    let selections = item.modifierSelections || [];

    if (platform === 'seamless' && selections.length > 0 && row?.modifier_groups) {
      const { translateModifierSelections } = await import('./modifiers.js');
      const ddResult = await db.query(
        `SELECT mi.modifier_groups FROM menu_items mi
         WHERE mi.restaurant_id = $1 AND mi.platform = 'doordash'
           AND (mi.id = $2 OR mi.matched_item_id = $2)
           AND mi.modifier_groups IS NOT NULL
         LIMIT 1`,
        [restaurantId, item.itemId]
      );
      const ddGroups = ddResult.rows[0]?.modifier_groups;
      if (ddGroups && Array.isArray(ddGroups)) {
        const translated = translateModifierSelections(ddGroups, row.modifier_groups, selections);
        if (translated.length > 0) selections = translated;
      }
    }

    mapped.push({
      itemId: item.itemId,
      name: row?.original_name || 'Unknown item',
      description: row?.description || null,
      platformItemId: row?.platform_item_id || null,
      unitPriceCents: row?.price_cents ?? 0,
      menuPlatformId: row?.menu_platform_id || null,
      modifierGroups: row?.modifier_groups || null,
      quantity: item.quantity,
      modifierSelections: selections,
    });
  }

  return mapped;
}
