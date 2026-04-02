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

    query += ' ORDER BY canonical_name';

    const result = await db.query(query, params);

    const restaurants = result.rows.map((r) => ({
      id: r.id,
      name: r.canonical_name,
      address: r.address,
      cuisines: r.cuisine_tags || [],
      platforms: {
        doordash: r.doordash_id ? { available: true } : undefined,
        seamless: r.seamless_id ? { available: true } : undefined,
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
