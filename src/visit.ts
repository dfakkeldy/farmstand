// The visit: the seller's 2-minute round at the stand, which settles stock and the honour box.
// Order of work: A unpack, B baskets gone, C pack, D count (before removing), E cash.
//
//   present      = counted + units in Ready baskets
//   walk_in_sold = max(0, stock - present) + short_since_visit
//   new stock    = present - removed + restocked     (written as a delta)
//   expected     = walk-in $ since the last cash count + app cash picked up since then

import { linesFor, listItems, listOrders } from "./db";
import { clearUnpack, type Clock, packOrder, pickUpOrder } from "./orders";
import { OPEN, type Stand, type Visit, type VisitLineRow, units } from "./types";

export interface VisitItem {
  id: number;
  name: string;
  priceCents: number;
  stock: number;
  held: number;
  shortSinceVisit: number;
  inBaskets: number;
}

export interface VisitEntry {
  /** null = not counted ("blank is not zero"). */
  counted: number | null;
  removed: number;
  restocked: number;
}

export interface VisitLinePlan {
  itemId: number;
  name: string;
  priceCents: number;
  stockBefore: number;
  inBaskets: number;
  counted: number | null;
  present: number | null;
  shortSinceVisit: number;
  walkInSold: number;
  foundMore: number;
  removed: number;
  restocked: number;
  stockDelta: number;
  tallyDelta: number;
  /** Counted or restocked in this visit. */
  touched: boolean;
}

export interface ConfirmNeed {
  itemId: number;
  name: string;
  counted: number;
  expected: number;
}

export interface VisitPlan {
  lines: VisitLinePlan[];
  needsConfirm: ConfirmNeed[];
  errors: { itemId: number; message: string }[];
  walkinCents: number;
}

const whole = (n: number) => Number.isInteger(n) && n >= 0;

/** Pure: what a visit would do, given the items as they will be after unpacking and packing. */
export function computeVisit(items: VisitItem[], entries: Record<number, VisitEntry>, confirmed: boolean): VisitPlan {
  const plan: VisitPlan = { lines: [], needsConfirm: [], errors: [], walkinCents: 0 };
  for (const it of items) {
    const e = entries[it.id] ?? { counted: null, removed: 0, restocked: 0 };
    if ((e.counted !== null && !whole(e.counted)) || !whole(e.removed) || !whole(e.restocked)) {
      plan.errors.push({ itemId: it.id, message: "Use whole numbers, 0 or more." });
      continue;
    }
    let line: VisitLinePlan;
    if (e.counted === null) {
      if (e.removed > 0) {
        plan.errors.push({ itemId: it.id, message: "Count the shelf before removing any." });
        continue;
      }
      line = {
        itemId: it.id, name: it.name, priceCents: it.priceCents, stockBefore: it.stock, inBaskets: it.inBaskets,
        counted: null, present: null, shortSinceVisit: it.shortSinceVisit, walkInSold: 0, foundMore: 0,
        removed: 0, restocked: e.restocked, stockDelta: e.restocked, tallyDelta: 0, touched: e.restocked > 0,
      };
    } else {
      if (e.removed > e.counted) {
        plan.errors.push({ itemId: it.id, message: "You can't remove more than you counted." });
        continue;
      }
      const present = e.counted + it.inBaskets;
      const gone = it.stock - present;
      const foundMore = Math.max(0, -gone);
      const expectedLoose = it.stock - it.inBaskets;
      if (foundMore > 3 && foundMore > expectedLoose / 2 && !confirmed) {
        plan.needsConfirm.push({ itemId: it.id, name: it.name, counted: e.counted, expected: expectedLoose });
      }
      const newStock = present - e.removed + e.restocked;
      line = {
        itemId: it.id, name: it.name, priceCents: it.priceCents, stockBefore: it.stock, inBaskets: it.inBaskets,
        counted: e.counted, present, shortSinceVisit: it.shortSinceVisit,
        walkInSold: Math.max(0, gone) + it.shortSinceVisit, foundMore,
        removed: e.removed, restocked: e.restocked, stockDelta: newStock - it.stock,
        tallyDelta: -it.shortSinceVisit, touched: true,
      };
    }
    const newStock = it.stock + line.stockDelta;
    if (newStock < it.held) {
      const held = it.held === 1 ? "1 is held for an order" : `${it.held} are held for orders`;
      plan.errors.push({ itemId: it.id, message: `${held} waiting to be packed. Pack them first, then count.` });
      continue;
    }
    plan.walkinCents += line.walkInSold * line.priceCents;
    plan.lines.push(line);
  }
  return plan;
}

export interface VisitForm {
  /** Random key made when the visit page loads; a retry with the same key saves nothing new. */
  visitKey: string;
  /** Orders flagged "to unpack" that the seller dealt with (either "Back on shelf" or "Not here"). */
  unpack: number[];
  /** Ready orders whose basket is gone. */
  gone: number[];
  /** Waiting orders packed in this visit: order id -> item id -> units packed. */
  pack: Record<number, Record<number, number>>;
  entries: Record<number, VisitEntry>;
  cashCounted: number | null;
  confirmed: boolean;
  note?: string;
}

export type SaveVisitResult =
  | { ok: true; visitId: number }
  | { ok: false; needsConfirm: ConfirmNeed[]; errors: VisitPlan["errors"] };

/**
 * The items as they will be once the form's unpack/gone/pack steps are applied
 * (or as they are now, when `form` is null).
 */
async function snapshot(db: D1Database, standId: number, form: VisitForm | null): Promise<VisitItem[]> {
  const items = await listItems(db, standId);
  const open = await listOrders(db, standId, OPEN);
  const lines = await linesFor(db, open.map((o) => o.id));
  const acc = new Map(items.map((i) => [i.id, { stock: i.stock, held: i.held, tally: i.short_since_visit, baskets: 0 }]));
  for (const order of open) {
    for (const line of lines.get(order.id) ?? []) {
      const a = acc.get(line.item_id);
      if (!a) continue;
      if (order.status === "ready") {
        if (form?.gone.includes(order.id)) {
          a.stock -= units(line);
          a.held -= units(line);
        } else {
          a.baskets += units(line);
        }
      } else if (form?.pack[order.id]) {
        const raw = form.pack[order.id]![line.item_id];
        const p = raw === undefined || !Number.isInteger(raw) ? line.qty : Math.min(Math.max(raw, 0), line.qty);
        const short = line.qty - p;
        a.stock -= short;
        a.held -= short;
        a.tally += short;
        a.baskets += p;
      }
    }
  }
  return items.map((i) => {
    const a = acc.get(i.id)!;
    return {
      id: i.id, name: i.name, priceCents: i.price_cents,
      stock: a.stock, held: a.held, shortSinceVisit: a.tally, inBaskets: a.baskets,
    };
  });
}

async function visitIdForKey(db: D1Database, key: string): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM visits WHERE visit_key = ?").bind(key).first<{ id: number }>();
  return row?.id ?? null;
}

/** Start of the current cash period: the last visit that counted the box, else when the stand began. */
async function cashPeriodStart(db: D1Database, stand: Stand): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(at) AS at FROM visits WHERE stand_id = ? AND cash_counted_cents IS NOT NULL")
    .bind(stand.id)
    .first<{ at: number | null }>();
  return row?.at ?? stand.created_at;
}

async function sum(db: D1Database, sql: string, ...params: (string | number)[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ s: number | null }>();
  return row?.s ?? 0;
}

export async function saveVisit(db: D1Database, stand: Stand, form: VisitForm, clock: Clock): Promise<SaveVisitResult> {
  const done = await visitIdForKey(db, form.visitKey);
  if (done !== null) return { ok: true, visitId: done };

  // Check everything before writing anything.
  const predicted = computeVisit(await snapshot(db, stand.id, form), form.entries, form.confirmed);
  if (predicted.errors.length || predicted.needsConfirm.length) {
    return { ok: false, needsConfirm: predicted.needsConfirm, errors: predicted.errors };
  }

  // Phase 1: the order steps. Each is guarded, so a retry repeats nothing.
  for (const id of form.unpack) await clearUnpack(db, stand.id, id, clock.now);
  for (const id of form.gone) await pickUpOrder(db, stand.id, id, "visit", clock.now);
  for (const [id, packed] of Object.entries(form.pack)) await packOrder(db, stand.id, Number(id), packed, clock);

  // Phase 2: count from the real state, in one transaction.
  const plan = computeVisit(await snapshot(db, stand.id, null), form.entries, true);
  if (plan.errors.length) return { ok: false, needsConfirm: [], errors: plan.errors };

  const since = await cashPeriodStart(db, stand);
  const appCash = await sum(
    db,
    "SELECT SUM(cash_cents) AS s FROM orders WHERE stand_id = ? AND status = 'picked_up' AND closed_at > ?",
    stand.id,
    since,
  );
  const earlierWalkin = await sum(db, "SELECT SUM(walkin_cents) AS s FROM visits WHERE stand_id = ? AND at > ?", stand.id, since);
  const expected = earlierWalkin + plan.walkinCents + appCash;
  const now = clock.now;

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO visits (stand_id, visit_key, at, walkin_cents, app_cash_cents, expected_cents, cash_counted_cents, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(stand.id, form.visitKey, now, plan.walkinCents, appCash, expected, form.cashCounted, (form.note ?? "").slice(0, 200)),
  ];
  for (const l of plan.lines.filter((x) => x.touched)) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO visit_lines (visit_id, item_id, item_name, price_cents, stock_before, in_baskets, counted,
             short_since_visit, walk_in_sold, found_more, removed, restocked)
           VALUES ((SELECT id FROM visits WHERE visit_key = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(form.visitKey, l.itemId, l.name, l.priceCents, l.stockBefore, l.inBaskets, l.counted,
          l.shortSinceVisit, l.walkInSold, l.foundMore, l.removed, l.restocked),
      db
        .prepare(
          `UPDATE items SET stock = stock + ?, short_since_visit = short_since_visit + ?,
             sold_out = CASE WHEN stock + ? - held > 0 THEN 0 ELSE sold_out END, updated_at = ?
           WHERE id = ? AND stand_id = ?`,
        )
        .bind(l.stockDelta, l.tallyDelta, l.stockDelta, now, l.itemId, stand.id),
    );
  }
  if (plan.lines.some((l) => l.counted !== null)) {
    stmts.push(db.prepare("UPDATE stands SET last_counted_at = ? WHERE id = ?").bind(now, stand.id));
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") && msg.includes("visit_key")) {
      const id = await visitIdForKey(db, form.visitKey);
      if (id !== null) return { ok: true, visitId: id };
    }
    if (msg.includes("CHECK")) {
      return {
        ok: false,
        needsConfirm: [],
        errors: [{ itemId: 0, message: "A new order came in while you counted. Check the counts and save again." }],
      };
    }
    throw err;
  }
  const id = await visitIdForKey(db, form.visitKey);
  return { ok: true, visitId: id! };
}

export async function getVisit(
  db: D1Database,
  standId: number,
  visitId: number,
): Promise<{ visit: Visit; lines: VisitLineRow[] } | null> {
  const visit = await db.prepare("SELECT * FROM visits WHERE id = ? AND stand_id = ?").bind(visitId, standId).first<Visit>();
  if (!visit) return null;
  const { results } = await db
    .prepare("SELECT * FROM visit_lines WHERE visit_id = ? ORDER BY rowid")
    .bind(visitId)
    .all<VisitLineRow>();
  return { visit, lines: results };
}

/** "This week: $142 shelf · $38 app · $3 short" for the last 7 days. */
export async function weekSummary(
  db: D1Database,
  standId: number,
  now: number,
): Promise<{ shelfCents: number; appCents: number; diffCents: number }> {
  const since = now - 7 * 86_400_000;
  const [shelfCents, appCents, diffCents] = await Promise.all([
    sum(db, "SELECT SUM(walkin_cents) AS s FROM visits WHERE stand_id = ? AND at > ?", standId, since),
    sum(db, "SELECT SUM(cash_cents) AS s FROM orders WHERE stand_id = ? AND status = 'picked_up' AND closed_at > ?", standId, since),
    sum(
      db,
      "SELECT SUM(cash_counted_cents - expected_cents) AS s FROM visits WHERE stand_id = ? AND at > ? AND cash_counted_cents IS NOT NULL",
      standId,
      since,
    ),
  ]);
  return { shelfCents, appCents, diffCents };
}
