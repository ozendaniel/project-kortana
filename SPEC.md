# Project Kortana — Technical Specification

## Overview

Project Kortana is a food delivery aggregator that lets users search restaurants across DoorDash and Seamless, build an order once, and see the total price (items + delivery fee + service fee) on each platform side by side. The MVP routes users to the cheapest platform to place their order manually. Future versions add auto-ordering, Uber Eats support, and a public subscription product.

**Working name:** Project Kortana
**Target market:** NYC (all boroughs)
**Stack:** React frontend + Express/Node backend + PostgreSQL + Playwright
**Hosting:** React on Vercel (or static on Railway), Express API on Railway
**Business model:** 20 free auto-routed orders → $10/month subscription

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  React Frontend (Vercel)                                │
│  ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌────────┐  │
│  │ Address   │ │ Search   │ │ Cart       │ │ Compare│  │
│  │ Input     │ │ Results  │ │ Builder    │ │ View   │  │
│  └───────────┘ └──────────┘ └────────────┘ └────────┘  │
└───────────────────────┬─────────────────────────────────┘
                        │ REST API calls
┌───────────────────────▼─────────────────────────────────┐
│  Express API Server (Railway)                           │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌────────┐  │
│  │ Search   │ │ Menu      │ │ Comparison │ │ Auth   │  │
│  │ Router   │ │ Service   │ │ Engine     │ │ Service│  │
│  └──────────┘ └───────────┘ └────────────┘ └────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Platform Adapters                                │   │
│  │  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │ DoorDash     │  │ Seamless     │              │   │
│  │  │ Adapter      │  │ Adapter      │              │   │
│  │  │ (GraphQL)    │  │ (REST)       │              │   │
│  │  └──────┬───────┘  └──────┬───────┘              │   │
│  └─────────┼─────────────────┼──────────────────────┘   │
│  ┌─────────▼─────────────────▼──────────────────────┐   │
│  │ Playwright Browser Pool                          │   │
│  │  [DoorDash Session]   [Seamless Session]         │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  PostgreSQL (Railway)                                   │
│  restaurants | menus | menu_items | orders | users       │
└─────────────────────────────────────────────────────────┘
```

---

## Phased Build Plan

### Phase 1 — Personal MVP (Weeks 1-4)
- DoorDash + Seamless restaurant search by address
- Automated restaurant deduplication (fuzzy matching)
- Daily menu cache with on-demand refresh
- Unified cart builder: add items once, see price per platform
- Comparison view showing item subtotal + delivery fee + service fee per platform
- Manual order placement: "Order on DoorDash" / "Order on Seamless" buttons that open the platform in a new tab with the restaurant pre-selected
- Single user (you), session tokens stored in environment variables

### Phase 2 — Auto-Routing (Weeks 5-8)
- Programmatic cart building on cheapest platform via Playwright
- Programmatic checkout (auto-order placement)
- Order confirmation and tracking relay
- Savings tracker dashboard (per-order and cumulative)
- Error handling: fallback to second-cheapest if primary fails

### Phase 3 — Uber Eats Integration (Weeks 9-12)
- Reverse-engineer Uber Eats GraphQL API (capture via DevTools)
- Build Uber Eats adapter following same interface as DoorDash/Seamless
- Three-way price comparison
- Update deduplication pipeline for three-platform matching

### Phase 4 — Public Product (Weeks 13-20)
- Account linking flow (Artemis model): users enter platform credentials
- Credential vault with AES-256 encryption at rest
- Token-based session management per user per platform
- User accounts with email/password auth (or magic link)
- Subscription logic: 20 free orders → $10/month paywall
- Savings analytics per user
- Stripe integration for subscription billing

---

## Data Model

### `restaurants` table
```sql
CREATE TABLE restaurants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,           -- Cleaned/normalized name
  address         TEXT,
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  phone           TEXT,                    -- Best unique identifier when available
  cuisine_tags    TEXT[],                  -- e.g. {'italian', 'pizza'}
  doordash_id     TEXT,                    -- Platform-specific restaurant ID
  seamless_id     TEXT,
  ubereats_id     TEXT,                    -- NULL until Phase 3
  doordash_url    TEXT,                    -- Direct link to restaurant on platform
  seamless_url    TEXT,
  ubereats_url    TEXT,
  match_confidence DECIMAL(3,2),          -- 0.00-1.00, fuzzy match confidence score
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_restaurants_location ON restaurants USING gist (
  point(lng, lat)
);
CREATE INDEX idx_restaurants_name ON restaurants USING gin (
  to_tsvector('english', canonical_name)
);
```

### `menus` table
```sql
CREATE TABLE menus (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID REFERENCES restaurants(id),
  platform        TEXT NOT NULL CHECK (platform IN ('doordash', 'seamless', 'ubereats')),
  raw_data        JSONB,                  -- Full menu response from platform
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, platform)
);
```

### `menu_items` table
```sql
CREATE TABLE menu_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         UUID REFERENCES menus(id) ON DELETE CASCADE,
  restaurant_id   UUID REFERENCES restaurants(id),
  platform        TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,           -- Normalized item name for cross-platform matching
  original_name   TEXT NOT NULL,           -- Exact name as shown on platform
  description     TEXT,
  price_cents     INTEGER NOT NULL,        -- Price in cents to avoid float issues
  category        TEXT,                    -- e.g. 'Appetizers', 'Entrees'
  platform_item_id TEXT,                   -- Platform's internal item ID (needed for cart)
  modifiers       JSONB,                  -- Available customizations/add-ons
  available       BOOLEAN DEFAULT true,
  matched_item_id UUID,                   -- Links to same item on another platform
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id, platform);
CREATE INDEX idx_menu_items_match ON menu_items(matched_item_id);
```

### `orders` table
```sql
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  restaurant_id   UUID REFERENCES restaurants(id),
  platform_used   TEXT NOT NULL,           -- Which platform was cheapest
  items           JSONB NOT NULL,          -- Array of {item_id, quantity, price_cents}
  subtotal_cents  INTEGER NOT NULL,
  delivery_fee_cents INTEGER,
  service_fee_cents  INTEGER,
  total_cents     INTEGER NOT NULL,
  -- Comparison data (what the other platforms would have cost)
  comparison_data JSONB,                  -- {doordash: {total: 2450}, seamless: {total: 2680}}
  savings_cents   INTEGER,                -- Difference between cheapest and next cheapest
  order_number    INTEGER,                -- Sequential per user (for 20-free-order tracking)
  status          TEXT DEFAULT 'completed',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### `users` table (Phase 4)
```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,
  subscription_status TEXT DEFAULT 'trial', -- trial | active | cancelled
  free_orders_remaining INTEGER DEFAULT 20,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### `platform_credentials` table (Phase 4)
```sql
CREATE TABLE platform_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  platform        TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,           -- AES-256 encrypted session token
  token_expires_at TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  status          TEXT DEFAULT 'active',   -- active | expired | revoked
  UNIQUE(user_id, platform)
);
```

---

## Platform Adapter Interface

Each platform adapter implements the same interface. This is the contract that keeps the comparison engine platform-agnostic.

```typescript
// src/adapters/types.ts

interface PlatformAdapter {
  platform: 'doordash' | 'seamless' | 'ubereats';

  // Initialize browser session (called once at server start for personal use)
  initialize(credentials: PlatformCredentials): Promise<void>;

  // Check if session is still valid
  isSessionValid(): Promise<boolean>;

  // Search restaurants near an address
  searchRestaurants(params: {
    address: string;
    lat: number;
    lng: number;
    query?: string;        // Optional restaurant name filter
    cuisine?: string;      // Optional cuisine filter
  }): Promise<PlatformRestaurant[]>;

  // Get full menu for a restaurant
  getMenu(platformRestaurantId: string): Promise<PlatformMenu>;

  // Get real-time fee estimate for an order
  getFees(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number }>;
    deliveryAddress: { lat: number; lng: number; address: string };
  }): Promise<PlatformFees>;

  // Phase 2: Build cart and checkout
  placeOrder?(params: {
    platformRestaurantId: string;
    items: Array<{ platformItemId: string; quantity: number; modifiers?: any }>;
    deliveryAddress: { lat: number; lng: number; address: string };
    paymentMethodId?: string;
  }): Promise<PlatformOrderConfirmation>;
}

interface PlatformRestaurant {
  platformId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
  cuisines: string[];
  rating?: number;
  deliveryTime?: string;     // e.g. "25-35 min"
  deliveryFee?: number;      // In cents, if available from search results
  imageUrl?: string;
  platformUrl: string;       // Direct link to restaurant on platform
}

interface PlatformMenu {
  categories: Array<{
    name: string;
    items: Array<{
      platformItemId: string;
      name: string;
      description?: string;
      priceCents: number;
      imageUrl?: string;
      modifiers?: Array<{
        name: string;
        options: Array<{ name: string; priceCents: number }>;
        required: boolean;
        maxSelections: number;
      }>;
    }>;
  }>;
}

interface PlatformFees {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  smallOrderFeeCents: number;
  totalCents: number;
  estimatedDeliveryTime?: string;
}

interface PlatformOrderConfirmation {
  orderId: string;
  estimatedDeliveryTime: string;
  totalChargedCents: number;
}
```

---

## DoorDash Adapter — Implementation Notes

### Authentication Flow
1. User provides email address
2. DoorDash sends OTP to email (or phone)
3. User enters OTP in Kortana
4. Playwright browser authenticates and stores session cookies in persistent browser profile
5. Session persists across server restarts via `~/.kortana/doordash-profile/`

### Key GraphQL Queries (from reverse-engineered MCP servers)

| Operation | Purpose | Response |
|-----------|---------|----------|
| `addConsumerAddress` | Set delivery location | Address ID |
| `homePageFacetFeed` | Search restaurants by address | Restaurant list with basic info |
| `storepageFeed` | Get restaurant detail + menu | Full menu with categories, items, prices |
| `addCartItem` | Add item to cart | Updated cart state |
| `createOrderFromCart` | Place order | Order confirmation |
| `convenienceSearchQuery` | Search within a store | Item search results |

### API Call Pattern
All calls go through `page.evaluate(fetch(...))` inside Playwright to inherit the browser's TLS fingerprint and Cloudflare clearance. Example:

```javascript
async function graphqlQuery(page, operationName, query, variables) {
  return await page.evaluate(async ({ operationName, query, variables }) => {
    const response = await fetch('https://www.doordash.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName, query, variables }),
    });
    return response.json();
  }, { operationName, query, variables });
}
```

### GraphQL Query Files
Store captured queries in `src/adapters/doordash/queries/` as `.graphql` files. Capture these by:
1. Opening DoorDash in a browser with DevTools Network tab open
2. Performing each action (search, view menu, add to cart, checkout)
3. Copying the query string and variables from each GraphQL request
4. Saving as separate `.graphql` files

### Session Management
- Browser profile directory: `~/.kortana/doordash-profile/`
- Cloudflare clearance cookies persist in the profile
- If session expires (API returns 401/403), re-trigger OTP login flow
- For personal MVP: store email in `.env`, prompt for OTP in terminal when needed

---

## Seamless Adapter — Implementation Notes

### Authentication Flow
1. User provides email + password (Seamless uses standard email/password auth)
2. Playwright browser logs in, captures session token from cookies/headers
3. Session token stored for subsequent API calls
4. Seamless uses REST (not GraphQL), so direct HTTP calls may work without Playwright after initial auth

### Key API Endpoints (to be captured via DevTools)

| Endpoint Pattern | Purpose |
|-----------------|---------|
| `GET /restaurants/search?lat=...&lng=...` | Search restaurants |
| `GET /restaurant/{id}/menu` | Get restaurant menu |
| `POST /cart/add` | Add item to cart |
| `GET /cart/checkout_summary` | Get fees and total |
| `POST /cart/submit` | Place order |

### Capture Process
1. Open seamless.com in Chrome with DevTools → Network tab
2. Set a delivery address → capture the address API call
3. Browse restaurants → capture `/restaurants/search` request with all headers
4. Open a restaurant → capture the menu endpoint
5. Add items to cart → capture cart API calls
6. Proceed to checkout → capture the checkout summary (this gives you the fee breakdown)
7. Save all request patterns, headers, and cookie names

### Session Management
- Seamless may use simpler cookie-based auth than DoorDash
- Capture the session cookie name (likely `_grubhub_session` or similar)
- If REST calls work with just the session cookie (no Cloudflare), you can use direct `fetch()` from Node.js instead of Playwright — much lighter weight
- Test this early: if direct HTTP works, the Seamless adapter will be significantly simpler

---

## Restaurant Deduplication Pipeline

### Overview
Runs as a daily batch job after menu sync. Matches restaurants across platforms to create canonical entries.

### Matching Algorithm

```
For each unmatched restaurant on Platform A:
  1. Geocode address → lat/lng (if not already geocoded)
  2. Find candidates on Platform B within 100m radius
  3. For each candidate:
     a. Name similarity = Jaro-Winkler distance on cleaned names
     b. Address similarity = normalized street address match
     c. Phone match = exact match on phone number (if available)
     d. Menu overlap = Jaccard similarity on menu item names
  4. Compute composite score:
     - Phone match alone = 0.95 confidence (nearly certain)
     - Name ≥ 0.85 AND distance ≤ 50m = 0.90 confidence
     - Name ≥ 0.80 AND distance ≤ 100m AND menu overlap ≥ 0.50 = 0.85
     - Name ≥ 0.75 AND distance ≤ 100m = 0.70 (probable, flag for review)
  5. If confidence ≥ 0.80, auto-merge into canonical restaurant entry
  6. If 0.60 ≤ confidence < 0.80, flag for manual review (Phase 1 only)
```

### Name Cleaning
Before comparison, normalize restaurant names:
```
"Joe's Famous Pizza - Broadway" → "joes famous pizza"
"Joe's Pizza (Broadway Location)" → "joes pizza"
```

Rules:
- Lowercase
- Remove punctuation and possessive 's
- Remove common suffixes: location descriptors in parens, "- {location}", "NYC", "New York"
- Remove leading "The"
- Collapse whitespace

### Menu Item Matching
After restaurants are matched, match individual menu items across platforms:

```
For each item on Platform A for a matched restaurant:
  1. Clean item name (lowercase, remove sizes/descriptors)
  2. Find items on Platform B in same restaurant with:
     a. Exact cleaned name match → auto-match
     b. Jaro-Winkler ≥ 0.90 → auto-match
     c. Jaro-Winkler ≥ 0.80 AND same category → auto-match
     d. Below 0.80 → no match (item may be platform-exclusive)
  3. Set matched_item_id on both records
```

### LLM-Assisted Matching (Optional Enhancement)
For items that fuzzy matching can't resolve, batch them and send to Claude API:

```
Prompt: "Given these two restaurant menus, identify which items are the same dish.
Menu A (DoorDash): [list]
Menu B (Seamless): [list]
Return a JSON array of matches: [{a: "item name A", b: "item name B", confidence: 0.95}]"
```

This handles cases like "Chicken Tikka Masala" vs "Tikka Masala w/ Chicken" that string similarity alone misses. Budget ~$0.01-0.03 per restaurant pair via Claude Haiku.

---

## Comparison Engine

### Flow

```
User enters address → User searches restaurant (or browses) → User selects restaurant
→ Unified menu displayed (merged items from both platforms)
→ User adds items to cart → Comparison engine computes total per platform
→ Comparison view shows side-by-side totals → User clicks to order on cheapest
```

### Price Computation

For each platform where the restaurant is available:

```
1. Map each cart item to platform-specific item ID via matched_item_id
2. Compute item subtotal from cached menu prices
3. Fetch real-time fees by calling the platform's fee estimation endpoint:
   - DoorDash: Simulate adding items to cart, read checkout preview
   - Seamless: Call checkout_summary endpoint with cart contents
4. Total = item_subtotal + delivery_fee + service_fee + small_order_fee (if applicable)
5. If any item in cart has no match on a platform, mark that platform as "partial"
   (some items unavailable) and show the available-items-only total with a warning
```

### Handling Unmatched Items

Some menu items exist on only one platform. The comparison view should:
- Show the full cart total on the platform where all items are available
- Show a "partial order" indicator on platforms missing items, with the missing items listed
- Let the user decide: order everything from one platform, or split the order

### Fee Caching Strategy

Fees are dynamic, but within a short window they're stable enough to cache:
- Cache fee estimates for 5 minutes per restaurant + order size combination
- On the comparison view, show "prices as of [time]" and a refresh button
- Always fetch fresh fees when user clicks "Order on [platform]"

---

## Daily Sync Pipeline

### Schedule
Run at 3:00 AM ET daily (lowest delivery demand, least likely to trigger bot detection).

### Steps

```
1. For each ZIP code in NYC coverage area:
   a. Set delivery address to ZIP centroid via each platform adapter
   b. Fetch restaurant list (paginate through all results)
   c. Upsert restaurants into DB with platform-specific IDs

2. For each restaurant in DB (batch, rate-limited):
   a. Fetch full menu from each platform where restaurant is listed
   b. Upsert menu and menu_items
   c. Flag items where price changed >10% since last sync (potential data issue)

3. Run deduplication pipeline:
   a. Match new/unmatched restaurants across platforms
   b. Match menu items for newly matched restaurants
   c. Update match confidence scores

4. Log sync results:
   - Restaurants added/updated per platform
   - New cross-platform matches found
   - Failed fetches (for retry)
   - Price change anomalies
```

### Rate Limiting
- Space requests 2-3 seconds apart per platform
- Randomize intervals slightly (1.5-3.5s) to appear more human
- Cap at 500 restaurant menu fetches per platform per sync run
- Full NYC coverage (~15-25K restaurants) will take multiple nights to fully populate
- Prioritize by: restaurants in user's delivery radius first, then expand outward

---

## API Endpoints

### Search
```
GET /api/restaurants/search?address={address}&q={name}&radius={km}&cuisine={type}

Query params:
  address  (required)  — street address, geocoded server-side
  q        (optional)  — filter by restaurant name (ILIKE)
  radius   (optional)  — search radius in km (default 8, max 25)
  cuisine  (optional)  — filter by cuisine type (ILIKE on cuisine_tags array)

Response: {
  restaurants: [{
    id: "uuid",
    name: "Joe's Pizza",
    address: "7 Carmine St, New York, NY",
    cuisines: ["italian", "pizza"],
    platforms: {
      doordash: { available: true },
      seamless: { available: true }
    }
  }],
  location: { lat: 40.730, lng: -73.999, formattedAddress: "..." }
}
```

### Menu
```
GET /api/restaurants/:id/menu

Response: {
  restaurant: { id, name, address },
  menu: [{
    category: "Appetizers",
    items: [{
      id: "uuid",
      name: "Garlic Knots",
      description: "Fresh baked with garlic butter",
      platforms: {
        doordash: { itemId: "dd-12345", priceCents: 699, available: true },
        seamless: { itemId: "sl-67890", priceCents: 649, available: true }
      }
    }]
  }]
}
```

### Compare
```
POST /api/compare

Body: {
  restaurantId: "uuid",
  address: { lat: 40.7128, lng: -74.0060, address: "123 Main St, NYC" },
  items: [
    { itemId: "uuid", quantity: 2 },
    { itemId: "uuid", quantity: 1 }
  ]
}

Response: {
  comparison: {
    doordash: {
      available: true,
      itemSubtotalCents: 2097,
      deliveryFeeCents: 299,
      serviceFeeCents: 314,
      smallOrderFeeCents: 0,
      totalCents: 2710,
      estimatedDeliveryTime: "25-35 min",
      missingItems: [],
      orderUrl: "https://doordash.com/store/joes-pizza-12345"
    },
    seamless: {
      available: true,
      itemSubtotalCents: 1947,
      deliveryFeeCents: 199,
      serviceFeeCents: 292,
      smallOrderFeeCents: 0,
      totalCents: 2438,
      estimatedDeliveryTime: "30-40 min",
      missingItems: [],
      orderUrl: "https://seamless.com/menu/joes-pizza-67890"
    },
    cheapest: "seamless",
    savingsCents: 272
  }
}
```

### Order (Phase 2)
```
POST /api/orders/place

Body: {
  restaurantId: "uuid",
  platform: "seamless",    // Auto-selected or user-overridden
  items: [...],
  address: {...}
}

Response: {
  orderId: "uuid",
  platformOrderId: "SL-98765",
  totalChargedCents: 2438,
  estimatedDeliveryTime: "30-40 min",
  savingsCents: 272
}
```

### Savings Dashboard
```
GET /api/savings

Response: {
  totalOrders: 47,
  totalSavingsCents: 12850,    // $128.50 saved
  averageSavingsPerOrderCents: 273,
  platformBreakdown: {
    doordash: { timesChosen: 22, totalSpentCents: 58400 },
    seamless: { timesChosen: 25, totalSpentCents: 52300 }
  },
  recentOrders: [...]
}
```

---

## Frontend Views

### 1. Address Input
- Full-width address input with Google Places autocomplete
- "Use my location" GPS button
- Persists last-used address in localStorage

### 2. Restaurant Search Results
- Search bar for restaurant name / cuisine filtering
- Grid or list of restaurants
- Each card shows: name, cuisines, rating, delivery time range, platform availability badges
- Badge colors: show which platforms have this restaurant
- Sort by: relevance, delivery time, or number of platforms available

### 3. Unified Menu View
- Restaurant header with platform badges
- Menu organized by category
- Each item shows price on each platform inline (e.g. "Garlic Knots — DD: $6.99 | SL: $6.49")
- Items only on one platform are tagged "(DoorDash only)" etc.
- Add to cart button with quantity selector

### 4. Cart + Comparison View (the core feature)
- Left panel: your cart (items, quantities, modifications)
- Right panel: side-by-side comparison cards, one per platform
- Each card shows:
  - Item subtotal
  - Delivery fee
  - Service fee
  - Small order fee (if applicable)
  - **Total (bold, large)**
  - Estimated delivery time
  - Missing items warning (if any)
- Cheapest platform highlighted with a "Best Price" badge and savings amount
- "Order on [Platform]" button for each (opens platform URL in new tab for Phase 1)
- Phase 2: "Auto-Order on [Cheapest]" button that places order programmatically

### 5. Savings Dashboard
- Cumulative savings counter (large, prominent)
- Chart of savings over time
- Per-platform breakdown
- Order history with per-order savings

---

## Project Structure

```
project-kortana/
├── client/                          # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── AddressInput.tsx
│   │   │   ├── RestaurantCard.tsx
│   │   │   ├── RestaurantSearch.tsx
│   │   │   ├── MenuView.tsx
│   │   │   ├── CartPanel.tsx
│   │   │   ├── ComparisonCard.tsx
│   │   │   ├── ComparisonView.tsx
│   │   │   └── SavingsDashboard.tsx
│   │   ├── hooks/
│   │   │   ├── useSearch.ts
│   │   │   ├── useCart.ts
│   │   │   └── useComparison.ts
│   │   ├── api/
│   │   │   └── client.ts            # Axios/fetch wrapper for API calls
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
│
├── server/                          # Express backend
│   ├── src/
│   │   ├── index.ts                 # Express app entry point
│   │   ├── routes/
│   │   │   ├── restaurants.ts
│   │   │   ├── menus.ts
│   │   │   ├── compare.ts
│   │   │   ├── orders.ts
│   │   │   └── savings.ts
│   │   ├── adapters/
│   │   │   ├── types.ts             # PlatformAdapter interface
│   │   │   ├── doordash/
│   │   │   │   ├── adapter.ts
│   │   │   │   ├── browser.ts       # Playwright session manager
│   │   │   │   └── queries/         # .graphql files
│   │   │   │       ├── homePageFacetFeed.graphql
│   │   │   │       ├── storepageFeed.graphql
│   │   │   │       ├── addCartItem.graphql
│   │   │   │       └── createOrderFromCart.graphql
│   │   │   └── seamless/
│   │   │       ├── adapter.ts
│   │   │       └── browser.ts
│   │   ├── services/
│   │   │   ├── deduplication.ts     # Fuzzy matching pipeline
│   │   │   ├── comparison.ts        # Price comparison engine
│   │   │   ├── sync.ts             # Daily menu sync job
│   │   │   └── matching.ts         # Menu item cross-platform matching
│   │   ├── db/
│   │   │   ├── client.ts           # PostgreSQL connection
│   │   │   └── migrations/         # SQL migration files
│   │   └── utils/
│   │       ├── geocode.ts          # Google Maps geocoding
│   │       ├── fuzzyMatch.ts       # Jaro-Winkler implementation
│   │       └── nameCleaner.ts      # Restaurant/item name normalization
│   ├── package.json
│   └── tsconfig.json
│
├── .env.example                     # Environment variable template
├── docker-compose.yml               # Local dev: Postgres + app
└── README.md
```

---

## Environment Variables

```bash
# .env

# Database
DATABASE_URL=postgresql://user:pass@host:5432/kortana

# Platform credentials (Phase 1: personal use)
DOORDASH_EMAIL=your@email.com
SEAMLESS_EMAIL=your@email.com
SEAMLESS_PASSWORD=encrypted_or_via_secret_manager

# Google Maps (for geocoding + address autocomplete)
GOOGLE_MAPS_API_KEY=...

# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# Encryption (Phase 4: credential vault)
ENCRYPTION_KEY=...         # 256-bit key for AES-256

# Stripe (Phase 4)
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

---

## Definition of Done — Phase 1

The personal MVP is complete when:

- [ ] Express server starts and maintains authenticated Playwright sessions for DoorDash and Seamless
- [ ] Address input geocodes and sets delivery location on both platforms
- [ ] Restaurant search returns results from both platforms, deduplicated
- [ ] Clicking a restaurant shows a unified menu with prices from each platform
- [ ] Adding items to cart triggers real-time fee comparison
- [ ] Comparison view correctly shows item subtotal + delivery fee + service fee per platform
- [ ] "Best price" badge correctly identifies cheapest platform
- [ ] "Order on [Platform]" button opens the correct restaurant page on the platform
- [ ] Savings are logged to the database for each comparison/order
- [ ] Daily sync cron job refreshes restaurant and menu data
- [ ] Accessible from phone via cloud-hosted URL

---

## Key Dependencies

### Backend
- `express` — API server
- `playwright` — Browser automation for platform sessions
- `pg` / `postgres` — PostgreSQL client
- `node-cron` — Daily sync scheduler
- `jaro-winkler` — String similarity for deduplication
- `dotenv` — Environment variable management
- `cors` — Cross-origin requests from frontend
- `helmet` — Security headers

### Frontend
- `react` + `vite` — UI framework + build tool
- `react-router` — Client-side routing
- `@tanstack/react-query` — API state management
- `@react-google-maps/api` — Address autocomplete
- `zustand` — Lightweight state management (cart state)
- `tailwindcss` — Styling

### Infrastructure
- Railway — Express server + PostgreSQL
- Vercel — React frontend hosting (or serve static from Railway)
- Google Maps Platform — Geocoding API + Places Autocomplete

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| DoorDash Cloudflare blocks Playwright on Railway | Use `patchright` (undetected Playwright fork). If Railway's IP range is blocked, fall back to a residential proxy or a small VPS with residential IP. |
| OTP re-authentication interrupts flow | Cache browser profiles persistently. DoorDash sessions last days/weeks. Monitor for 401s and alert via Slack/email when re-auth is needed. |
| Seamless changes API endpoints | Monitor for 404/500 responses in sync jobs. Alert immediately. Re-capture endpoints via DevTools. |
| Fee estimation is inaccurate | Always show "estimated" label. Fetch fresh fees on "Order" click. Track actual vs estimated in order history for calibration. |
| Menu sync takes too long for all-NYC coverage | Prioritize restaurants within user's actual delivery radius. Expand radius over time. Cap nightly sync at manageable batch size. |
| Fuzzy matching produces false merges | Require 0.80+ confidence for auto-merge. Log all matches. Build a simple admin view to review and override matches. |
