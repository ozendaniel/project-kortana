CREATE TABLE IF NOT EXISTS menu_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         UUID REFERENCES menus(id) ON DELETE CASCADE,
  restaurant_id   UUID REFERENCES restaurants(id),
  platform        TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  description     TEXT,
  price_cents     INTEGER NOT NULL,
  category        TEXT,
  platform_item_id TEXT,
  modifiers       JSONB,
  available       BOOLEAN DEFAULT true,
  matched_item_id UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id, platform);
CREATE INDEX IF NOT EXISTS idx_menu_items_match ON menu_items(matched_item_id);
