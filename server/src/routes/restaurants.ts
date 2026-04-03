import { Router, type Request, type Response } from 'express';
import { db } from '../db/client.js';
import { geocodeAddress } from '../utils/geocode.js';

const router = Router();

/**
 * GET /api/restaurants/search?address={address}&q={optional_name_query}
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { address, q } = req.query;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address query parameter is required' });
    }

    const radiusKm = Math.min(Math.max(parseFloat(req.query.radius as string) || 8, 1), 25);
    const cuisine = req.query.cuisine as string | undefined;

    // Geocode the address
    const geo = await geocodeAddress(address);
    if (!geo) {
      return res.status(400).json({ error: 'Unable to geocode address' });
    }

    // Build query — search by proximity and optional filters
    let query = `
      SELECT id, canonical_name, address, lat, lng, cuisine_tags,
             doordash_id, seamless_id, doordash_url, seamless_url
      FROM restaurants
      WHERE lat IS NOT NULL AND lng IS NOT NULL
    `;
    const params: unknown[] = [];

    // Filter by proximity (bounding box from radius parameter)
    const latDelta = radiusKm / 111; // 1 degree lat ≈ 111km
    const lngDelta = radiusKm / (111 * Math.cos(geo.lat * Math.PI / 180));
    params.push(geo.lat - latDelta, geo.lat + latDelta, geo.lng - lngDelta, geo.lng + lngDelta);
    query += ` AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`;

    // Optional name search
    if (q && typeof q === 'string') {
      params.push(`%${q}%`);
      query += ` AND canonical_name ILIKE $${params.length}`;
    }

    // Optional cuisine filter (matches any element in cuisine_tags array)
    if (cuisine && typeof cuisine === 'string') {
      params.push(`%${cuisine}%`);
      query += ` AND array_to_string(cuisine_tags, ',') ILIKE $${params.length}`;
    }

    query += ' ORDER BY canonical_name, address';

    const result = await db.query(query, params);

    // Step 1: Group all rows by canonical_name
    const byName = new Map<string, typeof result.rows>();
    for (const r of result.rows) {
      if (!byName.has(r.canonical_name)) byName.set(r.canonical_name, []);
      byName.get(r.canonical_name)!.push(r);
    }

    // Step 2: For each name group, decide whether to keep as one entry or split.
    // Multi-location chains (any row has a real address) → group into one card
    // with expandable locations. All addressless → split into individual entries
    // (they're likely different restaurants that weren't deduped).
    type Group = {
      ids: string[];
      name: string;
      locations: Array<{ id: string; address: string }>;
      cuisines: string[];
      hasDoorDash: boolean;
      hasSeamless: boolean;
    };
    const finalGroups: Group[] = [];

    for (const [name, rows] of byName) {
      const anyHasAddress = rows.some(r => r.address && r.address.trim() !== '');

      if (anyHasAddress || rows.length === 1) {
        // Keep as one group — real chain with addresses, or single entry
        const group: Group = {
          ids: [], name, locations: [], cuisines: [],
          hasDoorDash: false, hasSeamless: false,
        };
        for (const r of rows) {
          group.ids.push(r.id);
          if (r.address && r.address.trim() !== '') {
            group.locations.push({ id: r.id, address: r.address });
          }
          if (r.doordash_id) group.hasDoorDash = true;
          if (r.seamless_id) group.hasSeamless = true;
          for (const c of (r.cuisine_tags || [])) {
            if (!group.cuisines.includes(c)) group.cuisines.push(c);
          }
        }
        finalGroups.push(group);
      } else {
        // No addresses — split each row into its own entry.
        // Sort: cross-matched (both platforms) first so the richest entry appears on top.
        const sorted = [...rows].sort((a, b) => {
          const aScore = (a.doordash_id && a.seamless_id ? 2 : 1);
          const bScore = (b.doordash_id && b.seamless_id ? 2 : 1);
          return bScore - aScore;
        });
        for (const r of sorted) {
          finalGroups.push({
            ids: [r.id],
            name: r.canonical_name,
            locations: [],
            cuisines: r.cuisine_tags || [],
            hasDoorDash: !!r.doordash_id,
            hasSeamless: !!r.seamless_id,
          });
        }
      }
    }

    const restaurants = finalGroups.map((g) => ({
      id: g.ids[0],
      name: g.name,
      address: g.locations[0]?.address || '',
      locations: g.locations,
      cuisines: g.cuisines,
      platforms: {
        doordash: g.hasDoorDash ? { available: true } : undefined,
        seamless: g.hasSeamless ? { available: true } : undefined,
      },
    }));

    res.json({ restaurants, location: geo });
  } catch (err) {
    console.error('[Route] /restaurants/search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/restaurants/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    res.json({ restaurant: result.rows[0] });
  } catch (err) {
    console.error('[Route] /restaurants/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
