# Farmstand v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker + D1 app where customers reserve farmstand items and pay cash at pickup, and sellers pack orders and reconcile the honour box with a visit.

**Architecture:** One Hono Worker renders plain HTML (forms POST and redirect, so everything works without JavaScript). D1 holds stock, holds and orders; every order transition is one `DB.batch()` whose statements are guarded by the expected status, with a `CHECK (held <= stock)` constraint as the last line of defence against overselling. A small `public/app.js` adds steppers, live totals, refresh, the visit draft and Save link.

**Tech Stack:** TypeScript 7.0.2, Hono 4.13.13, Wrangler 4.152.0, Vitest 4.1.12 + `@cloudflare/vitest-plugin` 1.4.7 (tests in workerd with local D1), uqr 0.1.3.

**Spec:** `docs/superpowers/specs/2026-11-07-farmstand-design.md` (design council 9.6/10).

## Global Constraints

- Money is integer cents everywhere. Cash amounts round with `roundCash(cents, CASH_ROUND_CENTS)`; default step 5.
- Times are epoch milliseconds in the database; displayed in `TIMEZONE` (default `America/Halifax`).
- "Units" of an order line = `packed_qty ?? qty`.
- Every order transition: one batch; each item statement guarded by `EXISTS (SELECT 1 FROM orders WHERE id = ? AND status IN (...))`; the order's own status update is the **last** statement; zero changes on it means "stale, nothing applied".
- Stock writes are deltas (`stock = stock + ?`), never absolute.
- No external fonts or scripts except Turnstile (off by default). CSP: `default-src 'self'`.
- Pages work at 360 px, tap targets ≥ 48 px, inputs 16 px, every input labelled.
- Customer-facing copy is taken verbatim from the spec's "Screens, states and words".

## Review Focus

1. Two orders for the last unit at once: exactly one succeeds; the other sees "Someone just took the last …" and nothing is held.
2. A double tap on Reserve: one order (same `idem_key`), second tap lands on the same order page.
3. A visit with a blank count: that item's stock and tally are untouched.
4. A customer cancels after Ready, then a visit counts: the basket is unpacked first, so walk-in sales are not inflated.
5. A visit submitted twice (retry after lost signal): one visit row, holds and stock applied once.

## File Structure

| File | Responsibility |
|---|---|
| `wrangler.jsonc`, `package.json`, `tsconfig.json`, `vitest.config.ts` | Config. D1 binding `DB` without `database_id`; assets from `public/`; cron for scrub |
| `migrations/0001_init.sql` | Schema from the spec |
| `src/env.d.ts` | Secret types on top of generated `worker-configuration.d.ts` |
| `src/money.ts` | `roundCash`, `formatMoney`, `parseMoney` |
| `src/codes.ts` | `randomToken`, `sha256Hex`, `orderCode` |
| `src/types.ts` | Row types |
| `src/db.ts` | Shared reads (stand by slug, items, order by token, lines, open orders) |
| `src/orders.ts` | `placeOrder`, `packOrder`, `pickUpOrder`, `releaseOrder`, `cancelOrder`, `markNotFound`, `reopenOrder`, `clearUnpack` |
| `src/items.ts` | `addItem`, `editItem`, `adjustStock`, `setSoldOut`, `setHidden` |
| `src/visit.ts` | `computeVisit` (pure), `saveVisit`, `weekSummary` |
| `src/auth.ts` | `sellerFromToken`, `standForSeller` |
| `src/views/*.ts` | `layout`, stand, order, admin, visit, sign, message pages |
| `src/index.ts` | Hono routes, security headers, `scheduled` scrub |
| `public/style.css`, `public/app.js` | Styling and progressive enhancement |
| `scripts/admin.ts` | Operator CLI over `wrangler d1 execute` |
| `test/*.test.ts`, `test/apply-migrations.ts`, `test/helpers.ts` | Tests |

---

### Task 1: Scaffold, schema and money

**Files:** config files above, `migrations/0001_init.sql`, `src/money.ts`, `src/codes.ts`, `src/types.ts`, `test/money.test.ts`, `test/codes.test.ts`, `test/apply-migrations.ts`

**Produces:** `roundCash(cents: number, step: number): number`, `formatMoney(cents: number): string` ("$14.00", "-$2.00"), `parseMoney(s: string): number | null` ("35", "35.5", "$35.50" → cents), `randomToken(bytes?: number): string` (base64url), `sha256Hex(s: string): Promise<string>`, `orderCode(): string` (`/^[A-Z]{3,5}-\d{2}$/`, nature word list).

- [ ] Install pinned dev dependencies; run `npx wrangler types`.
- [ ] Test: `roundCash` for totals ending 0–9¢ with step 5 → 1,2 down; 3,4 up; 6,7 down; 8,9 up (e.g. 1398 → 1400, 1392 → 1390). `parseMoney("abc")` → null.
- [ ] Test: `orderCode()` matches the pattern over 200 calls; `randomToken()` length ≥ 32.
- [ ] Test: migrations apply; inserting an item with `held > stock` throws.
- [ ] Implement; `npm test` passes; commit.

### Task 2: Orders

**Files:** `src/db.ts`, `src/orders.ts`, `test/helpers.ts`, `test/orders.test.ts`

**Consumes:** Task 1. **Produces:**
- `placeOrder(db, stand, input: { idemKey; name; contact; whenNote; qty: Record<number, number> }, opts: { roundStep: number; now: number }): Promise<{ ok: true; token: string } | { ok: false; kind: 'invalid' | 'sold_out' | 'closed'; message: string }>`
- `packOrder(db, orderId, packed: Record<number, number>, now): Promise<'ready' | 'released' | 'stale'>`
- `pickUpOrder(db, orderId, by: 'seller' | 'customer' | 'visit', now): Promise<boolean>` (seller from placed or ready; customer and visit from ready)
- `releaseOrder`, `cancelOrder`, `markNotFound(db, orderId, now): Promise<boolean>`
- `reopenOrder(db, orderId, now): Promise<'ok' | 'not_allowed' | 'no_stock'>`, `clearUnpack(db, orderId): Promise<void>`

- [ ] Tests: place ok (held up, total, cash rounded); name missing → invalid with the spec message; qty above `max_per_item` → invalid; paused/inactive → closed; sold-out flag → invalid; **race**: two `placeOrder` for the last unit via `Promise.all` → one ok, one `sold_out` with message naming the item, `held == stock`; **idem**: same `idemKey` twice → same token, one order row.
- [ ] Tests: pack short 3→2 lowers stock and held by 1, tally +1, total and cash recomputed; all-zero pack → released, `reopen_ok = 0`; pickup lowers stock and held by units; release from ready → `to_unpack = 1`, from placed → 0; cancel and not_found set status and `to_unpack` after Ready; reopen picked_up → ready restores stock and held; reopen refused when the stock is gone (`no_stock`) and for a couldn't-fill release (`not_allowed`); any transition on a closed order → stale/false and changes nothing.
- [ ] Implement with the guarded-batch pattern; tests pass; commit.

### Task 3: Items

**Files:** `src/items.ts`, `test/items.test.ts`

**Produces:** `addItem(db, standId, { name; unit; priceCents; stock })`, `editItem(db, standId, itemId, { name; unit; priceCents })`, `adjustStock(db, standId, itemId, seen: number, next: number): Promise<{ ok: true } | { ok: false; message: string }>`, `setSoldOut(db, standId, itemId, on: boolean)`, `setHidden(db, standId, itemId, hidden: boolean)`.

- [ ] Tests: adjust below held → `{ ok: false, message: "3 are held for orders." }`; adjust is a delta (concurrent pickup between read and write is kept); sold out leaves stock unchanged; wrong stand id changes nothing.
- [ ] Implement; commit.

### Task 4: Visit

**Files:** `src/visit.ts`, `test/visit.test.ts`

**Produces:**
- `computeVisit(items: VisitItem[], entries: Record<number, { counted: number | null; removed: number; restocked: number }>, confirmed: boolean): VisitPlan` where `VisitItem = { id; name; priceCents; stock; held; shortSinceVisit; inBaskets }` and `VisitPlan = { lines: VisitLinePlan[]; needsConfirm: { itemId; counted; expected }[]; errors: { itemId; message }[]; walkinCents }`.
- `saveVisit(db, stand, form: VisitForm, opts: { now; roundStep }): Promise<{ ok: true; visitId } | { ok: false; needsConfirm?; errors? }>`; `VisitForm = { visitKey; unpack: number[]; gone: number[]; pack: Record<orderId, Record<itemId, number>>; entries; cashCounted: number | null; confirmed: boolean }`.
- `weekSummary(db, standId, now): Promise<{ shelfCents; appCents; diffCents }>`.

- [ ] Pure tests: blank count → no change, tally kept, restock still applied; `walk_in_sold = max(0, stock − present) + tally`; found 2 more → corrected, no confirm; found 36 more on expected 4 → needsConfirm unless confirmed; removed > counted → error; removed without count → error.
- [ ] Worked example test (spec numbers): eggs stock 10, 3 in a Ready basket, counted 4 → 3 walk-in; tomatoes stock 8, counted 5 → 3 walk-in; Bob's $10 app pickup; counted cash $35 → expected $37, diff −$2. Also an unpack row and a gone basket in the same visit.
- [ ] Idempotency test: same `visitKey` twice → one visit row, stock applied once.
- [ ] Sold-out flag cleared when free > 0 after the visit; `last_counted_at` set only when an item was counted.
- [ ] Implement (predict in-basket units first; confirm check before any write; phase 1 order transitions; phase 2 one batch of deltas + visit rows); commit.

### Task 5: Customer pages

**Files:** `src/views/layout.ts`, `src/views/stand.ts`, `src/views/order.ts`, `src/views/message.ts`, `src/index.ts`, `public/style.css`, `public/app.js`, `test/routes.test.ts`

- [ ] Route tests: `GET /hillside` 200 with "about 7 left"; unknown slug 404 "No stand at this address"; paused shows "Online orders are paused." + message; switched off shows "This stand isn't taking online orders right now."; `POST /hillside/order` → 303 to `/o/<token>`; order page placed wording "Reserved. Don't come yet"; ready short shows "(was $15.00)"; released-from-ready wording; `GET /o/<token>/v` JSON; security headers present.
- [ ] Implement views with the spec's copy; app.js steppers, live total, refresh, Save link, open-order banner; commit.

### Task 6: Seller pages, sign, export

**Files:** `src/auth.ts`, `src/views/admin.ts`, `src/views/visit.ts`, `src/views/sign.ts`, routes in `src/index.ts`, tests in `test/routes.test.ts`

- [ ] Route tests: unknown or revoked token → 404 while another link for the same seller works; other seller's stand → 404; admin shows next-action line and first-run checklist on an empty stand; pack/pickup/release/reopen/unpack POSTs redirect back and change state; visit POST without confirm on a large found-more re-renders the confirm text; `orders.csv` and `visits.csv` content types and header rows; sign contains an SVG QR and the stand URL.
- [ ] Implement; visit draft and fetch-submit in app.js; commit.

### Task 7: Operator CLI, scrub, README

**Files:** `scripts/admin.ts`, `scripts/seed-dev.sql`, `src/index.ts` (`scheduled`), `test/scrub.test.ts`, `README.md`, `.dev.vars.example`

- [ ] Scrub test: closed order older than 30 days loses name, contact and note; totals stay; open orders untouched.
- [ ] CLI: `seller add`, `stand add`, `link add` (prints URL), `link revoke`, `stand off|on`, `list`; `--remote` flag; SQL literals escaped. Smoke-run against `--local`.
- [ ] README: what it is, screenshots, deploy button, self-hosting, operator commands, privacy note. Commit.

### Task 8: End-to-end and land

- [ ] `npm run typecheck && npm test` green.
- [ ] `wrangler dev` + built-in browser at 360 px through the spec's end-to-end script; screenshots.
- [ ] Fresh `/code-review` subagent (≤ 3 rounds); PR to `main` with Testing / Risk / How to revert / Reviewed-by; land with `land_pr.py`.
