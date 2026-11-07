import { env } from "cloudflare:workers";
import { listItems } from "../src/db";
import type { Item, Stand, StandMode } from "../src/types";

let counter = 0;

export interface Fixture {
  sellerId: number;
  stand: Stand;
  items: Item[];
  /** Item by name, for readable tests. */
  item: (name: string) => Item;
}

export async function makeStand(
  opts: {
    mode?: StandMode;
    items?: Array<{ name: string; price: number; stock: number; unit?: string }>;
    sellerId?: number;
  } = {},
): Promise<Fixture> {
  const db = env.DB;
  const now = Date.now();
  counter++;
  let sellerId = opts.sellerId;
  if (sellerId === undefined) {
    const s = await db
      .prepare("INSERT INTO sellers (name, created_at) VALUES (?, ?) RETURNING id")
      .bind(`Seller ${counter}`, now)
      .first<{ id: number }>();
    sellerId = s!.id;
  }
  const stand = await db
    .prepare(
      "INSERT INTO stands (seller_id, slug, name, mode, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(sellerId, `stand-${counter}-${Math.floor(Math.random() * 1e6)}`, `Stand ${counter}`, opts.mode ?? "unattended", now - 86_400_000)
    .first<Stand>();
  const defs = opts.items ?? [
    { name: "Eggs", price: 500, stock: 10, unit: "dozen" },
    { name: "Tomatoes", price: 400, stock: 8, unit: "bag" },
  ];
  let sort = 0;
  for (const d of defs) {
    await db
      .prepare(
        "INSERT INTO items (stand_id, name, unit_label, price_cents, stock, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(stand!.id, d.name, d.unit ?? "", d.price, d.stock, sort++, now, now)
      .run();
  }
  const items = await listItems(db, stand!.id);
  return {
    sellerId,
    stand: stand!,
    items,
    item: (name) => {
      const found = items.find((i) => i.name === name);
      if (!found) throw new Error(`no item ${name}`);
      return found;
    },
  };
}

export async function itemRow(id: number): Promise<Item> {
  return (await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>())!;
}

export async function setStand(id: number, fields: Record<string, string | number | null>): Promise<Stand> {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  return (await env.DB.prepare(`UPDATE stands SET ${sets} WHERE id = ? RETURNING *`)
    .bind(...keys.map((k) => fields[k] ?? null), id)
    .first<Stand>())!;
}

export function idem(): string {
  return `idem-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
