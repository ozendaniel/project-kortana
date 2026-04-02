-- Platform-level status tracking (e.g. {"seamless": "delisted", "doordash": "active"})
-- Used to flag ghost restaurants that appear in search but have no active menu.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS platform_status JSONB DEFAULT '{}';

-- Ghost restaurant marking is done by populate-seamless-menus.ts at runtime,
-- not in this migration. The script marks restaurants as delisted when getMenu()
-- returns 0 items.
