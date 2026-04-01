-- Unique partial indexes on platform IDs for ON CONFLICT upserts during discovery
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_doordash_id
  ON restaurants(doordash_id) WHERE doordash_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_seamless_id
  ON restaurants(seamless_id) WHERE seamless_id IS NOT NULL;
