import { sha256Hex } from "./codes";
import type { Seller, Stand } from "./types";

/** The seller behind a secret admin link, or null if the link is unknown, revoked or switched off. */
export async function sellerFromToken(db: D1Database, token: string): Promise<Seller | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  return db
    .prepare(
      `SELECT s.* FROM seller_links l JOIN sellers s ON s.id = l.seller_id
       WHERE l.token_hash = ? AND l.revoked_at IS NULL AND s.active = 1`,
    )
    .bind(hash)
    .first<Seller>();
}

export async function standsForSeller(db: D1Database, sellerId: number): Promise<Stand[]> {
  const { results } = await db
    .prepare("SELECT * FROM stands WHERE seller_id = ? AND active = 1 ORDER BY id")
    .bind(sellerId)
    .all<Stand>();
  return results;
}

export async function standForSeller(db: D1Database, sellerId: number, slug: string): Promise<Stand | null> {
  return db
    .prepare("SELECT * FROM stands WHERE seller_id = ? AND slug = ? AND active = 1")
    .bind(sellerId, slug)
    .first<Stand>();
}
