CREATE TABLE IF NOT EXISTS menus (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID REFERENCES restaurants(id),
  platform        TEXT NOT NULL CHECK (platform IN ('doordash', 'seamless', 'ubereats')),
  raw_data        JSONB,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, platform)
);
