import { db } from '../db/client.js';
import { cleanItemName } from '../utils/nameCleaner.js';
import type { PlatformMenu } from '../adapters/types.js';

const BATCH_SIZE = 15;

/**
 * Upsert a menu and its items into the database.
 * - Upserts the `menus` row (ON CONFLICT by restaurant_id + platform)
 * - Deletes old menu_items for that menu
 * - Batch-inserts new items
 *
 * Returns the number of items inserted.
 */
export async function upsertMenu(
  restaurantId: string,
  platform: string,
  menu: PlatformMenu
): Promise<number> {
  const menuResult = await db.query(
    `INSERT INTO menus (restaurant_id, platform, raw_data, fetched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (restaurant_id, platform)
     DO UPDATE SET raw_data = $3, fetched_at = NOW()
     RETURNING id`,
    [restaurantId, platform, JSON.stringify(menu)]
  );

  const menuId = menuResult.rows[0].id;

  // Clear old items
  await db.query('DELETE FROM menu_items WHERE menu_id = $1', [menuId]);

  // Flatten all items with their category
  const allItems: Array<{
    name: string;
    description: string | null;
    priceCents: number;
    category: string;
    platformItemId: string;
  }> = [];

  for (const category of menu.categories) {
    for (const item of category.items) {
      allItems.push({
        name: item.name,
        description: item.description || null,
        priceCents: item.priceCents,
        category: category.name,
        platformItemId: item.platformItemId,
      });
    }
  }

  // Batch insert
  for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
    const batch = allItems.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const offset = j * 10;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
      );
      values.push(
        menuId,
        restaurantId,
        platform,
        cleanItemName(item.name),
        item.name,
        item.description,
        item.priceCents,
        item.category,
        item.platformItemId,
        null // modifiers
      );
    }

    await db.query(
      `INSERT INTO menu_items
       (menu_id, restaurant_id, platform, canonical_name, original_name, description, price_cents, category, platform_item_id, modifiers)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  return allItems.length;
}
