import { db } from '../db/client.js';
import type { PlatformAdapter, PlatformFees } from '../adapters/types.js';

interface CartItem {
  itemId: string;  // canonical menu_item id
  quantity: number;
}

interface PlatformComparison {
  available: boolean;
  itemSubtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  taxCents: number;
  discountCents: number;
  tipCents: number;            // optional 5% tip estimate
  totalCents: number;          // total before tip
  totalWithTipCents: number;   // total including optional tip
  estimatedDeliveryTime?: string;
  missingItems: string[];
  orderUrl: string;
}

interface ComparisonResult {
  [platform: string]: PlatformComparison | string | number | null | undefined;
  cheapest: string | null;
  savingsCents: number;
}

/**
 * Compare prices across platforms for a given cart at a restaurant.
 * Uses live adapters when available, falls back to DB-based price calculation.
 */
export async function compareOrder(
  restaurantId: string,
  items: CartItem[],
  deliveryAddress: { lat: number; lng: number; address: string },
  adapters?: Map<string, PlatformAdapter>
): Promise<ComparisonResult> {
  // 1. Get restaurant with platform IDs
  const restaurant = await db.query(
    'SELECT * FROM restaurants WHERE id = $1',
    [restaurantId]
  );

  if (restaurant.rows.length === 0) {
    throw new Error(`Restaurant ${restaurantId} not found`);
  }

  const rest = restaurant.rows[0];
  const result: ComparisonResult = { cheapest: null, savingsCents: 0 };
  const totals: Array<{ platform: string; total: number }> = [];

  // Determine which platforms have this restaurant
  const platforms: string[] = [];
  if (rest.doordash_id) platforms.push('doordash');
  if (rest.seamless_id) platforms.push('seamless');
  if (rest.ubereats_id) platforms.push('ubereats');

  // Fetch all platforms in parallel for speed
  const platformPromises = platforms.map(async (platform) => {
    const adapter = adapters?.get(platform);

    try {
      let comparison: PlatformComparison;

      if (adapter) {
        try {
          comparison = await fetchLiveFees(adapter, rest, items, restaurantId, platform, deliveryAddress);
        } catch (liveErr) {
          console.error(`[Compare] Live ${platform} failed, falling back to DB:`, liveErr);
          comparison = await calculateFromDB(rest, items, restaurantId, platform);
        }
      } else {
        comparison = await calculateFromDB(rest, items, restaurantId, platform);
      }

      result[platform] = comparison;
      if (comparison.available && comparison.totalCents > 0) {
        totals.push({ platform, total: comparison.totalCents });
      }
    } catch (err) {
      console.error(`[Compare] Error for ${platform}:`, err);
    }
  });

  await Promise.all(platformPromises);

  // 3. Determine cheapest
  if (totals.length > 0) {
    totals.sort((a, b) => a.total - b.total);
    result.cheapest = totals[0].platform;
    result.savingsCents = totals.length > 1 ? totals[1].total - totals[0].total : 0;
  }

  return result;
}

/**
 * Fetch real-time fees from a live adapter (Playwright-based).
 */
async function fetchLiveFees(
  adapter: PlatformAdapter,
  rest: Record<string, any>,
  items: CartItem[],
  restaurantId: string,
  platform: string,
  deliveryAddress: { lat: number; lng: number; address: string }
): Promise<PlatformComparison> {
  const platformId = rest[`${platform}_id`];
  const platformItems = await mapItemsToPlatform(items, restaurantId, platform);
  const missingItems = platformItems.filter((i) => !i.platformItemId);
  const availableItems = platformItems.filter((i) => i.platformItemId);

  if (availableItems.length === 0) {
    return {
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

  const fees = await adapter.getFees({
    platformRestaurantId: platformId,
    items: availableItems.map((i) => ({
      platformItemId: i.platformItemId!,
      quantity: i.quantity,
    })),
    deliveryAddress,
  });

  const tipCents = Math.round(fees.subtotalCents * 0.05); // optional 5% tip

  return {
    available: missingItems.length === 0,
    itemSubtotalCents: fees.subtotalCents,
    deliveryFeeCents: fees.deliveryFeeCents,
    serviceFeeCents: fees.serviceFeeCents,
    smallOrderFeeCents: fees.smallOrderFeeCents,
    taxCents: fees.taxCents,
    discountCents: fees.discountCents,
    tipCents,
    totalCents: fees.totalCents,
    totalWithTipCents: fees.totalCents + tipCents,
    estimatedDeliveryTime: fees.estimatedDeliveryTime,
    missingItems: missingItems.map((i) => i.name),
    orderUrl: rest[`${platform}_url`] || '',
  };
}

/**
 * Calculate comparison from DB-seeded menu data + estimated fees.
 * Used in Phase 1 before live adapters are running.
 */
async function calculateFromDB(
  rest: Record<string, any>,
  items: CartItem[],
  restaurantId: string,
  platform: string
): Promise<PlatformComparison> {
  const platformItems = await mapItemsToPlatform(items, restaurantId, platform);
  const missingItems = platformItems.filter((i) => !i.platformItemId);
  const availableItems = platformItems.filter((i) => i.platformItemId);

  if (availableItems.length === 0) {
    return {
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

  // Calculate subtotal from DB prices
  let subtotalCents = 0;
  for (const item of availableItems) {
    const priceResult = await db.query(
      `SELECT price_cents FROM menu_items
       WHERE restaurant_id = $1 AND platform = $2 AND platform_item_id = $3
       LIMIT 1`,
      [restaurantId, platform, item.platformItemId]
    );
    if (priceResult.rows[0]) {
      subtotalCents += priceResult.rows[0].price_cents * item.quantity;
    }
  }

  // Estimate fees from captured data
  // DoorDash: $1.99 delivery + 15% service (from their fee disclosure)
  // Seamless: $1.99 delivery + ~22% service (from our captured bill data: $6.29 service on $28.60 subtotal)
  let deliveryFeeCents: number;
  let serviceFeeCents: number;
  let smallOrderFeeCents = 0;

  if (platform === 'doordash') {
    deliveryFeeCents = 199; // $1.99
    serviceFeeCents = Math.round(subtotalCents * 0.15); // 15% service
    if (subtotalCents < 1000) smallOrderFeeCents = 200; // $2 small order fee estimate
  } else {
    // Seamless
    deliveryFeeCents = 199; // $1.99
    serviceFeeCents = Math.round(subtotalCents * 0.22); // ~22% service
    if (subtotalCents < 1000) smallOrderFeeCents = 250; // $2.50 small order fee estimate
  }

  const taxCents = Math.round(subtotalCents * 0.08875); // NYC sales tax estimate
  const totalCents = subtotalCents + deliveryFeeCents + serviceFeeCents + smallOrderFeeCents + taxCents;
  const tipCents = Math.round(subtotalCents * 0.05); // optional 5% tip

  return {
    available: missingItems.length === 0,
    itemSubtotalCents: subtotalCents,
    deliveryFeeCents,
    serviceFeeCents,
    smallOrderFeeCents,
    taxCents,
    discountCents: 0,
    tipCents,
    totalCents,
    totalWithTipCents: totalCents + tipCents,
    missingItems: missingItems.map((i) => i.name),
    orderUrl: rest[`${platform}_url`] || '',
  };
}

async function mapItemsToPlatform(
  items: CartItem[],
  restaurantId: string,
  platform: string
): Promise<Array<{ itemId: string; name: string; platformItemId: string | null; quantity: number }>> {
  const mapped = [];

  for (const item of items) {
    // Look up the canonical item and find its platform-specific counterpart
    const result = await db.query(
      `SELECT mi.platform_item_id, mi.original_name
       FROM menu_items mi
       WHERE mi.restaurant_id = $1
         AND mi.platform = $2
         AND (mi.id = $3 OR mi.matched_item_id = $3)
       LIMIT 1`,
      [restaurantId, platform, item.itemId]
    );

    mapped.push({
      itemId: item.itemId,
      name: result.rows[0]?.original_name || 'Unknown item',
      platformItemId: result.rows[0]?.platform_item_id || null,
      quantity: item.quantity,
    });
  }

  return mapped;
}
