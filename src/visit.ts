// The visit: the seller's 2-minute round at the stand, which settles stock and the honour box.
// Order of work: A unpack, B baskets gone, C pack, D count (before removing), E cash.
//
//   present      = counted + units in Ready baskets
//   walk_in_sold = max(0, stock - present + short_since_visit)
//   new stock    = present - removed + restocked     (written as a delta)
//   expected     = walk-in $ since the last cash count + app cash picked up since then
//
// The whole visit (unpack, baskets, packing, counts, the visit row) is one transaction. Guard
// statements make it fail if any order the form relied on changed meanwhile, so a visit is
// either fully applied or not at all, and a retry starts fresh.

import { linesFor, listOrders } from "./db";
import { type Clock, closeStatements, packedUnits, packStatements, VISIT_PICKUP } from "./orders";
import { type Item, OPEN, type Order, type OrderLine, type Stand, type Visit, type VisitLineRow, units } from "./types";

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
        // Units written off at packing that turn up on the shelf cancel out, not count twice.
        walkInSold: Math.max(0, gone + it.shortSinceVisit), foundMore,
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

/** Items a visit covers: everything for sale, plus hidden items that still hold or owe a tally. */
export async function visitItems(db: D1Database, standId: number): Promise<Item[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM items WHERE stand_id = ? AND (active = 1 OR held > 0 OR short_since_visit > 0) ORDER BY sort, id",
    )
    .bind(standId)
    .all<Item>();
  return results;
}

interface Loaded {
  items: Item[];
  open: Order[];
  lines: Map<number, OrderLine[]>;
}

async function load(db: D1Database, standId: number): Promise<Loaded> {
  const [items, open] = await Promise.all([visitItems(db, standId), listOrders(db, standId, OPEN)]);
  return { items, open, lines: await linesFor(db, open.map((o) => o.id)) };
}

/** Pure: the items as they will be once the form's baskets and packing are applied. */
function predict(loaded: Loaded, form: VisitForm): VisitItem[] {
  const acc = new Map(loaded.items.map((i) => [i.id, { stock: i.stock, held: i.held, tally: i.short_since_visit, baskets: 0 }]));
  for (const order of loaded.open) {
    for (const line of loaded.lines.get(order.id) ?? []) {
      const a = acc.get(line.item_id);
      if (!a) continue;
      if (order.status === "ready") {
        if (form.gone.includes(order.id)) {
          a.stock -= units(line);
          a.held -= units(line);
        } else {
          a.baskets += units(line);
        }
      } else if (form.pack[order.id]) {
        const p = packedUnits(line, form.pack[order.id]![line.item_id]);
        const short = line.qty - p;
        a.stock -= short;
        a.held -= short;
        a.tally += short;
        a.baskets += p;
      }
    }
  }
  return loaded.items.map((i) => {
    const a = acc.get(i.id)!;
    return {
      id: i.id, name: i.name, priceCents: i.price_cents,
      stock: a.stock, held: a.held, shortSinceVisit: a.tally, inBaskets: a.baskets,
    };
  });
}

const CHANGED_WORDS: Record<string, string> = {
  cancelled: "was cancelled",
  picked_up: "was picked up",
  released: "was released",
  not_found: "was reported missing",
  ready: "was already packed",
  placed: "isn't packed yet",
};

/** Messages for orders the form relied on that are no longer where the form saw them. */
async function changedOrders(db: D1Database, standId: number, form: VisitForm, open: Order[]): Promise<string[]> {
  const status = new Map(open.map((o) => [o.id, o.status]));
  const expected: [number, string][] = [
    ...Object.keys(form.pack).map((id) => [Number(id), "placed"] as [number, string]),
    ...form.gone.map((id) => [id, "ready"] as [number, string]),
  ];
  const off = expected.filter(([id, want]) => status.get(id) !== want).map(([id]) => id);
  if (off.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT id, code, status FROM orders WHERE stand_id = ? AND id IN (${off.map(() => "?").join(", ")})`)
    .bind(standId, ...off)
    .all<{ id: number; code: string; status: string }>();
  return results.map(
    (o) => `${o.code} ${CHANGED_WORDS[o.status] ?? "changed"} while you counted. Check the basket, then save again.`,
  );
}

/** Makes the whole batch fail (NOT NULL on stands.name) unless the order still has this status. */
function assertStatus(db: D1Database, standId: number, orderId: number, status: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE stands SET name = CASE WHEN (SELECT status FROM orders WHERE id = ? AND stand_id = ?) = ? THEN name ELSE NULL END
       WHERE id = ?`,
    )
    .bind(orderId, standId, status, standId);
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

/** Keys of the stand's latest visits, so a phone can drop a draft that was already saved. */
export async function recentVisitKeys(db: D1Database, standId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT visit_key FROM visits WHERE stand_id = ? ORDER BY at DESC, id DESC LIMIT 5")
    .bind(standId)
    .all<{ visit_key: string }>();
  return results.map((r) => r.visit_key);
}

export async function saveVisit(db: D1Database, stand: Stand, form: VisitForm, clock: Clock): Promise<SaveVisitResult> {
  const done = await visitIdForKey(db, form.visitKey);
  if (done !== null) return { ok: true, visitId: done };

  const loaded = await load(db, stand.id);
  const changed = await changedOrders(db, stand.id, form, loaded.open);
  if (changed.length) return { ok: false, needsConfirm: [], errors: changed.map((message) => ({ itemId: 0, message })) };

  const plan = computeVisit(predict(loaded, form), form.entries, form.confirmed);
  if (plan.errors.length || plan.needsConfirm.length) {
    return { ok: false, needsConfirm: plan.needsConfirm, errors: plan.errors };
  }

  const lines = (o: Order) => loaded.lines.get(o.id) ?? [];
  const goneOrders = loaded.open.filter((o) => o.status === "ready" && form.gone.includes(o.id));
  const packOrders = loaded.open.filter((o) => o.status === "placed" && form.pack[o.id]);
  const since = await cashPeriodStart(db, stand);
  const appCash =
    (await sum(
      db,
      "SELECT SUM(cash_cents) AS s FROM orders WHERE stand_id = ? AND status = 'picked_up' AND closed_at > ?",
      stand.id,
      since,
    )) + goneOrders.reduce((s, o) => s + o.cash_cents, 0);
  const earlierWalkin = await sum(db, "SELECT SUM(walkin_cents) AS s FROM visits WHERE stand_id = ? AND at > ?", stand.id, since);
  const expected = earlierWalkin + plan.walkinCents + appCash;
  const now = clock.now;

  const stmts: D1PreparedStatement[] = [
    // The batch fails unless every order is still where the form saw it.
    ...packOrders.map((o) => assertStatus(db, stand.id, o.id, "placed")),
    ...goneOrders.map((o) => assertStatus(db, stand.id, o.id, "ready")),
    // A. Unpack (either answer clears the flag; the count does the math).
    ...form.unpack.map((id) =>
      db
        .prepare("UPDATE orders SET to_unpack = 0, updated_at = ? WHERE id = ? AND stand_id = ? AND to_unpack = 1")
        .bind(now, id, stand.id),
    ),
    // B. Baskets that are gone, and C. packing.
    ...goneOrders.flatMap((o) => closeStatements(db, o, lines(o), VISIT_PICKUP, now)),
    ...packOrders.flatMap((o) => packStatements(db, o, lines(o), form.pack[o.id]!, clock).stmts),
    // D and E. The visit itself.
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
      // Deltas on top of the basket and packing statements above, so a pickup at the same moment is kept.
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
    if (msg.includes("NOT NULL") && msg.includes("stands.name")) {
      const fresh = await listOrders(db, stand.id, OPEN);
      const why = await changedOrders(db, stand.id, form, fresh);
      const errors = why.length ? why : ["An order changed while you counted. Check the baskets, then save again."];
      return { ok: false, needsConfirm: [], errors: errors.map((message) => ({ itemId: 0, message })) };
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
