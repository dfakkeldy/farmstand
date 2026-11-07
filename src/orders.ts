// Order transitions. Each one is a single D1 batch (one SQLite transaction):
//   - every item statement is guarded by the order's expected status, and
//   - the order's own status update comes last.
// If someone else changed the order first, the guards make the whole batch a no-op and the
// last statement reports zero changes, so a stale tap changes nothing.
// CHECK (held <= stock) on items is the final defence against selling a unit twice.

import { orderCode, randomToken } from "./codes";
import { getLines, getOrder, lastVisit, listItems } from "./db";
import { roundCash } from "./money";
import { localDate } from "./time";
import { type ClosedBy, type Order, type OrderLine, type OrderStatus, type Stand, OPEN, units } from "./types";

export interface PlaceInput {
  idemKey: string;
  name: string;
  contact: string;
  whenNote: string;
  qty: Record<number, number>;
}

export type PlaceResult =
  | { ok: true; token: string }
  | { ok: false; kind: "invalid" | "sold_out" | "closed"; message: string };

export interface Clock {
  now: number;
  roundStep: number;
}

const GUARD = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = ?)";

const fail = (kind: "invalid" | "sold_out" | "closed", message: string): PlaceResult => ({ ok: false, kind, message });

function errorHas(err: unknown, ...parts: string[]): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return parts.every((p) => msg.includes(p));
}

function lastUnitsMessage(name: string, free: number): string {
  const left = free > 0 ? `${free} left now` : "None left now";
  return `Someone just took the last ${name.toLowerCase()}. ${left}. Nothing was reserved. Change your order and try again.`;
}

async function freshCode(db: D1Database, standId: number): Promise<string> {
  let code = orderCode();
  for (let i = 0; i < 10; i++) {
    const clash = await db
      .prepare("SELECT 1 FROM orders WHERE stand_id = ? AND code = ? AND status IN ('placed', 'ready')")
      .bind(standId, code)
      .first();
    if (!clash) break;
    code = orderCode();
  }
  return code;
}

async function tokenForIdem(db: D1Database, idemKey: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT public_token FROM orders WHERE idem_key = ?")
    .bind(idemKey)
    .first<{ public_token: string }>();
  return row?.public_token ?? null;
}

export async function placeOrder(db: D1Database, stand: Stand, input: PlaceInput, clock: Clock): Promise<PlaceResult> {
  if (!stand.active) return fail("closed", "This stand isn't taking online orders right now.");
  if (stand.paused) return fail("closed", "Online orders are paused.");

  const existing = await tokenForIdem(db, input.idemKey);
  if (existing) return { ok: true, token: existing };

  const name = input.name.trim();
  const contact = input.contact.trim();
  const whenNote = input.whenNote.trim();
  if (!name) return fail("invalid", "Add your name so the farmer can label your basket.");
  if (name.length > 60) return fail("invalid", "Please use a shorter name (60 characters at most).");
  if (contact.length > 40) return fail("invalid", "Please use a shorter phone number.");
  if (whenNote.length > 120) return fail("invalid", "Please keep the note under 120 characters.");

  const wanted = Object.entries(input.qty)
    .map(([id, q]) => [Number(id), q] as const)
    .filter(([, q]) => q !== 0);
  if (wanted.some(([id, q]) => !Number.isInteger(id) || !Number.isInteger(q) || q < 0)) {
    return fail("invalid", "Quantities must be whole numbers.");
  }
  if (wanted.length === 0) return fail("invalid", "Choose at least one item.");
  if (wanted.some(([, q]) => q > stand.max_per_item)) {
    return fail("invalid", `You can reserve up to ${stand.max_per_item} of each item.`);
  }

  const items = new Map((await listItems(db, stand.id)).map((i) => [i.id, i]));
  for (const [id, q] of wanted) {
    const item = items.get(id);
    if (!item) return fail("invalid", "Something on your list is no longer for sale. Please check and try again.");
    if (item.sold_out) return fail("sold_out", `${item.name} is sold out.`);
    if (item.stock - item.held < q) return fail("sold_out", lastUnitsMessage(item.name, item.stock - item.held));
  }

  const total = wanted.reduce((sum, [id, q]) => sum + q * items.get(id)!.price_cents, 0);
  const cash = roundCash(total, clock.roundStep);
  const token = randomToken();
  const code = await freshCode(db, stand.id);
  const now = clock.now;

  const stmts: D1PreparedStatement[] = wanted.map(([id, q]) =>
    db.prepare("UPDATE items SET held = held + ?, updated_at = ? WHERE id = ? AND stand_id = ?").bind(q, now, id, stand.id),
  );
  stmts.push(
    db
      .prepare(
        `INSERT INTO orders (stand_id, code, public_token, idem_key, customer_name, contact, when_note, status,
           total_cents, cash_cents, orig_total_cents, orig_cash_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(stand.id, code, token, input.idemKey, name, contact || null, whenNote || null, total, cash, total, cash, now, now),
  );
  for (const [id, q] of wanted) {
    const item = items.get(id)!;
    stmts.push(
      db
        .prepare(
          `INSERT INTO order_lines (order_id, item_id, item_name, unit_label, price_cents, qty)
           VALUES ((SELECT id FROM orders WHERE public_token = ?), ?, ?, ?, ?, ?)`,
        )
        .bind(token, id, item.name, item.unit_label, item.price_cents, q),
    );
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    if (errorHas(err, "UNIQUE", "idem_key")) {
      // A double tap raced us; send this tap to the order the first one made.
      const first = await tokenForIdem(db, input.idemKey);
      if (first) return { ok: true, token: first };
    }
    if (errorHas(err, "CHECK")) {
      const fresh = new Map((await listItems(db, stand.id)).map((i) => [i.id, i]));
      for (const [id, q] of wanted) {
        const item = fresh.get(id);
        if (item && item.stock - item.held < q) return fail("sold_out", lastUnitsMessage(item.name, item.stock - item.held));
      }
      return fail("sold_out", "Someone just took the last of something on your list. Nothing was reserved. Please try again.");
    }
    throw err;
  }
  return { ok: true, token };
}

/** Pack an order. Short lines lower stock and held together and go on the item's tally. */
export async function packOrder(
  db: D1Database,
  standId: number,
  orderId: number,
  packed: Record<number, number>,
  clock: Clock,
): Promise<"ready" | "released" | "stale"> {
  const order = await getOrder(db, standId, orderId);
  if (!order || order.status !== "placed") return "stale";
  const lines = await getLines(db, orderId);
  const plan = lines.map((line) => {
    const raw = packed[line.item_id];
    const p = raw === undefined || !Number.isInteger(raw) ? line.qty : Math.min(Math.max(raw, 0), line.qty);
    return { line, p, short: line.qty - p };
  });
  const total = plan.reduce((sum, x) => sum + x.p * x.line.price_cents, 0);
  const cash = roundCash(total, clock.roundStep);
  const nothing = plan.every((x) => x.p === 0);
  const now = clock.now;

  const stmts: D1PreparedStatement[] = [];
  for (const { line, p, short } of plan) {
    if (short > 0) {
      stmts.push(
        db
          .prepare(
            `UPDATE items SET held = held - ?, stock = stock - ?, short_since_visit = short_since_visit + ?, updated_at = ?
             WHERE id = ? AND ${GUARD}`,
          )
          .bind(short, short, short, now, line.item_id, order.id, "placed"),
      );
    }
    stmts.push(
      db
        .prepare(`UPDATE order_lines SET packed_qty = ? WHERE order_id = ? AND item_id = ? AND ${GUARD}`)
        .bind(p, order.id, line.item_id, order.id, "placed"),
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE orders SET status = ?, prev_status = 'placed', total_cents = ?, cash_cents = ?,
           closed_at = ?, closed_by = ?, reopen_ok = 0, updated_at = ?
         WHERE id = ? AND status = 'placed'`,
      )
      .bind(nothing ? "released" : "ready", total, cash, nothing ? now : null, nothing ? "seller" : null, now, order.id),
  );
  const res = await db.batch(stmts);
  if ((res.at(-1)?.meta.changes ?? 0) !== 1) return "stale";
  return nothing ? "released" : "ready";
}

interface CloseSpec {
  to: OrderStatus;
  by: ClosedBy;
  /** Units leave the stand (pick up) rather than going back to the free count. */
  leaves: boolean;
  toUnpack: boolean;
  reopenOk: boolean;
  reportedPaid: boolean;
}

async function closeOrder(db: D1Database, order: Order, lines: OrderLine[], spec: CloseSpec, now: number): Promise<boolean> {
  const from = order.status;
  const stmts = lines.map((line) => {
    const u = units(line);
    return spec.leaves
      ? db
          .prepare(`UPDATE items SET stock = stock - ?, held = held - ?, updated_at = ? WHERE id = ? AND ${GUARD}`)
          .bind(u, u, now, line.item_id, order.id, from)
      : db
          .prepare(`UPDATE items SET held = held - ?, updated_at = ? WHERE id = ? AND ${GUARD}`)
          .bind(u, now, line.item_id, order.id, from);
  });
  stmts.push(
    db
      .prepare(
        `UPDATE orders SET status = ?, prev_status = ?, to_unpack = ?, reopen_ok = ?, reported_paid_cents = ?,
           closed_at = ?, closed_by = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(
        spec.to,
        from,
        spec.toUnpack ? 1 : 0,
        spec.reopenOk ? 1 : 0,
        spec.reportedPaid ? order.cash_cents : null,
        now,
        spec.by,
        now,
        order.id,
        from,
      ),
  );
  const res = await db.batch(stmts);
  return (res.at(-1)?.meta.changes ?? 0) === 1;
}

async function loadOpen(
  db: D1Database,
  standId: number,
  orderId: number,
  allowed: readonly OrderStatus[],
): Promise<{ order: Order; lines: OrderLine[] } | null> {
  const order = await getOrder(db, standId, orderId);
  if (!order || !allowed.includes(order.status)) return null;
  return { order, lines: await getLines(db, orderId) };
}

/** Seller: from placed (handed over at a staffed stand) or ready. Customer and visit: from ready. */
export async function pickUpOrder(db: D1Database, standId: number, orderId: number, by: ClosedBy, now: number): Promise<boolean> {
  const found = await loadOpen(db, standId, orderId, by === "seller" ? OPEN : ["ready"]);
  if (!found) return false;
  return closeOrder(db, found.order, found.lines, {
    to: "picked_up",
    by,
    leaves: true,
    toUnpack: false,
    reopenOk: by === "seller",
    reportedPaid: by === "customer",
  }, now);
}

export async function releaseOrder(db: D1Database, standId: number, orderId: number, now: number): Promise<boolean> {
  const found = await loadOpen(db, standId, orderId, OPEN);
  if (!found) return false;
  return closeOrder(db, found.order, found.lines, {
    to: "released",
    by: "seller",
    leaves: false,
    toUnpack: found.order.status === "ready",
    reopenOk: true,
    reportedPaid: false,
  }, now);
}

export async function cancelOrder(db: D1Database, standId: number, orderId: number, now: number): Promise<boolean> {
  const found = await loadOpen(db, standId, orderId, OPEN);
  if (!found) return false;
  return closeOrder(db, found.order, found.lines, {
    to: "cancelled",
    by: "customer",
    leaves: false,
    toUnpack: found.order.status === "ready",
    reopenOk: false,
    reportedPaid: false,
  }, now);
}

/** Customer: "Basket not there?". The seller looks for it; the next count settles it. */
export async function markNotFound(db: D1Database, standId: number, orderId: number, now: number): Promise<boolean> {
  const found = await loadOpen(db, standId, orderId, ["ready"]);
  if (!found) return false;
  return closeOrder(db, found.order, found.lines, {
    to: "not_found",
    by: "customer",
    leaves: false,
    toUnpack: true,
    reopenOk: false,
    reportedPaid: false,
  }, now);
}

/** Undo a seller's pick up or release made today, after the last visit. */
export async function reopenOrder(
  db: D1Database,
  standId: number,
  orderId: number,
  opts: { now: number; tz: string },
): Promise<"ok" | "not_allowed" | "no_stock"> {
  const order = await getOrder(db, standId, orderId);
  if (!order || order.closed_by !== "seller" || !order.reopen_ok || order.closed_at === null) return "not_allowed";
  if (order.status !== "picked_up" && order.status !== "released") return "not_allowed";
  const back = order.prev_status;
  if (back !== "placed" && back !== "ready") return "not_allowed";
  // A released basket that was already put back on the shelf can't simply become Ready again.
  if (order.status === "released" && back === "ready" && !order.to_unpack) return "not_allowed";
  if (localDate(order.closed_at, opts.tz) !== localDate(opts.now, opts.tz)) return "not_allowed";
  const visit = await lastVisit(db, standId);
  if (visit && visit.at >= order.closed_at) return "not_allowed";

  const lines = await getLines(db, orderId);
  const returning = order.status === "picked_up";
  const stmts = lines.map((line) => {
    const u = units(line);
    return returning
      ? db
          .prepare(`UPDATE items SET stock = stock + ?, held = held + ?, updated_at = ? WHERE id = ? AND ${GUARD}`)
          .bind(u, u, opts.now, line.item_id, order.id, order.status)
      : db
          .prepare(`UPDATE items SET held = held + ?, updated_at = ? WHERE id = ? AND ${GUARD}`)
          .bind(u, opts.now, line.item_id, order.id, order.status);
  });
  stmts.push(
    db
      .prepare(
        `UPDATE orders SET status = ?, prev_status = NULL, closed_at = NULL, closed_by = NULL, reopen_ok = 0,
           to_unpack = 0, reported_paid_cents = NULL, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(back, opts.now, order.id, order.status),
  );
  try {
    const res = await db.batch(stmts);
    return (res.at(-1)?.meta.changes ?? 0) === 1 ? "ok" : "not_allowed";
  } catch (err) {
    if (errorHas(err, "CHECK")) return "no_stock";
    throw err;
  }
}

/** The seller dealt with a basket to unpack ("Back on shelf" or "Not here"). */
export async function clearUnpack(db: D1Database, standId: number, orderId: number, now: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE orders SET to_unpack = 0, updated_at = ? WHERE id = ? AND stand_id = ? AND to_unpack = 1")
    .bind(now, orderId, standId)
    .run();
  return res.meta.changes === 1;
}
