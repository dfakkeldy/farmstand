import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getLines, getOrderByToken } from "../src/db";
import {
  cancelOrder,
  clearUnpack,
  markNotFound,
  packOrder,
  pickUpOrder,
  placeOrder,
  releaseOrder,
  reopenOrder,
} from "../src/orders";
import { idem, itemRow, makeStand, setStand } from "./helpers";

const db = () => env.DB;
const opts = () => ({ now: Date.now(), roundStep: 5 });
const tz = "America/Halifax";

async function place(f: Awaited<ReturnType<typeof makeStand>>, qty: Record<number, number>, key = idem()) {
  return placeOrder(db(), f.stand, { idemKey: key, name: "Alice", contact: "", whenNote: "", qty }, opts());
}

async function placed(f: Awaited<ReturnType<typeof makeStand>>, qty: Record<number, number>) {
  const r = await place(f, qty);
  if (!r.ok) throw new Error(r.message);
  return (await getOrderByToken(db(), r.token))!;
}

describe("placeOrder", () => {
  it("holds the items and rounds the cash total", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10 }, { name: "Honey", price: 398, stock: 4 }] });
    const r = await place(f, { [f.item("Eggs").id]: 2, [f.item("Honey").id]: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = (await getOrderByToken(db(), r.token))!;
    expect(order.status).toBe("placed");
    expect(order.total_cents).toBe(1398);
    expect(order.cash_cents).toBe(1400);
    expect(order.code).toMatch(/^[A-Z]{3,5}-\d{2}$/);
    expect((await itemRow(f.item("Eggs").id)).held).toBe(2);
    expect((await itemRow(f.item("Honey").id)).held).toBe(1);
  });

  it("asks for a name", async () => {
    const f = await makeStand();
    const r = await placeOrder(db(), f.stand, { idemKey: idem(), name: "  ", contact: "", whenNote: "", qty: { [f.item("Eggs").id]: 1 } }, opts());
    expect(r).toMatchObject({ ok: false, kind: "invalid", message: "Add your name so the farmer can label your basket." });
  });

  it("asks for at least one item", async () => {
    const f = await makeStand();
    const r = await place(f, {});
    expect(r).toMatchObject({ ok: false, kind: "invalid", message: "Choose at least one item." });
  });

  it("caps the quantity per item", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 50 }] });
    const r = await place(f, { [f.item("Eggs").id]: 7 });
    expect(r).toMatchObject({ ok: false, kind: "invalid", message: "You can reserve up to 6 of each item." });
  });

  it("refuses paused and switched-off stands", async () => {
    const f = await makeStand();
    const paused = await setStand(f.stand.id, { paused: 1 });
    expect(await placeOrder(db(), paused, { idemKey: idem(), name: "A", contact: "", whenNote: "", qty: { [f.item("Eggs").id]: 1 } }, opts()))
      .toMatchObject({ ok: false, kind: "closed", message: "Online orders are paused." });
    const off = await setStand(f.stand.id, { paused: 0, active: 0 });
    expect(await placeOrder(db(), off, { idemKey: idem(), name: "A", contact: "", whenNote: "", qty: { [f.item("Eggs").id]: 1 } }, opts()))
      .toMatchObject({ ok: false, kind: "closed", message: "This stand isn't taking online orders right now." });
  });

  it("refuses an item marked sold out", async () => {
    const f = await makeStand();
    await db().prepare("UPDATE items SET sold_out = 1 WHERE id = ?").bind(f.item("Eggs").id).run();
    const r = await place(f, { [f.item("Eggs").id]: 1 });
    expect(r).toMatchObject({ ok: false, kind: "sold_out", message: "Eggs is sold out." });
  });

  it("tells the customer when someone took the last units first", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 3 }] });
    await placed(f, { [f.item("Eggs").id]: 1 });
    const r = await place(f, { [f.item("Eggs").id]: 3 });
    expect(r).toMatchObject({
      ok: false,
      kind: "sold_out",
      message: "Someone just took the last eggs. 2 left now. Nothing was reserved. Change your order and try again.",
    });
    expect((await itemRow(f.item("Eggs").id)).held).toBe(1);
  });

  it("lets exactly one of two simultaneous orders take the last unit", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 1 }] });
    const id = f.item("Eggs").id;
    const [a, b] = await Promise.all([place(f, { [id]: 1 }), place(f, { [id]: 1 })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, kind: "sold_out" });
    const row = await itemRow(id);
    expect(row.held).toBe(1);
    expect(row.stock).toBe(1);
    const { results } = await db().prepare("SELECT id FROM orders WHERE stand_id = ?").bind(f.stand.id).all();
    expect(results).toHaveLength(1);
  });

  it("makes one order from a double tap", async () => {
    const f = await makeStand();
    const key = idem();
    const [a, b] = await Promise.all([place(f, { [f.item("Eggs").id]: 2 }, key), place(f, { [f.item("Eggs").id]: 2 }, key)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.token).toBe(b.token);
    expect((await itemRow(f.item("Eggs").id)).held).toBe(2);
  });
});

describe("packOrder", () => {
  it("packs short: stock and held drop together, the tally grows, totals update", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 3 });
    expect(await packOrder(db(), f.stand.id, order.id, { [eggs]: 2 }, opts())).toBe("ready");
    const row = await itemRow(eggs);
    expect(row).toMatchObject({ stock: 9, held: 2, short_since_visit: 1 });
    const after = (await getOrderByToken(db(), order.public_token))!;
    expect(after).toMatchObject({ status: "ready", total_cents: 1000, cash_cents: 1000, orig_total_cents: 1500 });
    expect((await getLines(db(), order.id))[0]!.packed_qty).toBe(2);
  });

  it("releases an order packed with nothing (couldn't fill) and does not allow reopen", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    expect(await packOrder(db(), f.stand.id, order.id, { [eggs]: 0 }, opts())).toBe("released");
    expect(await itemRow(eggs)).toMatchObject({ stock: 8, held: 0, short_since_visit: 2 });
    const after = (await getOrderByToken(db(), order.public_token))!;
    expect(after).toMatchObject({ status: "released", prev_status: "placed", reopen_ok: 0, to_unpack: 0 });
    expect(await reopenOrder(db(), f.stand.id, order.id, { now: Date.now(), tz })).toBe("not_allowed");
  });

  it("is stale on an order that is no longer waiting", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    await cancelOrder(db(), f.stand.id, order.id, Date.now());
    expect(await packOrder(db(), f.stand.id, order.id, { [eggs]: 1 }, opts())).toBe("stale");
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0, short_since_visit: 0 });
  });
});

describe("closing orders", () => {
  it("pick up lowers stock and held by the packed units", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 3 });
    await packOrder(db(), f.stand.id, order.id, { [eggs]: 2 }, opts());
    expect(await pickUpOrder(db(), f.stand.id, order.id, "customer", Date.now())).toBe(true);
    expect(await itemRow(eggs)).toMatchObject({ stock: 7, held: 0 });
    const after = (await getOrderByToken(db(), order.public_token))!;
    expect(after).toMatchObject({ status: "picked_up", closed_by: "customer", reported_paid_cents: 1000, reopen_ok: 0 });
  });

  it("a seller can hand over an unpacked order at a staffed stand", async () => {
    const f = await makeStand({ mode: "staffed" });
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    expect(await pickUpOrder(db(), f.stand.id, order.id, "seller", Date.now())).toBe(true);
    expect(await itemRow(eggs)).toMatchObject({ stock: 8, held: 0 });
  });

  it("a customer cannot mark an unpacked order picked up", async () => {
    const f = await makeStand();
    const order = await placed(f, { [f.item("Eggs").id]: 2 });
    expect(await pickUpOrder(db(), f.stand.id, order.id, "customer", Date.now())).toBe(false);
  });

  it("release from placed frees the hold; release from ready also flags the basket to unpack", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const a = await placed(f, { [eggs]: 1 });
    const b = await placed(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, b.id, { [eggs]: 2 }, opts());
    expect(await releaseOrder(db(), f.stand.id, a.id, Date.now())).toBe(true);
    expect(await releaseOrder(db(), f.stand.id, b.id, Date.now())).toBe(true);
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0 });
    expect((await getOrderByToken(db(), a.public_token))!.to_unpack).toBe(0);
    expect((await getOrderByToken(db(), b.public_token))!).toMatchObject({ to_unpack: 1, prev_status: "ready" });
    expect(await clearUnpack(db(), f.stand.id, b.id, Date.now())).toBe(true);
    expect((await getOrderByToken(db(), b.public_token))!.to_unpack).toBe(0);
  });

  it("cancel after ready flags the basket; 'basket not there' too", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const a = await placed(f, { [eggs]: 1 });
    const b = await placed(f, { [eggs]: 1 });
    await packOrder(db(), f.stand.id, a.id, { [eggs]: 1 }, opts());
    await packOrder(db(), f.stand.id, b.id, { [eggs]: 1 }, opts());
    expect(await cancelOrder(db(), f.stand.id, a.id, Date.now())).toBe(true);
    expect(await markNotFound(db(), f.stand.id, b.id, Date.now())).toBe(true);
    expect((await getOrderByToken(db(), a.public_token))!).toMatchObject({ status: "cancelled", to_unpack: 1, closed_by: "customer" });
    expect((await getOrderByToken(db(), b.public_token))!).toMatchObject({ status: "not_found", to_unpack: 1 });
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0 });
  });

  it("'basket not there' needs a ready order", async () => {
    const f = await makeStand();
    const order = await placed(f, { [f.item("Eggs").id]: 1 });
    expect(await markNotFound(db(), f.stand.id, order.id, Date.now())).toBe(false);
  });

  it("nothing happens to a closed order", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 1 });
    await cancelOrder(db(), f.stand.id, order.id, Date.now());
    expect(await releaseOrder(db(), f.stand.id, order.id, Date.now())).toBe(false);
    expect(await pickUpOrder(db(), f.stand.id, order.id, "seller", Date.now())).toBe(false);
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 0 });
  });

  it("another stand's order cannot be touched", async () => {
    const f = await makeStand();
    const other = await makeStand();
    const order = await placed(f, { [f.item("Eggs").id]: 1 });
    expect(await releaseOrder(db(), other.stand.id, order.id, Date.now())).toBe(false);
  });
});

describe("reopenOrder", () => {
  it("undoes a seller's pick up", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, order.id, { [eggs]: 2 }, opts());
    await pickUpOrder(db(), f.stand.id, order.id, "seller", Date.now());
    expect(await reopenOrder(db(), f.stand.id, order.id, { now: Date.now(), tz })).toBe("ok");
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 2 });
    expect((await getOrderByToken(db(), order.public_token))!).toMatchObject({ status: "ready", closed_at: null });
  });

  it("undoes a seller's release while the basket is still there", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    await packOrder(db(), f.stand.id, order.id, { [eggs]: 2 }, opts());
    await releaseOrder(db(), f.stand.id, order.id, Date.now());
    expect(await reopenOrder(db(), f.stand.id, order.id, { now: Date.now(), tz })).toBe("ok");
    expect(await itemRow(eggs)).toMatchObject({ stock: 10, held: 2 });
    expect((await getOrderByToken(db(), order.public_token))!).toMatchObject({ status: "ready", to_unpack: 0 });
  });

  it("refuses when the stock has gone since", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 2 }] });
    const eggs = f.item("Eggs").id;
    const order = await placed(f, { [eggs]: 2 });
    await releaseOrder(db(), f.stand.id, order.id, Date.now());
    await placed(f, { [eggs]: 2 });
    expect(await reopenOrder(db(), f.stand.id, order.id, { now: Date.now(), tz })).toBe("no_stock");
    expect(await itemRow(eggs)).toMatchObject({ stock: 2, held: 2 });
  });

  it("refuses customer-closed orders and orders closed before the last visit", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const a = await placed(f, { [eggs]: 1 });
    await cancelOrder(db(), f.stand.id, a.id, Date.now());
    expect(await reopenOrder(db(), f.stand.id, a.id, { now: Date.now(), tz })).toBe("not_allowed");

    const b = await placed(f, { [eggs]: 1 });
    await pickUpOrder(db(), f.stand.id, b.id, "seller", Date.now() - 1000);
    await db()
      .prepare("INSERT INTO visits (stand_id, visit_key, at, walkin_cents, app_cash_cents, expected_cents) VALUES (?, ?, ?, 0, 0, 0)")
      .bind(f.stand.id, idem(), Date.now())
      .run();
    expect(await reopenOrder(db(), f.stand.id, b.id, { now: Date.now(), tz })).toBe("not_allowed");
  });
});
