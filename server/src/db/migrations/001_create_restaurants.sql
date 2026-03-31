CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS restaurants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,
  address         TEXT,
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  phone           TEXT,
  cuisine_tags    TEXT[],
  doordash_id     TEXT,
  seamless_id     TEXT,
  ubereats_id     TEXT,
  doordash_url    TEXT,
  seamless_url    TEXT,
  ubereats_url    TEXT,
  match_confidence DECIMAL(3,2),
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restaurants_location ON restaurants USING gist (
  point(lng, lat)
);
CREATE INDEX IF NOT EXISTS idx_restaurants_name ON restaurants USING gin (
  to_tsvector('english', canonical_name)
);
