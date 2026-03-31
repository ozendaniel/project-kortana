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
  totalCents: number;
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
 */
export async function compareOrder(
  restaurantId: string,
  items: CartItem[],
  deliveryAddress: { lat: number; lng: number; address: string },
  adapters: Map<string, PlatformAdapter>
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

  // 2. For each platform where this restaurant exists
  for (const [platform, adapter] of adapters) {
    const platformId = rest[`${platform}_id`];
    if (!platformId) continue;

    try {
      // Map cart items to platform-specific item IDs
      const platformItems = await mapItemsToPlatform(items, restaurantId, platform);
      const missingItems = platformItems.filter((i) => !i.platformItemId);

      if (platformItems.every((i) => !i.platformItemId)) {
        // No items available on this platform
        continue;
      }

      const availableItems = platformItems.filter((i) => i.platformItemId);

      // Fetch real-time fees
      const fees = await adapter.getFees({
        platformRestaurantId: platformId,
        items: availableItems.map((i) => ({
          platformItemId: i.platformItemId!,
          quantity: i.quantity,
        })),
        deliveryAddress,
      });

      const comparison: PlatformComparison = {
        available: missingItems.length === 0,
        itemSubtotalCents: fees.subtotalCents,
        deliveryFeeCents: fees.deliveryFeeCents,
        serviceFeeCents: fees.serviceFeeCents,
        smallOrderFeeCents: fees.smallOrderFeeCents,
        totalCents: fees.totalCents,
        estimatedDeliveryTime: fees.estimatedDeliveryTime,
        missingItems: missingItems.map((i) => i.name),
        orderUrl: rest[`${platform}_url`] || '',
      };

      result[platform] = comparison;
      totals.push({ platform, total: fees.totalCents });
    } catch (err) {
      console.error(`[Compare] Error fetching fees from ${platform}:`, err);
    }
  }

  // 3. Determine cheapest
  if (totals.length > 0) {
    totals.sort((a, b) => a.total - b.total);
    result.cheapest = totals[0].platform;
    result.savingsCents = totals.length > 1 ? totals[1].total - totals[0].total : 0;
  }

  return result;
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
