import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("schema", () => {
  it("refuses an item with more held than in stock", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO sellers (id, name, created_at) VALUES (1, 'S', ?)").bind(now).run();
    await env.DB.prepare(
      "INSERT INTO stands (id, seller_id, slug, name, mode, created_at) VALUES (1, 1, 'x', 'X', 'staffed', ?)",
    ).bind(now).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO items (stand_id, name, price_cents, stock, held, created_at, updated_at) VALUES (1, 'Eggs', 500, 2, 3, ?, ?)",
      ).bind(now, now).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
