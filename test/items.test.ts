import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOrderByToken } from "../src/db";
import { addItem, adjustStock, editItem, setHidden, setSoldOut } from "../src/items";
import { packOrder, pickUpOrder, placeOrder } from "../src/orders";
import { idem, itemRow, makeStand } from "./helpers";

const db = () => env.DB;
const now = () => Date.now();

describe("items", () => {
  it("adds and edits an item, and checks the fields", async () => {
    const f = await makeStand({ items: [] });
    const added = await addItem(db(), f.stand.id, { name: "Honey", unit: "jar", priceCents: 1200, stock: 4 }, now());
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(await itemRow(added.id)).toMatchObject({ name: "Honey", unit_label: "jar", price_cents: 1200, stock: 4 });
    expect(await editItem(db(), f.stand.id, added.id, { name: "Raw honey", unit: "jar", priceCents: 1300 }, now())).toEqual({ ok: true });
    expect((await itemRow(added.id)).name).toBe("Raw honey");
    expect(await addItem(db(), f.stand.id, { name: "", unit: "", priceCents: 100, stock: 0 }, now())).toEqual({
      ok: false,
      message: "Give the item a name.",
    });
  });

  it("won't set stock below what is held for orders", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    await placeOrder(db(), f.stand, { idemKey: idem(), name: "A", contact: "", whenNote: "", qty: { [eggs]: 3 } }, { now: now(), roundStep: 5 });
    expect(await adjustStock(db(), f.stand.id, eggs, 10, 2, now())).toEqual({ ok: false, message: "3 are held for orders." });
    expect((await itemRow(eggs)).stock).toBe(10);
  });

  it("applies the change from the number the seller saw, so a pickup at the same moment is kept", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const r = await placeOrder(db(), f.stand, { idemKey: idem(), name: "A", contact: "", whenNote: "", qty: { [eggs]: 2 } }, { now: now(), roundStep: 5 });
    if (!r.ok) throw new Error("place failed");
    const order = (await getOrderByToken(db(), r.token))!;
    await packOrder(db(), f.stand.id, order.id, {}, { now: now(), roundStep: 5 });
    // The seller's page still shows 10 when the customer's pickup lands.
    await pickUpOrder(db(), f.stand.id, order.id, "customer", now());
    expect(await adjustStock(db(), f.stand.id, eggs, 10, 12, now())).toEqual({ ok: true });
    expect((await itemRow(eggs)).stock).toBe(10);
  });

  it("sold out is a flag that leaves stock alone; hide takes the item off the stand page", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    expect(await setSoldOut(db(), f.stand.id, eggs, true, now())).toBe(true);
    expect(await itemRow(eggs)).toMatchObject({ sold_out: 1, stock: 10, active: 1 });
    expect(await setHidden(db(), f.stand.id, eggs, true, now())).toBe(true);
    expect((await itemRow(eggs)).active).toBe(0);
  });

  it("can't touch another stand's item", async () => {
    const f = await makeStand();
    const other = await makeStand();
    expect(await setSoldOut(db(), other.stand.id, f.item("Eggs").id, true, now())).toBe(false);
    expect(await adjustStock(db(), other.stand.id, f.item("Eggs").id, 10, 20, now())).toEqual({ ok: false, message: "That item isn't on this stand." });
  });
});
