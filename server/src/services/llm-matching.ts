import OpenAI from 'openai';

interface UnmatchedItem {
  id: string;
  originalName: string;
  priceCents: number;
  category: string;
}

/**
 * Use GPT-4o-mini to match menu items that deterministic matching couldn't resolve.
 * Called as Tier 4 when match rate < 90% after Tiers 1-3.
 *
 * Splits DD items into batches of ~30 to avoid response truncation.
 * Each batch is matched against ALL SL items, with consumed SL items removed between batches.
 *
 * GPT-4o-mini: ~$0.0003/batch, no meaningful rate limits at this volume.
 * Falls back to Gemini Flash if OPENAI_API_KEY is not set but GEMINI_API_KEY is.
 */
const BATCH_SIZE = 30;

export async function llmMatchItems(
  ddItems: UnmatchedItem[],
  slItems: UnmatchedItem[],
): Promise<Array<{ ddId: string; slId: string }>> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!openaiKey && !geminiKey) {
    console.log('[LLM] No OPENAI_API_KEY or GEMINI_API_KEY configured — skipping LLM matching');
    return [];
  }

  if (ddItems.length === 0 || slItems.length === 0) return [];

  // Process DD items in batches, removing matched SL items between batches
  const allMatches: Array<{ ddId: string; slId: string }> = [];
  const consumedSLIds = new Set<string>();

  for (let batchStart = 0; batchStart < ddItems.length; batchStart += BATCH_SIZE) {
    const ddBatch = ddItems.slice(batchStart, batchStart + BATCH_SIZE);
    const availableSL = slItems.filter(s => !consumedSLIds.has(s.id));

    if (availableSL.length === 0) break;

    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(ddItems.length / BATCH_SIZE);
    console.log(`[LLM] Batch ${batchNum}/${totalBatches}: ${ddBatch.length} DD items vs ${availableSL.length} SL items`);

    const batchMatches = openaiKey
      ? await openaiMatchBatch(ddBatch, availableSL, openaiKey)
      : await geminiMatchBatch(ddBatch, availableSL, geminiKey!);

    for (const m of batchMatches) {
      allMatches.push(m);
      consumedSLIds.add(m.slId);
    }

    // Brief pause between batches (GPT-4o-mini doesn't need long delays)
    if (batchStart + BATCH_SIZE < ddItems.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[LLM] Total: ${allMatches.length} matches across ${Math.ceil(ddItems.length / BATCH_SIZE)} batches`);
  return allMatches;
}

function buildPrompt(ddItems: UnmatchedItem[], slItems: UnmatchedItem[]): string {
  const ddLines = ddItems.map((item, i) =>
    `${i + 1}. "${item.originalName}" ($${(item.priceCents / 100).toFixed(2)}, ${item.category})`
  ).join('\n');

  const slLines = slItems.map((item, i) => {
    const letter = indexToLabel(i);
    return `${letter}. "${item.originalName}" ($${(item.priceCents / 100).toFixed(2)}, ${item.category})`;
  }).join('\n');

  return `You are matching food menu items across two delivery platforms (DoorDash and Seamless) for the SAME restaurant. These are the same dishes sold on different platforms.

IMPORTANT RULES:
- Items WILL have different names: word reordering ("Roast Duck Half" vs "Half Roast Duck"), abbreviations ("W." = "with"), missing words, different languages (Seamless includes Chinese characters)
- Prices WILL differ between platforms (typically 5-15% difference) — do NOT use price to reject a match
- Match every DoorDash item that has a plausible Seamless equivalent
- Each item can only match once (1-to-1)
- If a DoorDash item truly has no Seamless equivalent, skip it

DOORDASH items to match:
${ddLines}

SEAMLESS candidates:
${slLines}

Return a JSON array of ALL matches you can identify. Format: [{"dd": 1, "sl": "A"}]`;
}

function parseMatchResponse(
  text: string,
  ddItems: UnmatchedItem[],
  slItems: UnmatchedItem[],
): Array<{ ddId: string; slId: string }> {
  let pairs: Array<{ dd: number; sl: string }>;

  try {
    pairs = JSON.parse(text);
  } catch {
    // Handle markdown wrapping or truncation
    let jsonText = text.replace(/^```json?\s*/m, '').replace(/\s*```$/m, '');
    const trimmed = jsonText.trim();
    if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastBrace > 0) jsonText = trimmed.substring(0, lastBrace + 1) + ']';
    }
    try {
      pairs = JSON.parse(jsonText);
    } catch {
      console.warn(`[LLM] Could not parse response. Length: ${text.length}`);
      return [];
    }
  }

  if (!Array.isArray(pairs)) return [];

  const matches: Array<{ ddId: string; slId: string }> = [];
  for (const pair of pairs) {
    const ddIdx = pair.dd - 1;
    const slIdx = labelToIndex(pair.sl);
    if (ddIdx < 0 || ddIdx >= ddItems.length) continue;
    if (slIdx < 0 || slIdx >= slItems.length) continue;
    matches.push({ ddId: ddItems[ddIdx].id, slId: slItems[slIdx].id });
  }
  return matches;
}

// --- OpenAI (GPT-4o-mini) ---

async function openaiMatchBatch(
  ddItems: UnmatchedItem[],
  slItems: UnmatchedItem[],
  apiKey: string,
): Promise<Array<{ ddId: string; slId: string }>> {
  try {
    const client = new OpenAI({ apiKey });
    const prompt = buildPrompt(ddItems, slItems);

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content || '';
    if (!text) return [];

    // GPT with json_object mode wraps in {"matches": [...]} — handle both shapes
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return []; }

    const arr = Array.isArray(parsed) ? parsed : (parsed.matches || parsed.results || parsed.data || []);
    const matches = parseMatchResponse(JSON.stringify(arr), ddItems, slItems);

    console.log(`[LLM] GPT-4o-mini returned ${arr.length} pairs, ${matches.length} valid`);
    return matches;
  } catch (err) {
    console.error(`[LLM] OpenAI error: ${err instanceof Error ? err.message.substring(0, 120) : err}`);
    return [];
  }
}

// --- Gemini Flash (fallback) ---

async function geminiMatchBatch(
  ddItems: UnmatchedItem[],
  slItems: UnmatchedItem[],
  apiKey: string,
): Promise<Array<{ ddId: string; slId: string }>> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const prompt = buildPrompt(ddItems, slItems);

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

    const matches = parseMatchResponse(text, ddItems, slItems);
    console.log(`[LLM] Gemini returned ${matches.length} valid matches`);
    return matches;
  } catch (err) {
    console.error(`[LLM] Gemini Flash error: ${err instanceof Error ? err.message.substring(0, 120) : err}`);
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
