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
- Railway Postgres provisioned and all 4 migrations applied (restaurants, menus, menu_items, orders)
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

**What's next:**
1. Build automated deduplication pipeline (fuzzy matching restaurants + menu items across platforms)
2. Seed more restaurants for broader NYC coverage
3. Implement savings tracking (log comparisons/orders to DB)

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stack | React + Express + PostgreSQL + Playwright | Need persistent browser sessions for platform APIs — serverless (Vercel) can't maintain Playwright instances |
| Hosting | Express on Railway, React on Vercel or Railway static | Railway supports persistent processes + managed Postgres |
| Platform API approach | Reverse-engineered internal APIs via Playwright | No official consumer APIs exist. DoorDash uses GraphQL, Seamless uses REST. Pattern proven by DoorDash MCP servers on GitHub |
| Auth model (public product) | Account linking (Artemis model) — users provide platform credentials | Same pattern used by Artemis/AutoRes for Resy/OpenTable. Store tokens, discard raw passwords |
| Deduplication | Automated fuzzy matching (Jaro-Winkler + geocoding + menu fingerprinting) | All-NYC scope requires automated matching from day one |
| Menu refresh | Daily batch sync at 3 AM ET | Balances data freshness vs bot detection risk. Fees are fetched real-time at comparison time |
| Price comparison scope | Item price + delivery fee + service fee | Does not include tip estimate or subscription benefits (DashPass etc.) in MVP |
| Comparison UX | Build order once, see total per platform | Not side-by-side menu browsing — unified menu with per-platform prices per item |
| Order placement (Phase 1) | Manual — redirect to platform URL | Auto-ordering comes in Phase 2 |

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
- **Browser approach:** Real Chrome spawned on CDP port 9224. Dedicated API tab with route blocking (only allows /graphql + document requests) prevents DoorDash SPA from navigating and destroying page.evaluate context.
- **Key queries:** homePageFacetFeed (search), storepageFeed (menu), addCartItem, createOrderFromCart
- **Search response format:** Facet component system. Stores identified by `component.id === 'row.store'`. Name in `text.title`, store ID in `custom` (JSON string, key `store_id`), rating in `custom.rating.average_rating`, ETA in `text.custom[key='eta_display_string']`, URL in `events.click.data` (JSON).
- **Rate limiting:** DoorDash returns 429 aggressively. graphqlQuery retries with 4-15s exponential backoff. All adapter methods add 2-3s delays between calls.
- **Fee extraction:** Read queries (search, menu) use the API tab. Cart mutations (addCartItem, detailedCartItems/orderCart) use the MAIN tab navigated to the store page, which has full DoorDash JS context. `detailedCartItems` calls `PreviewOrderV2` on the backend, which returns real subtotal + total with fees computed. Individual fee line items (delivery, service) may be null — compare using total. Falls back to estimated fees (15% service + $2.99 delivery) if live cart fails.
- **Session persistence:** ~/.kortana/doordash-profile/

### Seamless / Grubhub
- **Type:** REST API at api-gtm.grubhub.com
- **Auth:** Google OAuth (or email/password) → auth token stored in localStorage (`grub-api:authenticatedSession` → `sessionHandle.accessToken`). API calls require `Authorization: Bearer <token>` header.
- **Protection:** PerimeterX bot detection — must use browser-based fetch (page.evaluate) to inherit cookies and bypass detection. Direct Node.js fetch does NOT work.
- **Browser approach:** Must use real Chrome via `spawn` + Playwright `connectOverCDP` — NOT `launchPersistentContext`. Playwright-managed Chromium triggers Google's "browser not secure" block during OAuth, and Chrome's "controlled by automated software" banner. CDP connection avoids both issues.
- **Key endpoints (confirmed):** /restaurants/search (search), /restaurants/{id}/menu_items (menu), /carts (create cart), /carts/{id}/lines (add items), /carts/{id}/delivery_info (set address — requires administrative_area, locality, postal_code, coordinates as strings, plus email/phone), /carts/{id}/bill (fee breakdown)
- **Session persistence:** ~/.kortana/seamless-profile/ (Chrome user data dir, survives restarts)
- **Note:** Grubhub acquired by Wonder (Marc Lore) in 2024 for $650M. API surface may evolve.
- **Full endpoint catalog:** See `server/src/adapters/seamless/endpoints/_manifest.json` for all 40+ captured endpoints

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
| `server/src/db/migrations/` | SQL migration files (001-004), run via `npm run migrate` from server/ |

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
- **Letta (Claude Subconscious):** Running as a passive observer across Claude Code sessions to build persistent cross-session context. `.letta/` directory is gitignored — local runtime only, configure separately per machine.

## Conventions

- TypeScript throughout (server and client)
- All prices stored in cents (integer) to avoid float issues
- Platform adapter pattern: every platform implements the same interface
- Environment variables for credentials (Phase 1), encrypted DB storage (Phase 4)
- WIP commits are fine — clean up with rebase before any public release

## Reminders for Claude Code Sessions

- Always read SPEC.md for data model, adapter interface, and API endpoint contracts before implementing
- DoorDash adapter is the priority — most documented, existing MCP server code to reference
- Test Seamless with direct HTTP before defaulting to Playwright — may not need browser automation
- All menu prices are in cents. All fee calculations in cents. Convert to dollars only in the frontend display layer.
- Fuzzy matching threshold: 0.80+ confidence for auto-merge, flag 0.60-0.80 for review
- Rate limit platform API calls: 2-3 second spacing, randomized intervals
