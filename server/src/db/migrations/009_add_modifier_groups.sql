-- Cache per-item modifier group structure so the comparison engine can build
-- valid cart payloads for items with required customizations (flavor, size, etc).
--
-- Shape:
-- [
--   {
--     "id": "9424873442",
--     "name": "Pick a Flavor",
--     "minSelection": 1,
--     "maxSelection": 1,
--     "selectionMode": "single_select",
--     "isOptional": false,
--     "options": [
--       { "id": "44619422437", "name": "Chocolate", "priceDeltaCents": 0, "isDefault": true,
--         "description": "Chocolate" }
--     ]
--   }
-- ]
--
-- NULL for items without modifiers / quick-add eligible items.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS modifier_groups JSONB;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS menu_platform_id TEXT;
COMMENT ON COLUMN menu_items.menu_platform_id IS 'Platform-side menu ID (for DD addCartItem / SL cart lines). Different from menu_id FK.';
