-- Add per-platform cached fee structure to restaurants.
-- Shape: { "doordash": { ... CachedFees ... }, "seamless": { ... } }
-- Filled by populate scripts (from storepageFeed / /restaurants/{id}) so the
-- comparison engine can compute fees against any subtotal without needing
-- to simulate a full cart on the platform.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS platform_fees JSONB DEFAULT '{}';
