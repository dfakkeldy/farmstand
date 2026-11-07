import type { Item, Order, OrderLine, OrderStatus, Stand, Visit } from "./types";

export async function getStandBySlug(db: D1Database, slug: string): Promise<Stand | null> {
  return db.prepare("SELECT * FROM stands WHERE slug = ?").bind(slug).first<Stand>();
}

export async function getStand(db: D1Database, id: number): Promise<Stand | null> {
  return db.prepare("SELECT * FROM stands WHERE id = ?").bind(id).first<Stand>();
}

export async function listItems(
  db: D1Database,
  standId: number,
  opts: { includeHidden?: boolean } = {},
): Promise<Item[]> {
  const sql = opts.includeHidden
    ? "SELECT * FROM items WHERE stand_id = ? ORDER BY active DESC, sort, id"
    : "SELECT * FROM items WHERE stand_id = ? AND active = 1 ORDER BY sort, id";
  const { results } = await db.prepare(sql).bind(standId).all<Item>();
  return results;
}

export async function getOrderByToken(db: D1Database, token: string): Promise<Order | null> {
  return db.prepare("SELECT * FROM orders WHERE public_token = ?").bind(token).first<Order>();
}

export async function getOrder(db: D1Database, standId: number, orderId: number): Promise<Order | null> {
  return db
    .prepare("SELECT * FROM orders WHERE id = ? AND stand_id = ?")
    .bind(orderId, standId)
    .first<Order>();
}

export async function getLines(db: D1Database, orderId: number): Promise<OrderLine[]> {
  const { results } = await db
    .prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY rowid")
    .bind(orderId)
    .all<OrderLine>();
  return results;
}

export async function listOrders(
  db: D1Database,
  standId: number,
  statuses: readonly OrderStatus[],
): Promise<Order[]> {
  const marks = statuses.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM orders WHERE stand_id = ? AND status IN (${marks}) ORDER BY created_at`)
    .bind(standId, ...statuses)
    .all<Order>();
  return results;
}

/** Lines for many orders at once, keyed by order id. */
export async function linesFor(db: D1Database, orderIds: number[]): Promise<Map<number, OrderLine[]>> {
  const map = new Map<number, OrderLine[]>();
  if (orderIds.length === 0) return map;
  const marks = orderIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM order_lines WHERE order_id IN (${marks}) ORDER BY rowid`)
    .bind(...orderIds)
    .all<OrderLine>();
  for (const line of results) {
    const list = map.get(line.order_id) ?? [];
    list.push(line);
    map.set(line.order_id, list);
  }
  return map;
}

export async function lastVisit(db: D1Database, standId: number): Promise<Visit | null> {
  return db
    .prepare("SELECT * FROM visits WHERE stand_id = ? ORDER BY at DESC, id DESC LIMIT 1")
    .bind(standId)
    .first<Visit>();
}
