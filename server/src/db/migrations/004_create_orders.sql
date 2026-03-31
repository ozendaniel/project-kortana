-- Orders table — user_id is nullable until Phase 4 (multi-user)
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID REFERENCES restaurants(id),
  platform_used   TEXT NOT NULL,
  items           JSONB NOT NULL,
  subtotal_cents  INTEGER NOT NULL,
  delivery_fee_cents INTEGER,
  service_fee_cents  INTEGER,
  total_cents     INTEGER NOT NULL,
  comparison_data JSONB,
  savings_cents   INTEGER,
  status          TEXT DEFAULT 'completed',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
