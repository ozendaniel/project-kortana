export interface UnifiedMenuItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  platforms: Record<string, { itemId: string; priceCents: number; available: boolean }>;
}

export interface MenuCategory {
  category: string;
  items: UnifiedMenuItem[];
}

const SKIP_CATEGORIES = new Set(['Most Ordered', 'Popular Items', 'Featured']);

/**
 * Union-Find grouping of matched items across platforms.
 * Returns a map of root ID -> array of member rows.
 */
export function groupMatchedItems(rows: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  for (const row of rows) {
    const id = row.id as string;
    const matchedId = row.matched_item_id as string | null;
    find(id);
    if (matchedId) union(id, matchedId);
  }

  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const root = find(row.id as string);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(row);
  }
  return groups;
}

/**
 * Merge grouped rows into UnifiedMenuItems, applying ghost filtering.
 * When both platforms are present, Seamless-only items (no DD match) are hidden.
 */
export function mergeMatchedItems(
  rows: Array<Record<string, unknown>>,
  options?: { skipGhostFilter?: boolean }
): UnifiedMenuItem[] {
  const groups = groupMatchedItems(rows);

  const platformsPresent = new Set(rows.map(r => r.platform as string));
  const hasBothPlatforms = platformsPresent.has('doordash') && platformsPresent.has('seamless');

  const items: UnifiedMenuItem[] = [];

  for (const [root, members] of groups) {
    const representative = members.find(r => !SKIP_CATEGORIES.has(r.category as string)) || members[0];

    const unified: UnifiedMenuItem = {
      id: root,
      name: representative.original_name as string,
      description: representative.description as string | undefined,
      category: representative.category as string,
      platforms: {},
    };

    for (const row of members) {
      const platform = row.platform as string;
      if (!unified.platforms[platform] || SKIP_CATEGORIES.has(row.category as string) === false) {
        unified.platforms[platform] = {
          itemId: row.platform_item_id as string,
          priceCents: row.price_cents as number,
          available: row.available as boolean,
        };
      }
    }

    // Ghost filter: hide SL-only items when both platforms present
    if (!options?.skipGhostFilter && hasBothPlatforms && !unified.platforms.doordash && unified.platforms.seamless) {
      continue;
    }

    items.push(unified);
  }

  return items;
}

/**
 * Build a categorized menu from raw DB rows.
 */
export function buildUnifiedMenu(rows: Array<Record<string, unknown>>): MenuCategory[] {
  const items = mergeMatchedItems(rows);

  const categoryMap = new Map<string, UnifiedMenuItem[]>();
  for (const item of items) {
    const cat = item.category || 'Other';
    if (SKIP_CATEGORIES.has(cat)) continue;
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(item);
  }

  return Array.from(categoryMap.entries()).map(([category, items]) => ({
    category,
    items,
  }));
}
