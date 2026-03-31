/**
 * Normalize restaurant and item names for fuzzy matching.
 *
 * Rules:
 * - Lowercase
 * - Remove punctuation and possessive 's
 * - Remove common suffixes: location descriptors in parens, "- {location}", "NYC", "New York"
 * - Remove leading "The"
 * - Collapse whitespace
 */
export function cleanRestaurantName(name: string): string {
  let cleaned = name.toLowerCase();

  // Remove content in parentheses (location descriptors)
  cleaned = cleaned.replace(/\(.*?\)/g, '');

  // Remove "- Location" suffixes
  cleaned = cleaned.replace(/\s*-\s*[^-]+$/, '');

  // Remove possessive 's
  cleaned = cleaned.replace(/'s\b/g, '');

  // Remove common location words
  cleaned = cleaned.replace(/\b(nyc|new york|manhattan|brooklyn|queens|bronx|staten island)\b/gi, '');

  // Remove punctuation
  cleaned = cleaned.replace(/[^\w\s]/g, '');

  // Remove leading "the"
  cleaned = cleaned.replace(/^the\s+/, '');

  // Collapse whitespace
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
