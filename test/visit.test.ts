import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOrderByToken, getStand } from "../src/db";
import { cancelOrder, packOrder, pickUpOrder, placeOrder } from "../src/orders";
import type { Order } from "../src/types";
import { computeVisit, saveVisit, weekSummary, type VisitForm, type VisitItem } from "../src/visit";
import { idem, itemRow, makeStand, type Fixture } from "./helpers";

const db = () => env.DB;
const clock = () => ({ now: Date.now(), roundStep: 5 });

async function order(f: Fixture, qty: Record<number, number>): Promise<Order> {
  const r = await placeOrder(db(), f.stand, { idemKey: idem(), name: "Bob", contact: "", whenNote: "", qty }, clock());
  if (!r.ok) throw new Error(r.message);
  return (await getOrderByToken(db(), r.token))!;
}

function form(over: Partial<VisitForm>): VisitForm {
  return { visitKey: idem(), unpack: [], gone: [], pack: {}, entries: {}, cashCounted: null, confirmed: false, ...over };
}

const item = (over: Partial<VisitItem>): VisitItem => ({
  id: 1,
  name: "Eggs",
  priceCents: 500,
  stock: 10,
  held: 0,
  shortSinceVisit: 0,
  inBaskets: 0,
  ...over,
});

describe("computeVisit (pure)", () => {
  it("a blank count changes nothing but the restock", () => {
    const plan = computeVisit([item({ shortSinceVisit: 2 })], { 1: { counted: null, removed: 0, restocked: 5 } }, false);
    expect(plan.errors).toEqual([]);
    expect(plan.lines[0]).toMatchObject({ walkInSold: 0, stockDelta: 5, tallyDelta: 0, counted: null });
    expect(plan.walkinCents).toBe(0);
  });

  it("walk-in sold = stock minus what is present, plus the short-pack tally", () => {
    const plan = computeVisit([item({ stock: 10, inBaskets: 3, held: 3, shortSinceVisit: 1 })], { 1: { counted: 4, removed: 1, restocked: 6 } }, false);
    expect(plan.lines[0]).toMatchObject({ present: 7, walkInSold: 4, stockDelta: 2, tallyDelta: -1, foundMore: 0 });
    expect(plan.walkinCents).toBe(2000);
  });

  it("a small 'found more' corrects stock without asking", () => {
    const plan = computeVisit([item({ stock: 10 })], { 1: { counted: 12, removed: 0, restocked: 0 } }, false);
    expect(plan.needsConfirm).toEqual([]);
    expect(plan.lines[0]).toMatchObject({ foundMore: 2, walkInSold: 0, stockDelta: 2 });
  });

  it("a large 'found more' needs a confirm", () => {
    const plan = computeVisit([item({ stock: 4 })], { 1: { counted: 40, removed: 0, restocked: 0 } }, false);
    expect(plan.needsConfirm).toEqual([{ itemId: 1, name: "Eggs", counted: 40, expected: 4 }]);
    const confirmed = computeVisit([item({ stock: 4 })], { 1: { counted: 40, removed: 0, restocked: 0 } }, true);
    expect(confirmed.needsConfirm).toEqual([]);
    expect(confirmed.lines[0]!.stockDelta).toBe(36);
  });

  it("refuses removing more than was counted, or removing without a count", () => {
    expect(computeVisit([item({})], { 1: { counted: 2, removed: 3, restocked: 0 } }, false).errors).toEqual([
      { itemId: 1, message: "You can't remove more than you counted." },
    ]);
    expect(computeVisit([item({})], { 1: { counted: null, removed: 1, restocked: 0 } }, false).errors).toEqual([
      { itemId: 1, message: "Count the shelf before removing any." },
    ]);
  });

  it("refuses a count that leaves less than is held for waiting orders", () => {
    const plan = computeVisit([item({ stock: 10, held: 4, inBaskets: 0 })], { 1: { counted: 3, removed: 0, restocked: 0 } }, false);
    expect(plan.errors[0]?.message).toBe("4 are held for orders waiting to be packed. Pack them first, then count.");
  });
});

describe("saveVisit", () => {
  it("matches the worked example: $37 expected, $35 counted, $2 short", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 12 }, { name: "Tomatoes", price: 400, stock: 8 }] });
    const eggs = f.item("Eggs").id;
    const tomatoes = f.item("Tomatoes").id;
    const bob = await order(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, bob.id, {}, clock());
    await pickUpOrder(db(), f.stand.id, bob.id, "customer", Date.now()); // "I left $10"
    const alice = await order(f, { [eggs]: 3 });
    await packOrder(db(), f.stand.id, alice.id, {}, clock()); // basket on the shelf

    const r = await saveVisit(db(), f.stand, form({
      entries: {
        [eggs]: { counted: 4, removed: 1, restocked: 6 },
        [tomatoes]: { counted: 5, removed: 0, restocked: 0 },
      },
      cashCounted: 3500,
    }), clock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const visit = await db().prepare("SELECT * FROM visits WHERE id = ?").bind(r.visitId).first();
    expect(visit).toMatchObject({ walkin_cents: 2700, app_cash_cents: 1000, expected_cents: 3700, cash_counted_cents: 3500 });
    expect(await itemRow(eggs)).toMatchObject({ stock: 12, held: 3, short_since_visit: 0 });
    expect(await itemRow(tomatoes)).toMatchObject({ stock: 5, held: 0 });
    expect((await getStand(db(), f.stand.id))!.last_counted_at).not.toBeNull();
  });

  it("unpacks, closes gone baskets and packs inside the visit before counting", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const a = await order(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, a.id, {}, clock());
    await cancelOrder(db(), f.stand.id, a.id, Date.now()); // basket of 2 to unpack
    const b = await order(f, { [eggs]: 3 });
    await packOrder(db(), f.stand.id, b.id, {}, clock()); // basket of 3; B takes it without tapping
    const c = await order(f, { [eggs]: 2 }); // waiting to be packed
    const d = await order(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, d.id, { [eggs]: 1 }, clock()); // short 1: a walk-in took it
    // A walk-in also took one more loose. After packing C, the shelf holds A's unpacked 2.

    const r = await saveVisit(db(), f.stand, form({
      unpack: [a.id],
      gone: [b.id],
      pack: { [c.id]: { [eggs]: 2 } },
      entries: { [eggs]: { counted: 2, removed: 0, restocked: 0 } },
    }), clock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await getOrderByToken(db(), a.public_token))!.to_unpack).toBe(0);
    expect((await getOrderByToken(db(), b.public_token))!).toMatchObject({ status: "picked_up", closed_by: "visit" });
    expect((await getOrderByToken(db(), c.public_token))!.status).toBe("ready");
    expect(await itemRow(eggs)).toMatchObject({ stock: 5, held: 3, short_since_visit: 0 });
    const visit = await db().prepare("SELECT * FROM visits WHERE id = ?").bind(r.visitId).first();
    expect(visit).toMatchObject({ walkin_cents: 1000, app_cash_cents: 1500, expected_cents: 2500, cash_counted_cents: null });
  });

  it("saves once when the same visit is sent twice", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const v = form({ entries: { [eggs]: { counted: 6, removed: 0, restocked: 4 } } });
    const first = await saveVisit(db(), f.stand, v, clock());
    const second = await saveVisit(db(), f.stand, v, clock());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.visitId).toBe(first.visitId);
    const { results } = await db().prepare("SELECT id FROM visits WHERE stand_id = ?").bind(f.stand.id).all();
    expect(results).toHaveLength(1);
    expect((await itemRow(eggs)).stock).toBe(10);
  });

  it("writes nothing when a large 'found more' is not confirmed", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 4 }] });
    const eggs = f.item("Eggs").id;
    const r = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 40, removed: 0, restocked: 0 } } }), clock());
    expect(r).toMatchObject({ ok: false, needsConfirm: [{ itemId: eggs, counted: 40, expected: 4 }] });
    expect((await itemRow(eggs)).stock).toBe(4);
    const ok = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 40, removed: 0, restocked: 0 } }, confirmed: true }), clock());
    expect(ok.ok).toBe(true);
    expect((await itemRow(eggs)).stock).toBe(40);
  });

  it("leaves blank items alone and only records a count time when something was counted", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const d = await order(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, d.id, { [eggs]: 1 }, clock()); // tally 1
    const r = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: null, removed: 0, restocked: 3 } } }), clock());
    expect(r.ok).toBe(true);
    expect(await itemRow(eggs)).toMatchObject({ stock: 12, short_since_visit: 1 });
    expect((await getStand(db(), f.stand.id))!.last_counted_at).toBeNull();
  });

  it("clears 'sold out' for items counted or restocked with stock free, and only those", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 0 }, { name: "Jam", price: 600, stock: 5 }] });
    const eggs = f.item("Eggs").id;
    const jam = f.item("Jam").id;
    await db().prepare("UPDATE items SET sold_out = 1 WHERE stand_id = ?").bind(f.stand.id).run();
    const r = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 0, removed: 0, restocked: 6 } } }), clock());
    expect(r.ok).toBe(true);
    expect((await itemRow(eggs)).sold_out).toBe(0);
    expect((await itemRow(jam)).sold_out).toBe(1);
  });

  it("refuses a count that would leave less than an order that came in mid-visit holds", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    await order(f, { [eggs]: 4 }); // not in the visit form
    const r = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 3, removed: 0, restocked: 0 } } }), clock());
    expect(r.ok).toBe(false);
    expect((await itemRow(eggs)).stock).toBe(10);
  });
});

describe("saveVisit when orders change while the seller counts", () => {
  it("refuses, names the order, and writes nothing when a packed order was cancelled", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const o = await order(f, { [eggs]: 3 });
    const v = form({ pack: { [o.id]: { [eggs]: 3 } }, entries: { [eggs]: { counted: 7, removed: 0, restocked: 0 } } });
    await cancelOrder(db(), f.stand.id, o.id, Date.now()); // while the seller was counting
    const r = await saveVisit(db(), f.stand, v, clock());
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.errors[0]!.message).toBe(`${o.code} was cancelled while you counted. Check the basket, then save again.`);
    const { results } = await db().prepare("SELECT id FROM visits WHERE stand_id = ?").bind(f.stand.id).all();
    expect(results).toHaveLength(0);
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0 });
  });

  it("is all-or-nothing when the order changes at the very last moment", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const o = await order(f, { [eggs]: 3 });
    const real = db();
    // A database whose batch() lets the customer cancel just before the visit's batch runs.
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await cancelOrder(real, f.stand.id, o.id, Date.now());
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const r = await saveVisit(racing, f.stand, form({
      pack: { [o.id]: { [eggs]: 3 } },
      entries: { [eggs]: { counted: 7, removed: 0, restocked: 0 } },
    }), clock());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain(`${o.code} was cancelled while you counted`);
    const { results } = await real.prepare("SELECT id FROM visits WHERE stand_id = ?").bind(f.stand.id).all();
    expect(results).toHaveLength(0);
    // Only the cancel happened: its hold is gone, and nothing was packed or counted.
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0, short_since_visit: 0 });
    expect((await getOrderByToken(real, o.public_token))!).toMatchObject({ status: "cancelled", to_unpack: 0 });
  });

  it("does not count short-packed units twice when they turn up on the shelf", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const o = await order(f, { [eggs]: 5 });
    await packOrder(db(), f.stand.id, o.id, { [eggs]: 3 }, clock()); // 2 missing: stock 8, tally 2
    // At the visit the 2 turn up: 7 loose + 3 in the basket = all 10.
    const r = await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 7, removed: 0, restocked: 0 } } }), clock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const visit = await db().prepare("SELECT walkin_cents FROM visits WHERE id = ?").bind(r.visitId).first();
    expect(visit).toMatchObject({ walkin_cents: 0 });
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 3, short_since_visit: 0 });
  });

  it("includes hidden items that still have a tally", async () => {
    const f = await makeStand({ items: [{ name: "Garlic", price: 150, stock: 10 }] });
    const garlic = f.item("Garlic").id;
    const o = await order(f, { [garlic]: 4 });
    await packOrder(db(), f.stand.id, o.id, { [garlic]: 1 }, clock()); // tally 3
    await db().prepare("UPDATE items SET active = 0 WHERE id = ?").bind(garlic).run();
    const r = await saveVisit(db(), f.stand, form({ entries: { [garlic]: { counted: 6, removed: 0, restocked: 0 } } }), clock());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const visit = await db().prepare("SELECT walkin_cents FROM visits WHERE id = ?").bind(r.visitId).first();
    expect(visit).toMatchObject({ walkin_cents: 450 }); // the 3 written off at packing, settled now
    expect((await itemRow(garlic)).short_since_visit).toBe(0);
  });
});

describe("weekSummary", () => {
  it("adds up shelf sales, app cash and the box difference for the last 7 days", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }] });
    const eggs = f.item("Eggs").id;
    const bob = await order(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, bob.id, {}, clock());
    await pickUpOrder(db(), f.stand.id, bob.id, "customer", Date.now());
    await saveVisit(db(), f.stand, form({ entries: { [eggs]: { counted: 5, removed: 0, restocked: 0 } }, cashCounted: 2200 }), clock());
    expect(await weekSummary(db(), f.stand.id, Date.now())).toEqual({ shelfCents: 1500, appCents: 1000, diffCents: -300 });
  });
});
