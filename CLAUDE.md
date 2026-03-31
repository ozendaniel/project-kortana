# Project Kortana

## Session Rules

- Compact the context window whenever usage reaches 40%. Summarize key decisions and current working state before compacting.

## What This Is

A food delivery price comparison and order routing platform. Users search restaurants across DoorDash and Seamless (Uber Eats in Phase 3), build an order once, and see the total price (items + delivery fee + service fee) on each platform side by side. The platform routes the order to the cheapest option.

Personal tool first. Public subscription product ($10/month after 20 free orders) later.

## Owner

Dan Ozenne — building solo with Claude Code. PE background (O3 Industries). NYC-based.

## Current Status

**Phase:** Pre-build. Technical spec complete, architecture locked in, API research done. Ready to scaffold and start coding.

**What's been done (in planning conversations):**
- Full competitive landscape research (MealMe pivoted to B2B API, FoodBoss is superficial — consumer "Kayak for food delivery" opportunity is unoccupied)
- Reverse-engineered API feasibility confirmed for all three platforms
- Technical spec written (see SPEC.md in this repo)
- Architecture, data model, adapter interface, and build phases defined
- Business model validated: average $2-3 savings per order makes $10/month a clear win at 5+ orders/month

**What's next:** Scaffold project structure, get PostgreSQL running on Railway, implement DoorDash adapter first.

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
- **Auth:** Email + OTP → session cookies in persistent Chromium profile
- **Protection:** Cloudflare TLS fingerprinting — must use real browser context (Playwright page.evaluate)
- **Key queries:** homePageFacetFeed (search), storepageFeed (menu), addCartItem, createOrderFromCart
- **Starting point:** Fork GraphQL queries from existing DoorDash MCP servers on GitHub (search "doordash-mcp" by ashah360 or SpunkySarb)
- **Session persistence:** ~/.kortana/doordash-profile/

### Seamless / Grubhub
- **Type:** REST API (conventional endpoints)
- **Auth:** Email + password → session cookie
- **Key endpoints (capture via DevTools):** /restaurants/search, /restaurant/{id}/menu, /cart/add, /cart/checkout_summary
- **Note:** Grubhub acquired by Wonder (Marc Lore) in 2024 for $650M. API surface may evolve.
- **May not need Playwright:** If REST calls work with just session cookie, direct Node.js fetch is lighter

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
| `server/src/adapters/doordash/queries/` | Captured GraphQL query files for DoorDash API |

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
- **GitHub:** github.com/ozendaniel (to be created for this project)
- **Other repos at C:\Users\ozend\dev\:** cool-habits, quartr_transcripts
- **Tools:** Claude Code, VS Code, Git, npm

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
