import { GoogleGenerativeAI } from '@google/generative-ai';

interface UnmatchedItem {
  id: string;
  originalName: string;
  priceCents: number;
  category: string;
}

/**
 * Use Gemini Flash to match menu items that deterministic matching couldn't resolve.
 * Called as Tier 4 when match rate < 90% after Tiers 1-3.
 *
 * Sends one API call per restaurant with all unmatched items from both platforms.
 * Returns confident matches only — LLM is instructed to omit uncertain pairs.
 *
 * Free tier: 1,500 requests/day on Gemini Flash. Only complex menus trigger this
 * (~10-20% of restaurants), so capacity is never an issue.
 */
export async function llmMatchItems(
  ddItems: UnmatchedItem[],
  slItems: UnmatchedItem[],
): Promise<Array<{ ddId: string; slId: string }>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[LLM] No GEMINI_API_KEY configured — skipping LLM matching');
    return [];
  }

  if (ddItems.length === 0 || slItems.length === 0) return [];

  // Build indexed lists for the prompt
  const ddLines = ddItems.map((item, i) =>
    `${i + 1}. "${item.originalName}" ($${(item.priceCents / 100).toFixed(2)}, ${item.category})`
  ).join('\n');

  // Use letters for SL to avoid confusion with DD numbers
  const slLines = slItems.map((item, i) => {
    const letter = indexToLabel(i);
    return `${letter}. "${item.originalName}" ($${(item.priceCents / 100).toFixed(2)}, ${item.category})`;
  }).join('\n');

  const prompt = `You are matching food menu items across two delivery platforms (DoorDash and Seamless) for the same restaurant. Items may have different names, typos, abbreviations, missing words, or different languages but represent the same dish.

DOORDASH unmatched items:
${ddLines}

SEAMLESS unmatched items:
${slLines}

Return ONLY a JSON array of matches. Each match has the DoorDash number (dd) and Seamless label (sl). Only include matches you are confident are the same dish. Do not guess — if unsure, omit the pair.

Response format: [{"dd": 1, "sl": "A"}, {"dd": 2, "sl": "B"}]`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.1,       // Low temp for deterministic matching
        maxOutputTokens: 8192,  // Enough for large menus
        responseMimeType: 'application/json',
      },
    });

    // Retry with backoff on rate limits (free tier has per-minute limits)
    let text = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        text = result.response.text();
        break;
      } catch (retryErr: any) {
        const msg = retryErr.message || '';
        if ((msg.includes('429') || msg.includes('quota') || msg.includes('fetch')) && attempt < 2) {
          const delay = (attempt + 1) * 30;
          console.log(`[LLM] Rate limited, retrying in ${delay}s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, delay * 1000));
          continue;
        }
        throw retryErr;
      }
    }
    if (!text) return [];

    // Parse JSON response — handle truncation and markdown wrapping
    let pairs: Array<{ dd: number; sl: string }>;
    try {
      pairs = JSON.parse(text);
    } catch {
      // Response might be truncated (no closing ]) or wrapped in markdown
      let jsonText = text;

      // Strip markdown code fences if present
      jsonText = jsonText.replace(/^```json?\s*/m, '').replace(/\s*```$/m, '');

      // If truncated (no closing ]), add it
      const trimmed = jsonText.trim();
      if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
        // Find last complete object and close the array
        const lastBrace = trimmed.lastIndexOf('}');
        if (lastBrace > 0) {
          jsonText = trimmed.substring(0, lastBrace + 1) + ']';
        }
      }

      try {
        pairs = JSON.parse(jsonText);
      } catch {
        console.warn(`[LLM] Could not parse response. Length: ${text.length}, last 80 chars: ...${text.substring(text.length - 80)}`);
        return [];
      }
    }

    if (!Array.isArray(pairs)) {
      console.warn('[LLM] Response is not an array');
      return [];
    }

    // Convert indices back to IDs
    const matches: Array<{ ddId: string; slId: string }> = [];
    for (const pair of pairs) {
      const ddIdx = pair.dd - 1; // 1-indexed in prompt
      const slIdx = labelToIndex(pair.sl);

      if (ddIdx < 0 || ddIdx >= ddItems.length) continue;
      if (slIdx < 0 || slIdx >= slItems.length) continue;

      matches.push({
        ddId: ddItems[ddIdx].id,
        slId: slItems[slIdx].id,
      });
    }

    console.log(`[LLM] Gemini returned ${pairs.length} pairs, ${matches.length} valid`);
    return matches;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LLM] Gemini Flash error: ${msg.substring(0, 120)}`);
    return [];
  }
}

/** Convert 0-based index to letter label: 0→A, 1→B, ..., 25→Z, 26→AA, 27→AB */
function indexToLabel(i: number): string {
  let label = '';
  let n = i;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Convert letter label back to 0-based index: A→0, B→1, ..., Z→25, AA→26 */
function labelToIndex(label: string): number {
  let index = 0;
  for (let i = 0; i < label.length; i++) {
    index = index * 26 + (label.charCodeAt(i) - 64);
  }
  return index - 1;
}
