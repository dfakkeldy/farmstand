export interface ItemFields {
  name: string;
  unit: string;
  priceCents: number;
}

type Result = { ok: true } | { ok: false; message: string };

function check(fields: ItemFields): string | null {
  const name = fields.name.trim();
  if (!name) return "Give the item a name.";
  if (name.length > 40) return "Please use a shorter name (40 characters at most).";
  if (fields.unit.trim().length > 20) return "Please use a shorter unit, like \"dozen\" or \"bag\".";
  if (!Number.isInteger(fields.priceCents) || fields.priceCents < 0 || fields.priceCents > 100_000_00) {
    return "Enter a price like 5.00.";
  }
  return null;
}

function heldMessage(held: number): string {
  return held === 1 ? "1 is held for orders." : `${held} are held for orders.`;
}

export async function addItem(
  db: D1Database,
  standId: number,
  fields: ItemFields & { stock: number },
  now: number,
): Promise<{ ok: true; id: number } | { ok: false; message: string }> {
  const problem = check(fields);
  if (problem) return { ok: false, message: problem };
  if (!Number.isInteger(fields.stock) || fields.stock < 0) return { ok: false, message: "Stock must be a whole number, 0 or more." };
  const row = await db
    .prepare(
      `INSERT INTO items (stand_id, name, unit_label, price_cents, stock, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM items WHERE stand_id = ?), ?, ?)
       RETURNING id`,
    )
    .bind(standId, fields.name.trim(), fields.unit.trim(), fields.priceCents, fields.stock, standId, now, now)
    .first<{ id: number }>();
  return { ok: true, id: row!.id };
}

export async function editItem(db: D1Database, standId: number, itemId: number, fields: ItemFields, now: number): Promise<Result> {
  const problem = check(fields);
  if (problem) return { ok: false, message: problem };
  const res = await db
    .prepare("UPDATE items SET name = ?, unit_label = ?, price_cents = ?, updated_at = ? WHERE id = ? AND stand_id = ?")
    .bind(fields.name.trim(), fields.unit.trim(), fields.priceCents, now, itemId, standId)
    .run();
  return res.meta.changes === 1 ? { ok: true } : { ok: false, message: "That item isn't on this stand." };
}

/**
 * "Fix a mistake": set stock to `next`, applied as the change from `seen` (the number on the
 * seller's screen), so a pickup that lands at the same moment is not lost.
 */
export async function adjustStock(
  db: D1Database,
  standId: number,
  itemId: number,
  seen: number,
  next: number,
  now: number,
): Promise<Result> {
  if (!Number.isInteger(next) || next < 0 || !Number.isInteger(seen)) {
    return { ok: false, message: "Stock must be a whole number, 0 or more." };
  }
  try {
    const res = await db
      .prepare("UPDATE items SET stock = stock + ?, updated_at = ? WHERE id = ? AND stand_id = ?")
      .bind(next - seen, now, itemId, standId)
      .run();
    return res.meta.changes === 1 ? { ok: true } : { ok: false, message: "That item isn't on this stand." };
  } catch (err) {
    if (err instanceof Error && err.message.includes("CHECK")) {
      const row = await db.prepare("SELECT held FROM items WHERE id = ?").bind(itemId).first<{ held: number }>();
      return { ok: false, message: heldMessage(row?.held ?? 0) };
    }
    throw err;
  }
}

/** Sold out is a flag: stock is unchanged, so the next visit's walk-in math stays right. */
export async function setSoldOut(db: D1Database, standId: number, itemId: number, on: boolean, now: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE items SET sold_out = ?, updated_at = ? WHERE id = ? AND stand_id = ?")
    .bind(on ? 1 : 0, now, itemId, standId)
    .run();
  return res.meta.changes === 1;
}

/** Hidden items (out of season) are not shown to customers at all. */
export async function setHidden(db: D1Database, standId: number, itemId: number, hidden: boolean, now: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE items SET active = ?, updated_at = ? WHERE id = ? AND stand_id = ?")
    .bind(hidden ? 0 : 1, now, itemId, standId)
    .run();
  return res.meta.changes === 1;
}
