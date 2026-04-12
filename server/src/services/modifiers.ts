/**
 * Normalized modifier group structure shared across platforms.
 *
 * Captured from the platforms' item-detail endpoints:
 *   - DoorDash: storepageFeed.quickAddContext.isEligible = false → call itemPage
 *               which returns optionLists[] with nested options
 *   - Seamless: /restaurants/{id}/menu_items/{item_id} returns choice_category_list
 *
 * The comparison engine uses these to build valid cart payloads for items
 * with required customizations (flavor, size, toppings, etc.). Without
 * populated modifier data, adding such items to a real cart fails with
 * "category minimum not met" / "invalid-categories" errors.
 */

export interface ModifierOption {
  /** Platform-specific option ID (passed back to the platform when ordering) */
  id: string;
  name: string;
  description?: string;
  /** Price delta in cents when this option is selected (0 for most required-group defaults) */
  priceDeltaCents: number;
  /** True if the platform marks this as the default choice (pre-selected in their UI) */
  isDefault: boolean;
  /** Default quantity the platform pre-populates (usually 0 or 1) */
  defaultQuantity: number;
  /** Nested child option groups (e.g. pizza toppings have "light/regular/extra" sub-options) */
  nestedGroups?: ModifierGroup[];
}

export interface ModifierGroup {
  /** Platform-specific option list ID */
  id: string;
  name: string;
  /** Minimum number of options the user must pick */
  minSelection: number;
  /** Maximum number of options the user may pick */
  maxSelection: number;
  /** "single_select" | "multi_select" — controls UI widget */
  selectionMode: 'single_select' | 'multi_select';
  /** False if user must choose at least one option (minSelection >= 1) */
  isOptional: boolean;
  options: ModifierOption[];
  /** Raw subtitle from the platform (e.g. "Select up to 4") — display-only */
  subtitle?: string;
}

/** A user's (or auto-chosen) modifier selection for one cart item. */
export interface ModifierSelection {
  groupId: string;
  /** Selected option IDs (1 entry for single_select, N for multi_select) */
  optionIds: string[];
}

// --- DoorDash extractors ---

/**
 * Parse a DoorDash itemPage response's optionLists[] into ModifierGroup[].
 * DoorDash's structure:
 *   selectionNode: "single_select" | "multi_select"
 *   minNumOptions / maxNumOptions — selection bounds
 *   isOptional — whether user must pick
 *   options[]: { id, name, unitAmount, defaultQuantity, nestedExtrasList }
 */
export function extractDoorDashModifiers(optionLists: any[] | undefined | null): ModifierGroup[] {
  if (!Array.isArray(optionLists)) return [];
  const groups: ModifierGroup[] = [];

  for (const ol of optionLists) {
    if (!ol || typeof ol !== 'object') continue;
    // Skip "Recommended Beverages"-style cross-sell carousels. These are type:"item"
    // (not "extra_option") and link to separate store items, not customization options.
    if (ol.type === 'item') continue;

    const options: ModifierOption[] = Array.isArray(ol.options) ? ol.options.map((opt: any) => ({
      id: String(opt.id ?? ''),
      name: String(opt.name ?? ''),
      description: opt.description || opt.name || undefined,
      priceDeltaCents: typeof opt.unitAmount === 'number' ? opt.unitAmount : 0,
      isDefault: (opt.defaultQuantity ?? 0) > 0,
      defaultQuantity: opt.defaultQuantity ?? 0,
      nestedGroups: Array.isArray(opt.nestedExtrasList) && opt.nestedExtrasList.length
        ? extractDoorDashModifiers(opt.nestedExtrasList)
        : undefined,
    })) : [];

    if (!options.length) continue;

    groups.push({
      id: String(ol.id ?? ''),
      name: String(ol.name ?? ''),
      minSelection: ol.minNumOptions ?? 0,
      maxSelection: ol.maxNumOptions ?? options.length,
      selectionMode: ol.selectionNode === 'single_select' ? 'single_select' : 'multi_select',
      isOptional: ol.isOptional === true || (ol.minNumOptions ?? 0) === 0,
      subtitle: ol.subtitle || undefined,
      options,
    });
  }

  return groups;
}

// --- Seamless extractors ---

/**
 * Parse a Seamless/Grubhub menu item's choice_category_list[] into ModifierGroup[].
 * Seamless structure:
 *   choice_category_list[]: { id, name, min_choice_options, max_choice_options,
 *     choice_option_list[]: { id, label, description, price.amount, defaulted,
 *       quantity_settings: { default_units, maximum_units },
 *       choice_category_list: [...] (nested) } }
 */
export function extractSeamlessModifiers(choiceCategoryList: any[] | undefined | null): ModifierGroup[] {
  if (!Array.isArray(choiceCategoryList)) return [];
  const groups: ModifierGroup[] = [];

  for (const cat of choiceCategoryList) {
    if (!cat || typeof cat !== 'object') continue;

    const min = cat.min_choice_options ?? 0;
    const max = cat.max_choice_options ?? 0;
    const options: ModifierOption[] = Array.isArray(cat.choice_option_list)
      ? cat.choice_option_list.map((opt: any) => ({
          id: String(opt.id ?? ''),
          name: String(opt.label || opt.description || ''),
          description: opt.description || opt.label || undefined,
          priceDeltaCents: opt.price?.amount ?? opt.delivery_price?.amount ?? 0,
          isDefault: opt.defaulted === true || (opt.quantity_settings?.default_units ?? 0) > 0,
          defaultQuantity: opt.quantity_settings?.default_units ?? 0,
          nestedGroups: Array.isArray(opt.choice_category_list) && opt.choice_category_list.length
            ? extractSeamlessModifiers(opt.choice_category_list)
            : undefined,
        }))
      : [];

    if (!options.length) continue;

    groups.push({
      id: String(cat.id ?? ''),
      name: String(cat.name ?? ''),
      minSelection: min,
      maxSelection: max || options.length,
      selectionMode: max === 1 ? 'single_select' : 'multi_select',
      isOptional: min === 0,
      options,
    });
  }

  return groups;
}

/**
 * Build Seamless cart line `options` array from modifier groups + selections.
 * Seamless expects: [{ choice_option_id: "<id>", quantity: 1 }]
 */
export function buildSeamlessOptions(
  selections: ModifierSelection[],
): Array<{ choice_option_id: string; quantity: number }> {
  const options: Array<{ choice_option_id: string; quantity: number }> = [];
  for (const sel of selections) {
    for (const optionId of sel.optionIds) {
      options.push({ choice_option_id: optionId, quantity: 1 });
    }
  }
  return options;
}

/**
 * Translate modifier selections from one platform's IDs to another's
 * by matching option names within groups of the same name.
 * Returns selections using the target platform's option IDs.
 *
 * Used when the user picks modifiers from the DD UI but we need to
 * pass them to SL's cart API (or vice versa).
 */
export function translateModifierSelections(
  sourceGroups: ModifierGroup[],
  targetGroups: ModifierGroup[],
  sourceSelections: ModifierSelection[],
): ModifierSelection[] {
  // Build lookup: source group name → target group
  const targetByName = new Map<string, ModifierGroup>();
  for (const g of targetGroups) {
    targetByName.set(g.name.toLowerCase().trim(), g);
  }

  const translated: ModifierSelection[] = [];

  for (const sel of sourceSelections) {
    // Find the source group to get the selected option names
    const sourceGroup = sourceGroups.find(g => g.id === sel.groupId);
    if (!sourceGroup) continue;

    // Find matching target group by name
    const targetGroup = targetByName.get(sourceGroup.name.toLowerCase().trim());
    if (!targetGroup) continue;

    // Translate each selected option by name matching
    const targetOptionIds: string[] = [];
    for (const srcOptId of sel.optionIds) {
      const srcOpt = sourceGroup.options.find(o => o.id === srcOptId);
      if (!srcOpt) continue;

      // Try exact name match first, then fuzzy
      const srcName = srcOpt.name.toLowerCase().trim();
      const targetOpt = targetGroup.options.find(o => o.name.toLowerCase().trim() === srcName)
        || targetGroup.options.find(o => o.name.toLowerCase().includes(srcName) || srcName.includes(o.name.toLowerCase()));

      if (targetOpt) {
        targetOptionIds.push(targetOpt.id);
      }
    }

    if (targetOptionIds.length > 0) {
      translated.push({ groupId: targetGroup.id, optionIds: targetOptionIds });
    }
  }

  return translated;
}

// --- Default-selection helpers ---

/**
 * Given a ModifierGroup[] and a (possibly-empty) list of user selections,
 * fill in defaults for any REQUIRED group that doesn't have a selection yet.
 * Returns a complete ModifierSelection[] suitable for building a cart payload.
 *
 * Default-picking rules:
 *   1. If the group has an option with isDefault=true, pick that.
 *   2. Otherwise, if min=1 and max=1 (required single-choice), pick the first option.
 *   3. Optional groups with no selection → leave out (empty selection is valid).
 */
export function fillDefaultSelections(
  groups: ModifierGroup[],
  userSelections: ModifierSelection[] = [],
): ModifierSelection[] {
  const byGroupId = new Map(userSelections.map(s => [s.groupId, s]));
  const result: ModifierSelection[] = [];

  for (const group of groups) {
    const user = byGroupId.get(group.id);
    if (user && user.optionIds.length > 0) {
      result.push(user);
      continue;
    }

    // Required group with no user selection — pick defaults
    if (!group.isOptional && group.minSelection > 0) {
      const defaults = group.options.filter(o => o.isDefault);
      if (defaults.length > 0) {
        result.push({
          groupId: group.id,
          optionIds: defaults.slice(0, group.maxSelection).map(o => o.id),
        });
      } else if (group.options.length > 0) {
        // No explicit default — pick the first option (matches how most platforms' UIs render)
        result.push({
          groupId: group.id,
          optionIds: [group.options[0].id],
        });
      }
    }
    // Optional groups with no selection → leave unselected (valid)
  }

  return result;
}

/**
 * Build DoorDash's `nestedOptions` JSON string from normalized modifier groups
 * + selections. This is the format accepted by the addCartItem mutation:
 *
 *   "[{\"id\":\"<opt_id>\",\"quantity\":1,\"options\":[],
 *       \"itemExtraOption\":{\"id\":\"<opt_id>\",\"name\":\"...\",\"description\":\"...\",
 *                            \"price\":<delta_cents>,\"chargeAbove\":0,\"defaultQuantity\":0}}]"
 *
 * The top-level array contains ONE entry per selected option across all groups
 * (not one entry per group). Sub-options live under each entry's "options" key.
 */
export function buildDoorDashNestedOptions(
  groups: ModifierGroup[],
  selections: ModifierSelection[],
): string {
  const optionById = new Map<string, { opt: ModifierOption; group: ModifierGroup }>();
  for (const group of groups) {
    for (const opt of group.options) optionById.set(opt.id, { opt, group });
  }

  const entries: any[] = [];
  for (const sel of selections) {
    for (const optionId of sel.optionIds) {
      const ref = optionById.get(optionId);
      if (!ref) continue;
      const { opt } = ref;
      entries.push({
        id: opt.id,
        quantity: 1,
        options: [], // nested option selections would go here if we ever support nested groups
        itemExtraOption: {
          id: opt.id,
          name: opt.name,
          description: opt.description || opt.name,
          price: opt.priceDeltaCents,
          chargeAbove: 0,
          defaultQuantity: opt.defaultQuantity || 0,
        },
      });
    }
  }

  return JSON.stringify(entries);
}
