# Farmstand: reserve online, pay cash at pickup

## Context

Dan wants an MIT-licensed pickup app for cash businesses, starting with farmstands. A
customer picks what is available and sees how much cash to bring. The seller packs a
basket. Nobody pre-pays, so a basket is a soft hold that the seller can release.

First users are real: one staffed farmstand and a few unattended (honour-box) stands.
Some farmers run several stands. Dan will host one shared instance and set stands up
himself. Volume is low. He will cut a stand off, or charge, if usage grows.

Prior art: Open Food Network has cash payment, but it is a large Rails app for food hubs
and it is AGPL-3.0 (verified on GitHub), so its code cannot go into an MIT project. Most
farm-stand tools take card payment up front. A cash-first app with no accounts is a gap.

**Goal:** a seller is live in 2 minutes, a customer orders in under 30 seconds with no
account, and a seller can check the whole honour box (walk-ins and app orders) in a
2-minute visit, on a phone, with poor signal.

**Anti-goals:** customer accounts, card payments, notifications that cost money, a native
app install, any setup step that needs the farmer to have a tech account, any screen that
needs instructions.

## Decisions Dan made

| Topic | Decision |
|---|---|
| Hold rule | A reservation takes items off the free count at once. The seller can release a hold any time. |
| First users | One staffed stand, a few unattended stands. Some farmers run several stands. |
| Notices | No messages. Customer keeps a live order page link; seller checks the order list. |
| Hosting | **A: one shared app Dan runs**, `farmstand.fakkeldy.ca/<stand>`, Cloudflare Worker + D1. Public repo also has a "Deploy to Cloudflare" button for self-hosters. |
| GitHub as database | Declined: a write key needs a server anyway, Pages caches ~10 min, git history keeps customer details forever. GitHub holds the code; D1 holds stock and orders. |
| Honour box | **Whole box.** The app works out walk-in sales from stock counts, so the seller can compare expected cash with the box. |
| Pickup day | Only from what is on the stand now. "When I plan to come" stays a free-text note. |
| Repo | `dfakkeldy/farmstand`, public with the MIT licence from the first commit. |

## My calls (Dan: check these while reading)

1. **Customer flow:** QR code on the stand sign or a shared link opens `/<stand>`. No
   install, no account. Name, optional phone number, optional "when I plan to come" note.
2. **Order code** is a short nature word plus two digits, such as `WREN-27`. It is easy to
   say aloud, goes on the basket label, and does not name an item (an item-based code
   would mislead after packing short).
3. **"Come after Ready":** an order is *reserved* when placed and *Ready* when the seller
   packs it. Packing short (only 2 dozen left) lowers stock and held by the difference, so
   the free count does not grow, and adds the units to the item's `short_since_visit` tally
   so the next visit counts them as walk-in sales.
4. **Close-out:** unattended order pages have "I picked it up and left $14". The link works
   from anywhere, so a customer with no signal at the stand can tap it later. The seller can
   mark any order Picked up or Released at either kind of stand. Nothing closes by itself.
5. **Cash total** rounds to the nearest 5¢ (Canadian cash rule) as an app setting
   (`CASH_ROUND_CENTS`, default 5) for self-hosters elsewhere. Prices are what the customer
   pays; no tax math in v1.
6. **Unit pricing only** (a dozen, a bag, a bunch). No price per pound in v1.
7. **Seller login:** one seller (farmer) has one or more stands. Each seller can have
   several secret links, one per person or phone ("Mary's phone", "helper"). A link opens
   all of that seller's stands. Dan revokes one link without locking out the others.
8. **Dan's operator tool** is a CLI script (create seller, stand, link; deactivate; revoke).
9. **Abuse guard:** per-item max per order (default 6). Turnstile is available per stand
   but **off by default** (one more third-party script on a weak signal).
10. **Privacy:** name and optional phone only. A daily cron scrubs contact details from
    closed orders older than 30 days and keeps totals. CSV export of orders and visits.
11. Time zone `America/Halifax` (app setting `TIMEZONE`) for all displayed times.
12. **Walk-in cash uses exact prices.** Walk-ins each round their own payment, so a box
    within $1 of expected shows as "about right".

## Approaches considered

- **A. One shared app Dan runs (chosen).** One place to fix bugs, stands added in minutes,
  stands can be switched off. Cost: Dan holds customer names and phone numbers.
- **B. A copy per stand.** Each farm owns its data, but each farmer needs Cloudflare and
  GitHub accounts, each update is a redeploy per stand, and "cut off or charge" is not
  possible. Still open to anyone through the deploy button.
- Dropped: iOS seller app (customers still need web; App Store review; leaves out Android
  sellers). Google Sheet back end (slow, clunky, weak MIT project). Git as the database.

## Design

### Order lifecycle

```
placed (reserved) --pack--> ready --pickup--> picked_up   stock −= qty, held −= qty
     |                        |
     +--farmer releases-------+--> released                held −= qty
     +--customer cancels------+--> cancelled               held −= qty
                              +--"Basket not there?"--> not_found   held −= qty
A released, cancelled or not_found order that was READY is flagged "to unpack": its units
are no longer held. The seller ticks "Back on shelf" or "Not here" (no math either way:
the next count finds the units on the shelf or counts them as gone from the shelf, which
is where a taken basket was lost).
Reopen: an order closed by the seller today, after the last visit, can be reopened to its
previous status (holds re-applied; refused if the stock is no longer there).
```

### Stock words

- `stock` = all units at the stand (loose on the shelf, in Ready baskets, in baskets to unpack).
- `held` = units reserved by open orders (placed or ready).
- free count shown to customers = `stock − held`.

### The visit (whole-box reconciliation)

One scrolling page, in the order the seller works at the stand. It takes about 2 minutes.

- **A. Unpack:** each row has "Back on shelf / Not here": "WREN-27 (cancelled)", or for a
  not_found order "Look for WREN-27 (customer couldn't find it)". Either choice clears the
  flag; the count that follows does the math.
- **B. Baskets:** Ready baskets, each "Still here / Gone". Gone becomes Picked up
  (closed by the visit, its cash counts as app cash).
- **C. Pack:** waiting orders, each line with a packed-quantity stepper (defaults to the
  full amount) and "Write on the basket: WREN-27 · Alice · $10.00" (the amount updates as
  the seller packs short, so a customer with no signal at the stand still knows what to
  pay). All lines at 0 releases the order ("couldn't fill").
- **D. Count:** per item, loose units on the shelf **before removing anything** (baskets
  not included), then removed (spoiled, taken home; at most counted), then restocked.
  - **Blank is not zero.** A blank count means "not counted": the item keeps its stock and
    its tally, and only a restock (if entered) is applied.
  - Each row shows its result as the seller types: "→ 3 sold" or "→ found 2 more".
  - A large "found more" (more than 3 units and more than half the expected count) needs a
    confirm: the page comes back with "You counted 40 eggs; we expected 7. Is 40 right?"
    and a checkbox. This works without JavaScript.
  - `present = counted + units in Ready baskets (after C)`
  - `walk_in_sold = max(0, stock − present) + short_since_visit` (tally resets)
  - `present > stock` shows "found N more than expected" and corrects stock
  - `stock = present − removed + restocked`, written as a delta (`stock = stock + ?`) so a
    pickup tapped at the same moment is not lost. Because C packs every waiting order, the
    new stock cannot fall below held; if an order arrives mid-visit and it would, the page
    says "A new order came in while you counted" and keeps the draft.
- **E. Cash (optional):** count and empty the box.
  `expected = Σ walk_in_sold × price (all visits since the last cash count) + Σ cash of
  app orders picked up since the last cash count`.

**Summary:** walk-in sold per item; "Box about right" (within $1), "$2.00 short" or
"$3.00 over"; and one line for the last 7 days: "This week: $142 shelf · $38 app · $3 short".

**Poor signal:** the visit form keeps a draft on the phone (localStorage) as it is filled.
It submits once with a `visit_key`, so a retry never makes two visits. Without signal the
button reads "Not sent yet, tap to retry"; after success, "Saved".

### Screens, states and words

Customer wording is plain and says what to do next. Each live page shows "Updated 10:42".
When a refresh fails it shows "No signal. Showing what we knew at 10:42."

**Stand page `/<stand>`**

Both stand types sell to walk-ins, so both use the same honest wording: counts are
"about", with the time of the last count, and the amount before packing is "about".

| State | What the customer sees |
|---|---|
| Normal | Seller's message to customers (if any, e.g. "Strawberries Saturday"); pickup info ("Baskets go on the left shelf. Usually packed by 5 pm."); one line "Counted 9:10 today. Walk-ins may buy some before your order is packed."; items with "about 7 left", steppers, live total (`aria-live`), "Bring about $14.00 cash", name, "Phone (optional), only if the farmer needs to reach you", note, button "Reserve, pay cash at pickup". |
| Unattended, extra line | "At the stand now? Just take what you need and pay in the box." |
| Item sold out | Greyed row "Sold out", no stepper (items the seller hid are not shown at all) |
| No items yet | "Nothing listed yet. Check back soon." |
| Paused by seller | "Online orders are paused." plus the seller's message (e.g. "Back in June") |
| Switched off by Dan | "This stand isn't taking online orders right now." |
| Unknown address | 404: "No stand at this address. Check the sign for the link." |
| Open order on this phone | Banner from localStorage: "Your order WREN-27 is Ready →" |
| Last unit taken first | "Someone just took the last eggs. 2 left now. Nothing was reserved. Change your order and try again." Form keeps the inputs. |
| Missing name | "Add your name so the farmer can label your basket." |
| Double tap | One order only (`idem_key`); the second tap lands on the same order page |

**Order page `/o/<token>`**

| Status | Words |
|---|---|
| placed | "Reserved. Don't come yet; come when this page says Ready." Pickup info ("Usually packed by 5 pm"). "If walk-ins buy some first, your total changes here." "Bring about $15.00." |
| ready | "Ready. Basket WREN-27 · Alice. {pickup info}. Bring $10.00 cash." If packed short: "Only 2 of 3 dozen eggs were left. Bring $10.00 (was $15.00)." Unattended: button "I picked it up and left $10.00". Secondary link "Basket not there?" (with a confirm step) closes the order as not found. |
| not_found | "Sorry about that. We've told the farmer. Nothing to pay." Link to the stand |
| picked_up | "Picked up. Thanks, Alice!" Link "See what's at {stand} →" |
| released from placed | "The farmer couldn't fill this order. Nothing to pay." Link to the stand |
| released from ready | "This basket wasn't picked up and went back on the shelf. Nothing to pay." Link to the stand |
| cancelled | "You cancelled this order. Nothing to pay." Link to the stand |

Also on the page: "Save this link" (Web Share where available, otherwise Copy link) and
"Cancel order" (placed or ready only, as a secondary button with a confirm step).

**Seller page `/admin/<token>`** (all of the seller's stands)

- One line per stand at the top: "2 to pack · 1 ready · 1 to unpack · 1 not closed · last
  visit 5:10 pm · **Start visit**". Each part links to its section; "Start visit" is a
  button, one tap from the home-screen icon.
- Under the page title: "This link is your key. Don't share it."
- First run (no items): checklist "1 Add your first item · 2 Say where baskets go and when
  you visit (pickup info) · 3 Print your sign · 4 Add this page to your home screen".
- Sections: To pack (steppers, basket label "WREN-27 · Alice · $10.00", "Packed, mark
  Ready"); Ready ("Picked up" primary; "Release" secondary and set apart); To unpack ("Back
  on shelf / Not here", same wording as visit step A); Not closed (open more than a day); Closed today (each with "Reopen"). Each
  order shows the customer's phone, if given, as a tap-to-call link.
- Items: about / held / stock, stock +/− labelled "Fix a mistake" (sends the change from
  the number the seller saw; to record what is on the shelf, do a visit), edit name, unit
  and price, "Sold out" (a flag: stock is unchanged, customers see a greyed row and cannot
  order it; the seller or the next visit clears it), "Hide" (out of season, not shown to
  customers), "Add item".
- Stand settings: pickup info; one "Message to customers" shown in every state; pause
  toggle. Links: Visit, Sign, Export.
- Auto-refresh only when nothing is being edited.

**Visit `/admin/<token>/<stand>/visit`** as above.

**Sign `/admin/<token>/<stand>/sign`** (print CSS, one page): stand name, "Order ahead,
pay cash at pickup", large QR code, the typed short URL, "Labelled baskets are reserved
for online orders".

**Export** `/admin/<token>/<stand>/orders.csv` and `visits.csv`.

### Accessibility and phone baseline

- Tap targets at least 48 px; inputs at 16 px text (no iOS zoom); `inputmode="numeric"` on
  counts and `inputmode="decimal"` on cash; every input has a label.
- `aria-live="polite"` on the order total and the order status.
- Contrast WCAG AA; visible focus; `prefers-reduced-motion` respected; light and dark.
- Every action is a plain form POST with redirect, so ordering and the visit work without
  JavaScript. JavaScript adds steppers, the live total, the draft, refresh and Save link.
- Must work at 360 px width. No external fonts. Pages under 30 KB.

### Data model (D1, `migrations/0001_init.sql`)

- `sellers(id, name, active, created_at)`
- `seller_links(id, seller_id, token_hash UNIQUE, label, revoked_at, created_at)`
- `stands(id, seller_id, slug UNIQUE, name, mode 'staffed'|'unattended', pickup_info,
  max_per_item DEFAULT 6, turnstile_on DEFAULT 0, paused DEFAULT 0, message,
  last_counted_at, active, created_at)` (`last_counted_at` is set only by a visit that
  counts at least one item; until then the stand page shows only "Walk-ins may buy some
  before your order is packed.")
- `items(id, stand_id, name, unit_label, price_cents, stock, held, short_since_visit,
  sold_out DEFAULT 0, active (0 = hidden), sort,
  CHECK (held >= 0 AND held <= stock AND stock >= 0))`. A visit clears `sold_out` when
  the item's new free count is above 0.
- `orders(id, stand_id, code, public_token UNIQUE, idem_key UNIQUE, customer_name, contact,
  when_note, status 'placed'|'ready'|'picked_up'|'released'|'cancelled'|'not_found',
  prev_status,
  to_unpack DEFAULT 0, total_cents, cash_cents, reported_paid_cents, created_at,
  updated_at, closed_at, closed_by 'seller'|'customer'|'visit', scrubbed_at)`, index on
  `(stand_id, status, created_at)`
- `order_lines(order_id, item_id, item_name, unit_label, price_cents, qty, packed_qty)`
- `visits(id, stand_id, visit_key UNIQUE, at, walkin_cents, app_cash_cents,
  expected_cents, cash_counted_cents NULL, note)`
- `visit_lines(visit_id, item_id, item_name, price_cents, stock_before, in_baskets, counted,
  short_since_visit, walk_in_sold, removed, restocked)`

**Hold safety:** placing an order is one `DB.batch()` (one SQLite transaction) of
`UPDATE items SET held = held + ? WHERE id = ? AND stand_id = ?` plus the inserts. If any
item lacks free stock, the CHECK constraint raises an error and D1 rolls back the whole
batch, so two shoppers cannot both get the last dozen. D1 docs confirm batch statements
run as one transaction and roll back on failure.

`wrangler.jsonc` names the D1 binding without a `database_id`. Wrangler's automatic
provisioning creates the database on first deploy, and the Deploy to Cloudflare button
provisions it for self-hosters, so the public repo holds no account-specific IDs.

**Live refresh:** pages poll a tiny JSON endpoint (`/o/<token>/v`, `/admin/<token>/v`)
every 30 s while visible and on focus, reload only when its version changes, and stop at a
final status. One always-open tab is 2,880 requests a day; the free limit is 100,000.

### Repo layout (`dfakkeldy/farmstand`, local `~/Developer/farmstand`)

`README.md`, `LICENSE` (MIT), `wrangler.jsonc`, `package.json`, `tsconfig.json`,
`vitest.config.ts`, `migrations/0001_init.sql`, `src/index.ts` (Hono routes),
`src/orders.ts` (holds and order state), `src/items.ts`, `src/visit.ts` (visit math and
save), `src/money.ts`, `src/codes.ts` (tokens, order codes), `src/auth.ts`,
`src/views/*.ts`, `public/style.css`, `public/app.js`, `scripts/admin.ts` (operator CLI),
`test/*.test.ts`, `docs/superpowers/specs/2026-11-07-farmstand-design.md`,
`docs/superpowers/plans/2026-11-07-farmstand-v1.md`.

Stack (versions at least two weeks old): TypeScript 7.0.2, Hono 4.13.13, Wrangler
4.152.0, Vitest 4.1.12 with `@cloudflare/vitest-plugin` 1.4.7 (tests run in workerd with a
real local D1), uqr 0.1.3 for the QR SVG.

## Build steps

1. **Housekeeping (done):** issue grok-bots#936, public repo, local clone, branch `feat/v1`.
2. **Core:** schema, `money.ts`, `codes.ts`, `orders.ts` (place with idempotency, pack
   with short, pick up, release, cancel, reopen, unpack), `items.ts`, `visit.ts`. Tests
   first, because these carry the correctness risk.
3. **Customer pages:** stand page and order page with every state above.
4. **Seller pages:** admin with next-action line and first-run checklist, item editing,
   visit with draft and idempotent submit, sign, CSV export.
5. **Operator CLI and cron:** `scripts/admin.ts`, the 30-day scrub.
6. **README** with deploy button and screenshots. Update the design sheet artifact.
7. **Review and land:** independent `/code-review` subagent (max three rounds), PR with
   Testing / Risk / How to revert / Reviewed-by, land with `land_pr.py`. No CI workflow file
   unless Dan says so (stop list).
8. **Deploy** to `farmstand.fakkeldy.ca` only with Dan's go-ahead, then set up the first
   seller and stand with him.

## Verification

- **Tests (Vitest in workerd with local D1):** cash rounding for 1–9¢; two concurrent
  orders for the last unit, exactly one succeeds; double submit with the same `idem_key`
  makes one order; a failed order holds nothing; pack-short lowers stock and held and adds
  to the tally; release and cancel return holds and set `to_unpack` only after Ready;
  reopen restores holds and is refused when the stock is gone; pick up lowers stock and
  held; visit math on a worked example with an unpack, a gone basket, a short pack, a
  removal, an app pickup and walk-ins; a blank count leaves stock and tally unchanged; a
  large "found more" is refused without the confirm and accepted with it; "Sold out" leaves
  stock unchanged, shows a greyed row, refuses orders, and a later visit's walk-in math is
  unaffected; "Hide" removes the row; "Basket not there?" closes as not_found with
  `to_unpack` set; the released wording depends on the previous status; the same
  `visit_key` twice saves one visit; a
  revoked link is refused while others work; a seller cannot reach another seller's stand;
  paused and switched-off stands refuse orders with the right message; scrub removes
  contact details and keeps totals.
- **End-to-end by hand:** `wrangler dev`, built-in browser at 360 px: first-run checklist,
  add items, print sign, customer order, double-tap check, last-unit race message, pack
  short, customer sees was/now, "I left $X", walk-in sale off-app, cancel after Ready,
  visit (unpack, gone basket, count, cash) with the network turned off mid-visit, summary
  matches the hand-worked figure. Repeat for a staffed stand. Screenshots in the PR.
- **Load sanity:** requests per open page per hour against the 100,000/day free limit.
- **After deploy (if approved):** the same flow once on the live URL with a test stand,
  then switch it off.

## Still open

- Go-ahead to deploy to `farmstand.fakkeldy.ca` once tests pass (asked when ready).
- Whether to add a GitHub Actions test workflow (stop list; default is none).
