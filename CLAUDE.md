# Project Kortana

## Session Rules

- Compact the context window whenever usage reaches 40%. Summarize key decisions and current working state before compacting.

## What This Is

A food delivery price comparison and order routing platform. Users search restaurants across DoorDash and Seamless (Uber Eats in Phase 3), build an order once, and see the total price (items + delivery fee + service fee) on each platform side by side. The platform routes the order to the cheapest option.

Personal tool first. Public subscription product ($10/month after 20 free orders) later.

## Owner

Dan Ozen — building solo with Claude Code. PE background (O3 Industries). NYC-based.

## Current Status

**Phase:** Phase 1 — in progress. Both live adapters working for search + menu. Comparison engine operational with live prices + estimated fees.

**What's been done:**
- Full competitive landscape research (MealMe pivoted to B2B API, FoodBoss is superficial — consumer "Kayak for food delivery" opportunity is unoccupied)
- Reverse-engineered API feasibility confirmed for all three platforms
- Technical spec written (see SPEC.md in this repo)
- Architecture, data model, adapter interface, and build phases defined
- Business model validated: average $2-3 savings per order makes $10/month a clear win at 5+ orders/month
- Full project scaffold: React + Express + PostgreSQL + Playwright (2026-03-31)
- Railway Postgres provisioned and all 6 migrations applied (restaurants, menus, menu_items, orders, restaurant_discovery indexes, platform_status)
- DoorDash GraphQL queries captured from HAR file — 28 unique operations including homePageFacetFeed (search), storepageFeed (menu), addCartItem (cart)
- Seamless/Grubhub REST API endpoints captured from HAR — 40+ endpoints cataloged with request/response samples in `server/src/adapters/seamless/endpoints/`
- DoorDash adapter live-tested (2026-04-01): searchRestaurants returns ~57 restaurants, getMenu returns full menus (421 items for test restaurant). getFees returns live subtotal + total from DoorDash's PreviewOrderV2 (via main tab cart → detailedCartItems query). Falls back to estimated fees if live cart fails.
- Seamless adapter live-tested (2026-03-31): searchRestaurants, getMenu, getFees all working via real Chrome CDP session + Grubhub API with real-time cart/bill for fees.
- Both adapters use real Chrome via spawn + connectOverCDP (not launchPersistentContext) to bypass bot detection
- DoorDash browser uses dedicated API tab with route blocking to prevent SPA navigation interference
- DoorDash search uses facet component parsing (component.id === 'row.store', data in text/custom/events fields)
- Comparison engine working: DB-based fallback calculates prices from seeded menu data + estimated fees when no live adapters are running. Live adapter path ready for when sessions are configured.
- Frontend working: address search → geocoded location stored in cart → restaurant list → unified menu view → cart builder → comparison view with default address fallback
- Seeded one restaurant (Grandma's Home 外婆家) with 72 DoorDash items + 29 Seamless items, cross-platform matched via matched_item_id
- DoorDash adapter enabled in index.ts (requires DOORDASH_EMAIL in .env)
- Portal-based authentication: Chrome runs headful on all platforms (Google blocks headless Chrome OAuth with "browser not secure" error). On Railway/Linux, Xvfb provides a virtual display. On Windows/macOS, Chrome windows are visible on desktop but users interact via the Kortana Settings page portal (CDP screencast over WebSocket). Only headless on Linux without DISPLAY (CI/scripts).
- Non-blocking adapter init: server starts instantly, shows session status on Settings page. Login via portal when sessions expire. Session monitor uses `checkSession()` (reads localStorage, no navigation) instead of `isLoggedIn()` (navigates to homepage, spawns popup windows in headful mode).
- WebSocket server on /ws for real-time browser frame streaming and auth status updates. BrowserView uses effect-scoped `active` flag (not shared `mountedRef`) to prevent React Strict Mode double-mount from killing the working WS connection. Auth manager adopts new WS clients on re-mount instead of rejecting, and `stopLogin` ignores stale WS close events.
- Railway-ready: Dockerfile with Google Chrome, persistent volume support for session profiles, cross-platform Chrome path detection
- Frontend redesigned with "Noir Receipt" aesthetic: dark theme (#0C0B0E base), Instrument Serif headings, JetBrains Mono prices, DM Sans UI text, electric lime (#C8FF2E) savings accent. Receipt-style comparison with dotted separators, winner stripe, staggered animations. Mobile-friendly with bottom cart bar.
- Bulk restaurant discovery completed (2026-04-01): 616 Seamless restaurants via Manhattan grid search (35 points), initial 592 DoorDash restaurants via paginated feed (15 pages).
- DoorDash search component changed from `row.store` to `card.store` — facet component system updated
- DoorDash discovery uses main tab with full SPA context (API tab returns empty feed due to Cloudflare). Headful Chrome required for discovery (headless gets 403).
- Search filters: cuisine type dropdown and radius selector (1-25km) on restaurant search. Server-side filtering via bounding box + cuisine ILIKE on cuisine_tags array.
- Migration 005 adds unique partial indexes on doordash_id and seamless_id for upsert support
- Dedup enhanced with name-only matching fallback (for DoorDash restaurants without precise addresses) and dry-run mode
- Multi-location grouping (2026-04-02): Search API groups restaurants by canonical_name. Each result includes `locations[]` array with `{id, address}` per physical location. Frontend RestaurantCard shows expandable location list for chains (▸/▾ chevron). Single-location cards show address directly.
- Chain name normalization: nameCleaner.ts has CHAIN_ALIASES map (40+ entries) for canonical chain forms (McDonald's, Dunkin', 7-Eleven, Chipotle, etc.). Fixed dash regex to avoid stripping "7-Eleven" to "7".
- Seamless paginated discovery: adapter has searchRestaurantsPaginated() with page/sort/facet control. Discovery script does multi-pass: default paginated search + cuisine-filtered passes for categories hitting the 500-result API cap.
- Dedup improvements: in-memory menu cache (avoids per-pair DB queries), relaxed geo thresholds (400m radius), more nuanced name-only confidence tiers
- DoorDash expanded discovery (2026-04-02): 3-pass script (deep pagination + cuisine verticals + text search) with checkpoint/resume, early termination, escalating 429 cooldowns. Pass 1 (36 pages) found 911 new, Pass 3 (text search) found 410 new. Total: 2,029 DoorDash restaurants. Cuisine vertical filtering (Pass 2) was ineffective — returns same feed regardless of vertical ID.
- Dedup rewrite (2026-04-02): Replaced O(n²) brute-force with multi-key blocking (exact cleaned name, geohash-6 + neighbors, name prefix 3-char, phone number). 21,464 comparisons vs 10.9M brute force (512x reduction). Completes in <1s scoring + ~2min DB merges. Merged 358 restaurants, flagged 408 for review. DB now has 533 cross-platform matched restaurants, 7,597 total rows.
- Seamless menu bulk population (2026-04-02): populate-seamless-menus.ts fetched menus for all 533 matched restaurants. 251 restaurants populated with 50,879 menu items. 268 ghost restaurants marked as `platform_status.seamless = "delisted"` (appear in Seamless search but return 404/empty menus — confirmed manually). Shared upsertMenu() utility extracted to services/menu-upsert.ts with batched INSERTs. Fixed bug: refresh-menus.ts was using cleanRestaurantName() for item canonical names instead of cleanItemName().
- Migration 006 adds `platform_status JSONB` column to restaurants table for tracking per-platform listing status (e.g. `{"seamless": "delisted"}`). Ghost restaurants auto-excluded from future populate runs.
- DoorDash menu bulk population script (2026-04-03): populate-doordash-menus.ts with same CLI flags as Seamless version (--matched-only, --limit, --resume, --sustained, --dry-run, --skip-match, --restaurant-id). Uses mainTabGraphqlQuery (not API tab) because Cloudflare blocks API tab's route-blocked page from completing CF challenge. Pre-spawns Chrome headful on CDP port 9224 with stale-process cleanup. Tested: "2nd av pizza" (48 items, 43 matched with Seamless, 100% price match), "ane bar restaurant" (63 items, DD-only). Bash wrapper: run-doordash-populate.sh with auto-restart, 90s cooldown between restarts.
- Cross-platform item matching rewrite (2026-04-03): 4-tier algorithm. T1: high-confidence name (JW≥0.95) matched regardless of price. T2: good name (JW≥0.85) + same category + soft price boost. T2.5: similar name (JW≥0.75) + exact price match. T3: description-enriched. T4: Gemini Flash LLM for semantic matching (batched, 30 items/call). DD items de-duped by platform_item_id. Category normalization map for cross-platform equivalents. Lunch/catering excluded from LLM. validateMatches() for quality reporting.
- CRITICAL: Seamless REST API is unreliable for menus (2026-04-03). The `enhanced_feed` + `restaurant_gateway/feed` endpoints return items from multiple inactive menu sets (ghost items like "Beef Tendon") AND miss items that ARE on the website (like "Mango Jumbo Shrimp"). Neither `hideUnavailableMenuItems` nor category deduplication fixes this. The website uses a protobuf BFF endpoint (`menubff`) + client-side filtering. Bulk Seamless populate script stopped at 1,647 restaurants — all data unreliable. DoorDash API IS reliable (verified: 0 ghost items, matches website exactly).
- **Seamless DOM scraping SOLVED (2026-04-04):** Live-tested on Dim Sum Palace (SL ID 1387494, 33 W 33rd St). 208 items, 17 categories, 208 matched with DD (83% match rate). Key findings: (1) **HEADFUL Chrome required** — HeadlessChrome user-agent causes API to return empty categories (itemCount=0). Must launch without `--headless=new`. (2) Fresh tab per restaurant (stale SPA state breaks rendering). (3) Delivery address must be set — lost on Chrome restart. (4) MutationObserver captures items from virtualized DOM during scroll. (5) Per-item category tracking via h3 viewport position. (6) `item_search` endpoint has ~10 additional items not in category feeds (Bbq Pork Buns, Chicken Feet, etc.) — requires full portal login auth. (7) "View more items" buttons load more categories, not more items within a category. (8) Use `page.keyboard` for address input (React re-renders detach refs).
- Unified menu now filters out Seamless-only items when both platforms present (DD-as-source-of-truth for ghost filtering). Ghost SL items from the API that don't match any DD item are hidden from the comparison UI.
- **DoorDash address enrichment complete (2026-04-04):** populate-doordash-menus.ts now extracts address + phone from `storepageFeed` response (storeHeader.address + mxInfo.phoneno) — zero extra API calls, piggybacks on existing menu fetch. 2,024/2,029 DD restaurants (99.8%) now have real addresses, coordinates, and phone numbers. Previously all had placeholder coords (40.748, -73.997). discover-doordash.ts `--enrich` flag also fixed: switched from blocked `graphqlQuery()` to `mainTabGraphqlQuery()`, added SPA context setup, phone extraction, configurable `--limit`.
- **DoorDash full menu population complete (2026-04-04):** All 2,029 DD restaurants processed. 1,233 menus populated with 117,549 items. 262 delisted (empty menus). Chrome crashes every ~300 restaurants due to memory — `--resume` flag handles restarts cleanly.
- **Seamless concurrent DOM scraping (2026-04-05):** populate-seamless-menus.ts now supports `--concurrency N` flag for parallel restaurant scraping. Each worker opens its own fresh tab. Health checks and keep-alive run between batches. `--concurrency 4` safe on 32GB desktop (~3.5 GB Chrome memory); `--concurrency 2` for 16GB laptops.
- **Headful Chrome tab cleanup (2026-04-05):** Seamless JS (Rokt ads, Stripe iframes) spawns popup windows during scraping. Three-layer cleanup: (1) pre-scrape closes orphaned tabs from previous runs, (2) dual popup handlers — `scrapePage.on('popup')` for direct popups + `context.on('page')` with 100ms deferred `activeScrapePages` check for iframe-spawned windows (context-level without defer kills other workers' tabs; page-level alone misses iframe popups), (3) post-scrape cleanup with 500ms delay for propagation. Critical for unattended 24h runs in headful mode.
- **Permanent popup handlers (2026-04-05):** Both DoorDashBrowser and SeamlessBrowser install `context.on('page')` handlers in `launch()` and `ensureConnected()` that auto-close any page not owned by the browser (main page, API page, or knownPages set). 500ms defer avoids race with legitimate page creation. Fixes Rokt/Stripe/DoubleClick ad iframes spawning empty Chrome windows on Windows every 5-10 minutes.
- **isLoggedIn() replaced with checkSession() everywhere (2026-04-05):** `isLoggedIn()` navigates to the platform homepage, creating visible pages with ad iframes. Replaced in: adapter `initialize()`, adapter `isSessionValid()`, and auth-manager session monitor. `checkSession()` uses cookies/localStorage — zero page creation, zero navigation. Fixes: server restarts no longer spawn popup storms, populate health checks don't create orphaned tabs.
- **Menu item search feature (2026-04-05):** `GET /api/menu-items/search` — ILIKE search on `canonical_name` with bounding box, restaurant grouping, Union-Find merge, ghost filtering. Migration 007 adds pg_trgm extension (index pending — Railway disk full). Frontend: pill toggle `Restaurants | Menu Items` on search page, debounced 400ms, receipt-style result cards. Click navigates to menu with `?q=` highlight. Shared menu logic extracted to `server/src/services/menu-utils.ts`.
- **DOM scrape retry for virtualized menus (2026-04-05):** `getMenuFromDOM()` no longer bails immediately on 0 `.menuItem` elements. Retries 4 times with scroll-to-trigger between attempts. Fixes false "out of delivery range" on restaurants like SK Halal Food where Seamless renders menu items below a banner.
- **Dedup geo-matching needs tuning (2026-04-04):** Dry run with real DD addresses found 96 potential merges, but ~30-40% are false positives. NYC density means unrelated restaurants are often within 400m. Examples: "katz delicatessen" ↔ "rita delicatessen" (0.88), "butter lettuce" ↔ "butterflied chicken" (0.82). Need to raise AUTO_MERGE_THRESHOLD for geo matches or require menu item overlap. Results saved in `server/data/dedup-dryrun-2026-04-04.txt`.
- **Rogue Seamless populate caught (2026-04-04):** `run-seamless-populate.sh` bash wrapper was auto-restarting Seamless populate up to 50 times. Killing the Node process alone isn't enough — must kill the bash wrapper PID. Found via `wmic process` tracing parent chain.

- Deployed to Railway (2026-04-01): kortana-web-production.up.railway.app. Dockerfile with Google Chrome Stable, persistent volume at /data for Chrome profiles, railway.toml with healthcheck. Express serves built client in production (static + SPA fallback).
- Railway Chrome fixes: --disable-dev-shm-usage (64MB /dev/shm in Docker), profile lock file cleanup on launch (SingletonLock persists across redeploys), CDP reconnect timeout with fallback to full relaunch, memory-saving Chrome flags for Linux.
- Railway memory constraint: container can't run two Chrome instances simultaneously. Auth manager suspends other platform browsers during login, restores them after.
- DoorDash .graphql files copied to dist/ in build step (tsc doesn't copy non-TS files).
- Login poll fix: replaced isLoggedIn() (which navigated the page away) with checkSession() (inspects current page state without navigating) in the screencast login flow.
- Seamless portal login fully working on Railway (2026-04-02): Google OAuth via popup handled by screencast switching (auth-manager detects popup, switches CDP screencast + input routing to it, reverts on close). Xvfb virtual display in Docker so Chrome runs headful (Google blocks headless OAuth). Stripped unnecessary automation Chrome flags (--disable-extensions, --disable-sync, etc.) to reduce bot detection. Race condition fix: finishLogin guards against re-entry so stop_login from component unmount doesn't override successful auth.
- Both DoorDash and Seamless sessions authenticated on Railway via persistent volume.

**What's next:**
1. **Restart Seamless DOM scraping** — use `--concurrency 4 --resume --sustained --skip-match` (safe on 32GB desktop). ~4,050 restaurants remaining. **Must run in a real terminal** (cmd/PowerShell), NOT Claude Code background task (10-min timeout). Command: `cd C:\Users\ozend\dev\project-kortana\server && npx tsx src/scripts/populate-seamless-menus.ts --concurrency 4 --resume --sustained --skip-match`. If Railway DB gives ECONNRESET on startup, wait a few minutes and retry — connection pool recovers. Monitor via DB: `SELECT COUNT(DISTINCT mi.restaurant_id) FROM menu_items mi JOIN restaurants r ON r.id = mi.restaurant_id WHERE mi.platform = 'seamless' AND mi.created_at > NOW() - INTERVAL '24 hours'`.
2. **Fix Dim Sum Palace DOM scraping** — "View More Items" button not handled, causing incomplete menus on complex restaurants.
3. **Tune dedup scoring for geo matches** — current 0.80 auto-merge threshold produces ~30-40% false positives with real geo data in dense NYC. Options: raise threshold to 0.88-0.90, require menu item overlap as signal, or add address string similarity. Dry run results in `server/data/dedup-dryrun-2026-04-04.txt`.
4. **Re-run dedup** after scoring is tuned — 1,496 DD-only restaurants now have real addresses for geo matching against 5,574 SL-only restaurants.
5. Run cross-platform item matching after both menus are populated and dedup is finalized
6. Implement savings tracking (log comparisons/orders to DB)
7. **Create pg_trgm index** when Railway disk has space: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_menu_items_name_trgm ON menu_items USING gin (canonical_name gin_trgm_ops)` — accelerates menu item search ILIKE queries.
8. **Monitor Railway Postgres storage** — check: `SELECT pg_size_pretty(pg_database_size(current_database()))`

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stack | React + Express + PostgreSQL + Playwright | Need persistent browser sessions for platform APIs — serverless (Vercel) can't maintain Playwright instances |
| Hosting | Express on Railway, React on Vercel or Railway static | Railway supports persistent processes + managed Postgres |
| Platform API approach | DoorDash: GraphQL (reliable, no ghost items). Seamless: DOM scraping via fresh-tab incremental scroll (REST API unreliable). | DoorDash storepageFeed returns exactly what's on the website. Seamless API returns ghost items from inactive menus. DOM scraping gets exactly what the user sees — proven on Dim Sum Palace (236 items, 17 categories). |
| Menu data source of truth | DoorDash for ghost filtering | DoorDash API verified accurate (0 ghost items). When both platforms present, SL-only items (no DD match) are hidden from unified menu as likely ghosts. SL items matched to DD items are shown. |
| Seamless DOM scraping | Headful Chrome + fresh tab + MutationObserver + per-item h3 tracking + popup auto-close | HeadlessChrome gets empty menus (API detects UA). Headful Chrome + MutationObserver captures virtualized items during scroll. Per-item category via h3 position. `item_search` endpoint supplements with ~5% extra items (needs portal login). Page-level popup handler auto-closes Rokt/Stripe popups (must use `scrapePage.on('popup')` not `context.on('page')` to avoid cross-worker interference with concurrency). |
| Auth model | Portal-based login via CDP screencast — users complete Google OAuth in the Kortana web UI | Chrome runs headful on all platforms (Google blocks headless OAuth). On Linux: Xvfb virtual display. On Windows/macOS: Chrome window visible on desktop, user interacts via portal. Login page streamed to frontend canvas via WebSocket. Popup handling switches screencast to OAuth popups and back. |
| Deduplication | Multi-key blocking (exact name, geohash, prefix, phone) + Jaro-Winkler scoring | O(n) blocking replaces O(n²) brute force. 512x fewer comparisons, <1s scoring. Same confidence thresholds (0.80 auto-merge, 0.60 review). |
| Menu refresh | Daily batch sync at 3 AM ET | Balances data freshness vs bot detection risk. Fees are fetched real-time at comparison time |
| Storage budget | Railway Postgres volume capped at 500 MB (Hobby plan). Projected ~75% after full Seamless menu population. If approaching 450 MB, drop `menus.raw_data` (redundant with parsed menu_items). Monitor with `pg_database_size()` during bulk operations. |
| Price comparison scope | Item price + delivery fee + service fee | Does not include tip estimate or subscription benefits (DashPass etc.) in MVP |
| Comparison UX | Build order once, see total per platform | Not side-by-side menu browsing — unified menu with per-platform prices per item |
| Order placement (Phase 1) | Manual — redirect to platform URL | Auto-ordering comes in Phase 2 |
| Chrome sharing | Server yields CDP port to populate script | Server checks if Chrome is already running on the CDP port before initializing an adapter. If occupied (populate script), skips that adapter entirely. Two Playwright instances on the same Chrome context cause page interference (navigation destroys execution contexts). Per-scrape popup handlers in getMenuFromDOM handle ad popups during active scraping. |
| Session checking | `checkSession()` for all periodic/passive checks | `checkSession()` uses cookies (DD) or localStorage (SL) — no page creation, no navigation. `isLoggedIn()` only used for fresh Chrome initialization (one-time). Prevents popup storms from ad iframes on platform homepages. |

## Build Phases

**Phase 1 — Personal MVP (Weeks 1-4)**
DoorDash + Seamless. Search, deduplicate, unified menu, cart builder, price comparison, manual order redirect. Single user (Dan), credentials in env vars.

**Phase 2 — Auto-Routing (Weeks 5-8)**
Programmatic cart building and checkout on cheapest platform. Savings tracker dashboard.

**Phase 3 — Uber Eats (Weeks 9-12)**
Reverse-engineer Uber Eats GraphQL API. Three-way comparison.

**Phase 4 — Public Product (Weeks 13-20)**
Account linking, credential vault (AES-256), user accounts, Stripe subscription billing, 20 free orders → $10/month.

## Platform API Reference

### DoorDash
- **Type:** GraphQL at doordash.com/graphql
- **Auth:** Email + OTP → session cookies in persistent Chrome profile
- **Protection:** Cloudflare TLS fingerprinting — must use real Chrome via spawn + connectOverCDP (same as Seamless). Playwright's launchPersistentContext triggers bot detection.
- **Browser approach:** Real Chrome spawned headless (--headless=new) on CDP port 9224. Dedicated API tab with route blocking (only allows /graphql + document requests) prevents DoorDash SPA from navigating and destroying page.evaluate context. Login handled via CDP screencast streamed to Kortana portal.
- **Key queries:** homePageFacetFeed (search), storepageFeed (menu), addCartItem, createOrderFromCart
- **Search response format:** Facet component system. Stores identified by `component.id === 'card.store'` (changed from `row.store` circa 2026-04). Name in `text.title`, store ID in `custom` (JSON string, key `store_id`), rating in `custom.rating.average_rating`, ETA in `text.description`, URL in `events.click.data` (JSON). Pagination cursor in `page.next.data` (JSON string with base64 `cursor` field).
- **Rate limiting:** DoorDash returns 429 aggressively. graphqlQuery retries with 4-15s exponential backoff. All adapter methods add 2-3s delays between calls.
- **Fee extraction:** Read queries (search, menu) use the API tab. Cart mutations (addCartItem, detailedCartItems/orderCart) use the MAIN tab navigated to the store page, which has full DoorDash JS context. `detailedCartItems` calls `PreviewOrderV2` on the backend, which returns real subtotal + total with fees computed. Individual fee line items (delivery, service) may be null — compare using total. Falls back to estimated fees (15% service + $2.99 delivery) if live cart fails.
- **Session persistence:** ~/.kortana/doordash-profile/

### Seamless / Grubhub
- **Type:** REST API at api-gtm.grubhub.com
- **Auth:** Google OAuth (or email/password) → auth token stored in localStorage (`grub-api:authenticatedSession` → `sessionHandle.accessToken`). API calls require `Authorization: Bearer <token>` header.
- **Protection:** PerimeterX bot detection — must use browser-based fetch (page.evaluate) to inherit cookies and bypass detection. Direct Node.js fetch does NOT work.
- **Browser approach:** Must use real Chrome via `spawn` + Playwright `connectOverCDP` — NOT `launchPersistentContext`. Playwright-managed Chromium triggers Google's "browser not secure" block during OAuth, and Chrome's "controlled by automated software" banner. CDP connection avoids both issues.
- **Key endpoints (confirmed):** /restaurants/search (search), /restaurants/{id}/menu_items (menu), /carts (create cart), /carts/{id}/lines (add items), /carts/{id}/delivery_info (set address — requires administrative_area, locality, postal_code, coordinates as strings, plus email/phone), /carts/{id}/bill (fee breakdown)
- **Menu scraping (DOM):** REST API is unreliable for menus (ghost items). `getMenuFromDOM()` opens a FRESH TAB, scrolls with MutationObserver to capture items from virtualized DOM. **HEADFUL Chrome required** — HeadlessChrome gets empty categories from API. Category tracking via h3 viewport position (headers and items in separate DOM branches). Item IDs from `data-testid="Item{id}"`. Delivery address must be set or API returns empty. "View more items" buttons load more categories, not items. Proven: 208 items from Dim Sum Palace (83% DD match rate).
- **item_search endpoint:** `restaurant_gateway/info/item_search/volatile/{id}?inMenuSearchQuery={query}&platform=WEB` — returns items not in category feeds (~10 extra for Dim Sum Palace including Bbq Pork Buns, Chicken Feet). Requires full portal login session (not just localStorage Bearer token). Use to supplement category feed data for unmatched DD items.
- **Session persistence:** ~/.kortana/seamless-profile/ (Chrome user data dir, survives restarts)
- **Note:** Grubhub acquired by Wonder (Marc Lore) in 2024 for $650M. API surface may evolve.
- **Full endpoint catalog:** See `server/src/adapters/seamless/endpoints/_manifest.json` for all 40+ captured endpoints
- **Test restaurant:** Dim Sum Palace (SL ID: 1387494, 33 W 33rd St). URL: seamless.com/menu/dim-sum-palace-33-w-33rd-st-new-york/1387494

### Uber Eats (Phase 3)
- **Type:** GraphQL at uber.com
- **Auth:** sid/csid cookies (separate from Uber rides auth)
- **Status:** Less publicly documented. Requires manual DevTools capture during Phase 3.

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file. Living project context for Claude Code sessions. Update as project evolves. |
| `SPEC.md` | Full technical specification with data model, adapter interface, API endpoints, project structure, and definition of done. Reference during implementation. |
| `server/src/adapters/types.ts` | Platform adapter interface. All platform adapters implement this contract. |
| `server/src/adapters/doordash/queries/` | Captured GraphQL queries + response samples (28 operations from HAR capture) |
| `server/src/adapters/doordash/queries/_manifest.json` | Index of all captured DoorDash operations with call counts |
| `server/src/adapters/seamless/endpoints/` | Captured Seamless/Grubhub REST API endpoint samples (40+ request/response pairs) |
| `server/src/adapters/seamless/endpoints/_manifest.json` | Index of all captured Seamless API endpoints |
| `server/src/scripts/parse-har.ts` | Script to extract GraphQL queries from Chrome HAR files (DoorDash) |
| `server/src/scripts/parse-seamless-har.ts` | Script to extract REST endpoints from Chrome HAR files (Seamless) |
| `server/src/scripts/seed-from-har.ts` | Seed DB with DoorDash restaurant/menu data from captured responses |
| `server/src/scripts/seed-seamless-from-har.ts` | Seed DB with Seamless menu data from captured responses |
| `server/src/db/migrations/` | SQL migration files (001-006), run via `npm run migrate` from server/ |
| `server/src/services/auth-manager.ts` | Auth orchestrator: CDP screencast streaming, login flow management, session monitoring |
| `server/src/services/ws-server.ts` | WebSocket server for real-time browser frame streaming and input forwarding |
| `server/src/routes/auth.ts` | REST endpoints for auth status and logout |
| `server/src/utils/chrome.ts` | Cross-platform Chrome path detection and spawn arg builder |
| `client/src/components/SettingsPage.tsx` | Platform connection management UI |
| `client/src/components/BrowserView.tsx` | Canvas-based browser view with CDP screencast rendering and input forwarding |
| `Dockerfile` | Docker build with Google Chrome for Railway deployment |
| `railway.toml` | Railway deployment config: Dockerfile builder, healthcheck, restart policy |
| `.dockerignore` | Excludes node_modules, dist, .env, .git from Docker build context |
| `client/src/app.css` | Design system: color tokens, font imports (Instrument Serif, DM Sans, JetBrains Mono), animations, receipt-style utilities |
| `server/src/scripts/discover-seamless.ts` | Seamless bulk restaurant discovery via Manhattan grid search (35 points) |
| `server/src/scripts/discover-doordash.ts` | DoorDash 3-pass discovery (deep pagination + cuisine verticals + text search) with checkpoint/resume, early termination, --enrich for addresses |
| `server/src/scripts/run-dedup.ts` | Cross-platform restaurant deduplication runner with --dry-run support |
| `server/src/scripts/refresh-menus.ts` | Fetch live menus from adapters, upsert to DB, run item matching |
| `server/src/scripts/populate-seamless-menus.ts` | Seamless menu bulk population with --matched-only, --limit, --resume, --dry-run, --concurrency N. Marks ghost restaurants as delisted |
| `server/src/services/menu-upsert.ts` | Shared upsertMenu() with batched INSERTs (used by refresh-menus.ts and populate script) |
| `server/src/scripts/populate-doordash-menus.ts` | DoorDash menu bulk population + address enrichment. Extracts address/phone from storepageFeed response. Flags: --matched-only, --limit, --resume, --sustained, --dry-run, --skip-match, --restaurant-id. Pre-spawns headful Chrome, uses mainTabGraphqlQuery |
| `server/scripts/run-doordash-populate.sh` | Auto-restart wrapper for DoorDash menu population (90s cooldown, 50 max restarts) |
| `server/src/services/deduplication.ts` | Blocking-based O(n) restaurant dedup: 4 blocking strategies (exact name, geohash, prefix, phone) + Jaro-Winkler scoring |
| `server/src/scripts/test-seamless-dom.ts` | Seamless DOM scraping diagnostic: tests SPA auth, navigates to restaurant, captures network requests, reports DOM state. Usage: `npx tsx src/scripts/test-seamless-dom.ts --restaurant-id 1387494` |
| `server/src/services/menu-utils.ts` | Shared Union-Find grouping + ghost filtering for unified menus. Used by menus.ts and menu-items.ts |
| `server/src/routes/menu-items.ts` | `GET /api/menu-items/search` — dish search by name, grouped by restaurant, with bounding box + ghost filtering |
| `client/src/components/ItemSearchResult.tsx` | Receipt-style item search result card with per-platform prices |

## Competitive Landscape

- **MealMe** — Started as exact same concept (consumer price comparison), pivoted to B2B API. Now provides ordering infrastructure to TripAdvisor, Favor, etc. Their API could theoretically be used as Kortana's data layer, but pricing is enterprise/custom.
- **FoodBoss** — Compares delivery fees only, not item-level pricing or total order cost. Redirects to platform (no ordering). Limited traction.
- **Nobody does item-level + fee-level comparison with auto-routing.** The consumer opportunity is genuinely open.

## Business Model

- 20 free auto-routed orders (enough to demonstrate ~$40-60 in savings)
- $10/month subscription after trial
- Target: NYC power users ordering 5+ times/month
- 5,000 subscribers = $50K/month recurring revenue
- Data asset (cross-platform pricing patterns) may be worth more than subscription revenue long-term

## Development Environment

- **Desktop repo path:** C:\Users\ozend\dev\project-kortana
- **GitHub:** github.com/ozendaniel/project-kortana
- **Node.js:** v24.14.0
- **Database:** Railway Postgres (connection string in .env, not committed)
- **Other repos at C:\Users\ozend\dev\:** cool-habits, danaibot-email-agent, investment-banker-outreach
- **Tools:** Claude Code, VS Code, Git, npm
- **Run locally:** `npm run dev` from root (starts server on :3001 + client on :5173), or `cd server && npx tsx src/index.ts` and `cd client && npx vite` separately
- **Run migrations:** `cd server && npm run migrate`
- **Seed test data:** `cd server && npx tsx src/scripts/seed-from-har.ts`
- **Capture DoorDash queries:** Have user export HAR from Chrome DevTools, then `cd server && npx tsx src/scripts/parse-har.ts <path-to-har>`
- **Railway deployment:** `railway up` from project root to deploy. Service: kortana-web. URL: kortana-web-production.up.railway.app. Persistent volume at `/data` for Chrome profiles. Railway CLI installed globally (`@railway/cli@4.35.2`).
- **Redeploy:** `cd project-kortana && railway up` — builds via Dockerfile, ~75s. Check status: `railway service status`. Logs: `railway logs`.
- **Letta (Claude Subconscious):** Running as a passive observer across Claude Code sessions to build persistent cross-session context. `.letta/` directory is gitignored — local runtime only, configure separately per machine.

## Conventions

- TypeScript throughout (server and client)
- All prices stored in cents (integer) to avoid float issues
- Platform adapter pattern: every platform implements the same interface
- Environment variables for credentials (Phase 1), encrypted DB storage (Phase 4)
- WIP commits are fine — clean up with rebase before any public release
- Frontend design: "Noir Receipt" dark theme. Colors/fonts defined as CSS custom properties in `app.css` via Tailwind `@theme`. Use `font-display` (Instrument Serif) for headings, `font-mono` (JetBrains Mono) for prices/data, `font-body` (DM Sans) for UI. Platform prices always ordered DoorDash first, Seamless second.

## Reminders for Claude Code Sessions

- Always read SPEC.md for data model, adapter interface, and API endpoint contracts before implementing
- DoorDash adapter is the priority — most documented, existing MCP server code to reference
- Test Seamless with direct HTTP before defaulting to Playwright — may not need browser automation
- All menu prices are in cents. All fee calculations in cents. Convert to dollars only in the frontend display layer.
- Restaurant dedup: fuzzy matching threshold 0.80+ for auto-merge, 0.60-0.80 for review
- Menu item matching: Two-pass. Pass 1: nameScore × priceAgreement × categoryBoost (min name 0.85, min combined 0.78, cross-category ≥ 0.93). Pass 2: description-enriched for unmatched items (appends item description to name, min name 0.83). Both passes use 1-to-1 greedy matching, DD items de-duped by platform_item_id. Price is the key disambiguation signal — platforms collapse variant names and split info between name/description differently.
- Rate limit platform API calls: 2-3 second spacing, randomized intervals
