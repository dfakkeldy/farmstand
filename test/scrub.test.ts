import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOrderByToken } from "../src/db";
import { cancelOrder, placeOrder } from "../src/orders";
import { scrub, SCRUB_AFTER_MS } from "../src/scrub";
import { idem, makeStand } from "./helpers";

describe("scrub", () => {
  it("removes contact details from closed orders older than 30 days and keeps totals", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const place = async () => {
      const r = await placeOrder(env.DB, f.stand, { idemKey: idem(), name: "Alice", contact: "902-555-0100", whenNote: "after 4", qty: { [eggs]: 1 } }, { now: Date.now(), roundStep: 5 });
      if (!r.ok) throw new Error(r.message);
      return (await getOrderByToken(env.DB, r.token))!;
    };
    const old = await place();
    const open = await place();
    const old2 = await place();
    const longAgo = Date.now() - SCRUB_AFTER_MS - 1000;
    await cancelOrder(env.DB, f.stand.id, old.id, longAgo);
    await cancelOrder(env.DB, f.stand.id, old2.id, Date.now()); // closed recently: kept

    expect(await scrub(env.DB, Date.now())).toBe(1);
    expect((await getOrderByToken(env.DB, old.public_token))!).toMatchObject({
      customer_name: "Customer",
      contact: null,
      when_note: null,
      total_cents: 500,
    });
    expect((await getOrderByToken(env.DB, open.public_token))!.contact).toBe("902-555-0100");
    expect((await getOrderByToken(env.DB, old2.public_token))!.contact).toBe("902-555-0100");
  });
});
