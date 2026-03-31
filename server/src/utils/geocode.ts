const GOOGLE_MAPS_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

/**
 * Geocode an address string to lat/lng using Google Maps Geocoding API.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('[Geocode] GOOGLE_MAPS_API_KEY not set — geocoding disabled');
    return null;
  }

  const params = new URLSearchParams({
    address,
    key: apiKey,
  });

  const response = await fetch(`${GOOGLE_MAPS_BASE}?${params}`);
  const data = (await response.json()) as {
    status: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
    }>;
  };

  if (data.status !== 'OK' || data.results.length === 0) {
    console.warn(`[Geocode] Failed for "${address}": ${data.status}`);
    return null;
  }

  const result = data.results[0];
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
  };
}

/**
 * Calculate distance between two points in meters using Haversine formula.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
