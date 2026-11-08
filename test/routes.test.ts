import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { randomToken, sha256Hex } from "../src/codes";
import { getOrderByToken } from "../src/db";
import { app } from "../src/index";
import { packOrder, placeOrder, releaseOrder } from "../src/orders";
import { idem, itemRow, makeStand, setStand, type Fixture } from "./helpers";

const db = () => env.DB;

/** Page text with HTML entities decoded, so tests compare words, not escaping. */
async function text(res: Response): Promise<string> {
  return (await res.text())
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function get(path: string) {
  return app.request(path, {}, env);
}

function post(path: string, fields: Record<string, string>) {
  return app.request(path, { method: "POST", body: new URLSearchParams(fields) }, env);
}

async function link(sellerId: number, revoked = false): Promise<string> {
  const token = randomToken();
  await db()
    .prepare("INSERT INTO seller_links (seller_id, token_hash, label, revoked_at, created_at) VALUES (?, ?, 'test', ?, ?)")
    .bind(sellerId, await sha256Hex(token), revoked ? Date.now() : null, Date.now())
    .run();
  return token;
}

async function orderFor(f: Fixture, qty: Record<number, number>) {
  const r = await placeOrder(db(), f.stand, { idemKey: idem(), name: "Alice", contact: "", whenNote: "", qty }, { now: Date.now(), roundStep: 5 });
  if (!r.ok) throw new Error(r.message);
  return (await getOrderByToken(db(), r.token))!;
}

describe("stand page", () => {
  it("shows items with honest counts and sends security headers", async () => {
    const f = await makeStand({ mode: "unattended" });
    const res = await get(`/${f.stand.slug}`);
    expect(res.status).toBe(200);
    const body = await text(res);
    expect(body).toContain("about 10 left");
    expect(body).toContain("Walk-ins may buy some before your order is packed.");
    expect(body).toContain("At the stand now? Just take what you need and pay in the box.");
    expect(body).toContain("Reserve, pay cash at pickup");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("greys out a sold-out item instead of hiding it", async () => {
    const f = await makeStand();
    await db().prepare("UPDATE items SET sold_out = 1 WHERE id = ?").bind(f.item("Eggs").id).run();
    const body = await text(await get(`/${f.stand.slug}`));
    expect(body).toMatch(/Eggs[\s\S]*Sold out/);
  });

  it("explains unknown, paused and switched-off stands", async () => {
    const unknown = await get("/no-such-stand");
    expect(unknown.status).toBe(404);
    expect(await text(unknown)).toContain("No stand at this address");

    const f = await makeStand();
    await setStand(f.stand.id, { paused: 1, message: "Back in June" });
    const paused = await text(await get(`/${f.stand.slug}`));
    expect(paused).toContain("Online orders are paused.");
    expect(paused).toContain("Back in June");

    await setStand(f.stand.id, { paused: 0, active: 0 });
    expect(await text(await get(`/${f.stand.slug}`))).toContain("This stand isn't taking online orders right now.");
  });

  it("says when there is nothing listed yet", async () => {
    const f = await makeStand({ items: [] });
    expect(await text(await get(`/${f.stand.slug}`))).toContain("Nothing listed yet. Check back soon.");
  });

  it("places an order and redirects to the order page", async () => {
    const f = await makeStand();
    const res = await post(`/${f.stand.slug}/order`, { idem_key: idem(), name: "Alice", contact: "", when_note: "after 4", [`q_${f.item("Eggs").id}`]: "2" });
    expect(res.status).toBe(303);
    const location = res.headers.get("Location")!;
    expect(location).toMatch(/^\/o\/[A-Za-z0-9_-]+$/);
    const page = await text(await get(location));
    expect(page).toContain("Reserved. Don't come yet; come when this page says Ready.");
    expect(page).toContain("Bring about <strong>$10.00</strong>");
    expect(page).toContain("Save this link");
  });

  it("keeps what was typed when something is missing", async () => {
    const f = await makeStand();
    const res = await post(`/${f.stand.slug}/order`, { idem_key: idem(), name: "", [`q_${f.item("Eggs").id}`]: "2" });
    expect(res.status).toBe(422);
    const body = await text(res);
    expect(body).toContain("Add your name so the farmer can label your basket.");
    expect(body).toContain('value="2"');
  });
});

describe("order page", () => {
  it("shows the was/now total after packing short", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 10, unit: "dozen" }] });
    const eggs = f.item("Eggs").id;
    const order = await orderFor(f, { [eggs]: 3 });
    await packOrder(db(), f.stand.id, order.id, { [eggs]: 2 }, { now: Date.now(), roundStep: 5 });
    const page = await text(await get(`/o/${order.public_token}`));
    expect(page).toContain(`Ready. Basket ${order.code} · Alice.`);
    expect(page).toContain("Only 2 of 3 dozen eggs were left.");
    expect(page).toContain("Bring <strong>$10.00</strong> cash (was $15.00).");
    expect(page).toContain("I picked it up and left $10.00");
    expect(page).toContain("Basket not there?");
  });

  it("words a release by what happened before", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const a = await orderFor(f, { [eggs]: 1 });
    await releaseOrder(db(), f.stand.id, a.id, Date.now());
    expect(await text(await get(`/o/${a.public_token}`))).toContain("The farmer couldn't fill this order. Nothing to pay.");
    const b = await orderFor(f, { [eggs]: 1 });
    await packOrder(db(), f.stand.id, b.id, {}, { now: Date.now(), roundStep: 5 });
    await releaseOrder(db(), f.stand.id, b.id, Date.now());
    expect(await text(await get(`/o/${b.public_token}`))).toContain("This basket wasn't picked up and went back on the shelf.");
  });

  it("lets the customer cancel, and reports the version for refresh", async () => {
    const f = await makeStand();
    const order = await orderFor(f, { [f.item("Eggs").id]: 1 });
    const v = await (await get(`/o/${order.public_token}/v`)).json();
    expect(v).toMatchObject({ final: false, label: "Reserved" });
    const res = await post(`/o/${order.public_token}/cancel`, {});
    expect(res.status).toBe(303);
    expect(await text(await get(`/o/${order.public_token}`))).toContain("You cancelled this order. Nothing to pay.");
    expect(await (await get(`/o/${order.public_token}/v`)).json()).toMatchObject({ final: true });
  });

  it("a staffed stand's customer can't mark their own pickup", async () => {
    const f = await makeStand({ mode: "staffed" });
    const eggs = f.item("Eggs").id;
    const order = await orderFor(f, { [eggs]: 1 });
    await packOrder(db(), f.stand.id, order.id, {}, { now: Date.now(), roundStep: 5 });
    await post(`/o/${order.public_token}/picked-up`, {});
    expect((await getOrderByToken(db(), order.public_token))!.status).toBe("ready");
  });
});

describe("seller pages", () => {
  it("refuses unknown and revoked links, while another link still works", async () => {
    const f = await makeStand();
    const good = await link(f.sellerId);
    const revoked = await link(f.sellerId, true);
    expect((await get(`/admin/${randomToken()}`)).status).toBe(404);
    const bad = await get(`/admin/${revoked}`);
    expect(bad.status).toBe(404);
    expect(await text(bad)).toContain("Link not recognised");
    const ok = await get(`/admin/${good}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
  });

  it("shows the key warning, the next-action line and the first-run checklist", async () => {
    const f = await makeStand({ items: [] });
    const body = await text(await get(`/admin/${await link(f.sellerId)}`));
    expect(body).toContain("This link is your key. Don't share it.");
    expect(body).toContain("Start visit");
    expect(body).toContain("no visit yet");
    expect(body).toContain("Add your first item");
  });

  it("can't reach another seller's stand", async () => {
    const mine = await makeStand();
    const theirs = await makeStand();
    const token = await link(mine.sellerId);
    const res = await post(`/admin/${token}/${theirs.stand.slug}/items/${theirs.item("Eggs").id}/sold-out`, { on: "1" });
    expect(res.status).toBe(404);
    expect((await itemRow(theirs.item("Eggs").id)).sold_out).toBe(0);
  });

  it("packs an order from the admin page", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    const order = await orderFor(f, { [eggs]: 3 });
    const token = await link(f.sellerId);
    const res = await post(`/admin/${token}/${f.stand.slug}/orders/${order.id}/pack`, { [`item_${eggs}`]: "2" });
    expect(res.status).toBe(303);
    expect((await getOrderByToken(db(), order.public_token))!).toMatchObject({ status: "ready", cash_cents: 1000 });
  });

  it("shows a friendly message when stock would drop below what is held", async () => {
    const f = await makeStand();
    const eggs = f.item("Eggs").id;
    await orderFor(f, { [eggs]: 3 });
    const token = await link(f.sellerId);
    const res = await post(`/admin/${token}/${f.stand.slug}/items/${eggs}/stock`, { seen: "10", stock: "1" });
    expect(res.status).toBe(303);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(decodeURIComponent(cookie)).toContain("3 are held for orders.");
  });

  it("asks to confirm a large 'found more' before saving a visit", async () => {
    const f = await makeStand({ items: [{ name: "Eggs", price: 500, stock: 4 }] });
    const eggs = f.item("Eggs").id;
    const token = await link(f.sellerId);
    const key = idem();
    const first = await post(`/admin/${token}/${f.stand.slug}/visit`, { visit_key: key, [`count_${eggs}`]: "40", cash: "" });
    expect(first.status).toBe(422);
    expect(await text(first)).toContain("You counted 40 eggs; we expected 4. Is 40 right?");
    const second = await post(`/admin/${token}/${f.stand.slug}/visit`, { visit_key: key, [`count_${eggs}`]: "40", confirm: "1", cash: "12.50" });
    expect(second.status).toBe(303);
    const summary = await text(await get(second.headers.get("Location")!));
    expect(summary).toContain("Saved");
    expect(summary).toContain("This week:");
  });

  it("exports CSV with formula injection defused, and prints a sign with a QR code", async () => {
    const f = await makeStand();
    const r = await placeOrder(db(), f.stand, { idemKey: idem(), name: "=HYPERLINK(\"x\")", contact: "", whenNote: "", qty: { [f.item("Eggs").id]: 1 } }, { now: Date.now(), roundStep: 5 });
    expect(r.ok).toBe(true);
    const token = await link(f.sellerId);
    const res = await get(`/admin/${token}/${f.stand.slug}/orders.csv`);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csvText = await res.text();
    expect(csvText.split("\r\n")[0]).toBe("Created,Code,Status,Customer,Phone,Items,Total,Cash,Closed,Closed by");
    expect(csvText).toContain(`"'=HYPERLINK(""x"")"`);
    const sign = await text(await get(`/admin/${token}/${f.stand.slug}/sign`));
    expect(sign).toContain("<svg");
    expect(sign).toContain(`/${f.stand.slug}`);
    expect(sign).toContain("Labelled baskets are reserved for online orders");
  });

  it("reports a version for refresh", async () => {
    const f = await makeStand();
    const res = await get(`/admin/${await link(f.sellerId)}/_v`);
    expect(await res.json()).toHaveProperty("v");
  });

  it("every page's refresh address answers (no false 'No signal')", async () => {
    const f = await makeStand();
    const order = await orderFor(f, { [f.item("Eggs").id]: 1 });
    for (const page of [`/admin/${await link(f.sellerId)}`, `/o/${order.public_token}`]) {
      const body = await (await get(page)).text();
      const poll = /data-poll="([^"]+)"/.exec(body)?.[1];
      expect(poll, page).toBeTruthy();
      const res = await get(poll!);
      expect(res.status, poll).toBe(200);
      expect(await res.json()).toHaveProperty("v");
    }
  });

  it("lists every stand's next actions at the top, before any stand's details", async () => {
    const first = await makeStand();
    const second = await makeStand({ sellerId: first.sellerId });
    await orderFor(second, { [second.item("Eggs").id]: 1 });
    const body = await text(await get(`/admin/${await link(first.sellerId)}`));
    const summary = body.indexOf(`${second.stand.name}</strong></a>: <a href="#pack-${second.stand.slug}">1 to pack</a>`);
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(body.indexOf(`id="stand-${first.stand.slug}"`));
  });
});
