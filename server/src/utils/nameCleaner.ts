/**
 * Common chain name variations mapped to canonical forms.
 * Applied after lowercasing + possessive removal to catch "mcdonald" (from "mcdonald's").
 */
const CHAIN_ALIASES: Record<string, string> = {
  'chipotle mexican grill': 'chipotle',
  'mcdonalds': 'mcdonalds',
  'mcdonalds restaurant': 'mcdonalds',
  'mcdonald': 'mcdonalds',
  'five guys burgers and fries': 'five guys',
  'five guys burgers & fries': 'five guys',
  'five guys burgers fries': 'five guys',
  'dunkin': 'dunkin',
  'dunkin donuts': 'dunkin',
  'popeyes louisiana kitchen': 'popeyes',
  'popeyes louisiana chicken': 'popeyes',
  'wingstop restaurant': 'wingstop',
  'taco bell cantina': 'taco bell',
  'burger king restaurant': 'burger king',
  'wendys restaurant': 'wendys',
  'wendy': 'wendys',
  'subway restaurant': 'subway',
  'subway restaurants': 'subway',
  'panda express restaurant': 'panda express',
  'chick fil a': 'chick fil a',
  'chickfila': 'chick fil a',
  'starbucks coffee': 'starbucks',
  'starbucks reserve': 'starbucks',
  'dominos pizza': 'dominos',
  'domino pizza': 'dominos',
  'papa johns pizza': 'papa johns',
  'papa john pizza': 'papa johns',
  'kfc restaurant': 'kfc',
  'kentucky fried chicken': 'kfc',
  'halal guys': 'halal guys',
  'the halal guys': 'halal guys',
  'sweetgreen': 'sweetgreen',
  'sweet green': 'sweetgreen',
  'panera bread': 'panera',
  'panera bread cafe': 'panera',
  'buffalo wild wings': 'buffalo wild wings',
  'bdubs': 'buffalo wild wings',
  'qdoba mexican eats': 'qdoba',
  'qdoba mexican grill': 'qdoba',
  '7eleven': '7 eleven',
  '7 eleven': '7 eleven',
};

/**
 * Normalize restaurant and item names for fuzzy matching.
 *
 * Rules:
 * - Lowercase
 * - Remove punctuation and possessive 's
 * - Chain alias normalization (common NYC chains)
 * - Remove common suffixes: location descriptors in parens, "- {location}", "NYC", "New York"
 * - Remove leading "The"
 * - Collapse whitespace
 */
export function cleanRestaurantName(name: string): string {
  let cleaned = name.toLowerCase();

  // Remove content in parentheses (location descriptors)
  cleaned = cleaned.replace(/\(.*?\)/g, '');

  // Remove "- Location" suffixes (require space before dash to avoid stripping hyphenated brand names like "7-Eleven")
  cleaned = cleaned.replace(/\s+-\s+[^-]+$/, '');

  // Remove possessive 's
  cleaned = cleaned.replace(/'s\b/g, '');

  // Remove punctuation (before chain alias check so "five guys burgers & fries" becomes "five guys burgers  fries")
  cleaned = cleaned.replace(/[^\w\s]/g, '');

  // Collapse whitespace (needed before chain alias lookup)
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Chain alias normalization — check full cleaned name first, then try without trailing words
  if (CHAIN_ALIASES[cleaned]) {
    return CHAIN_ALIASES[cleaned];
  }
  // Also check if the name starts with a known chain (e.g., "chipotle mexican grill midtown" → "chipotle")
  for (const [alias, canonical] of Object.entries(CHAIN_ALIASES)) {
    if (cleaned.startsWith(alias + ' ') || cleaned === alias) {
      return canonical;
    }
  }

  // Remove common location words
  cleaned = cleaned.replace(/\b(nyc|new york|manhattan|brooklyn|queens|bronx|staten island)\b/gi, '');

  // Remove leading "the"
  cleaned = cleaned.replace(/^the\s+/, '');

  // Collapse whitespace again after removals
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Clean menu item names for cross-platform matching.
 * Less aggressive than restaurant name cleaning.
 */
export function cleanItemName(name: string): string {
  let cleaned = name.toLowerCase();

  // Remove size descriptors in parens like "(Large)", "(16 oz)"
  cleaned = cleaned.replace(/\(.*?\)/g, '');

  // Remove possessive 's
  cleaned = cleaned.replace(/'s\b/g, '');

  // Remove punctuation
  cleaned = cleaned.replace(/[^\w\s]/g, '');

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
