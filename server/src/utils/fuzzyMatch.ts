/**
 * Jaro-Winkler string similarity.
 * Returns a score between 0.0 (no similarity) and 1.0 (exact match).
 */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler modification: boost for common prefix (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Compute composite match confidence for two restaurants.
 */
export function computeMatchConfidence(params: {
  nameSimilarity: number;
  distanceMeters: number;
  phoneMatch: boolean;
  menuOverlap: number;
}): number {
  const { nameSimilarity, distanceMeters, phoneMatch, menuOverlap } = params;

  // Phone match alone is near-certain
  if (phoneMatch) return 0.95;

  // High name similarity + very close
  if (nameSimilarity >= 0.85 && distanceMeters <= 50) return 0.90;

  // Good name + close + menu overlap
  if (nameSimilarity >= 0.80 && distanceMeters <= 100 && menuOverlap >= 0.50) return 0.85;

  // Decent name + close = probable but flag for review
  if (nameSimilarity >= 0.75 && distanceMeters <= 100) return 0.70;

  // Low confidence
  if (nameSimilarity >= 0.60 && distanceMeters <= 200) return 0.50;

  return 0.0;
}
