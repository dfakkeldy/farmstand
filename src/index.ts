import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { html } from "hono/html";
import { sellerFromToken, standForSeller, standsForSeller } from "./auth";
import { randomToken } from "./codes";
import { csv } from "./csv";
import { getLines, getOrderByToken, getStand, getStandBySlug, lastVisit, linesFor, listItems, listOrders } from "./db";
import { addItem, adjustStock, editItem, setHidden, setSoldOut } from "./items";
import { formatMoney, parseMoney } from "./money";
import {
  canReopen,
  cancelOrder,
  clearUnpack,
  markNotFound,
  packOrder,
  pickUpOrder,
  placeOrder,
  releaseOrder,
  reopenOrder,
} from "./orders";
import { scrub } from "./scrub";
import { localDate } from "./time";
import { OPEN, type Order, type Seller, type Stand, units } from "./types";
import { getVisit, saveVisit, type VisitEntry, type VisitForm, weekSummary } from "./visit";
import { adminPage, type StandPanel } from "./views/admin";
import { messagePage, REPO_URL } from "./views/layout";
import { FINAL, orderPage, statusLabel } from "./views/order";
import { signPage } from "./views/sign";
import { standPage } from "./views/stand";
import { visitPage, visitSummaryPage } from "./views/visit";

type AppEnv = { Bindings: Env; Variables: { seller: Seller; token: string } };
type C = Context<AppEnv>;

const app = new Hono<AppEnv>();
const SLUG = "[a-z0-9][a-z0-9-]{0,39}";

function settings(env: Env) {
  return {
    roundStep: Number(env.CASH_ROUND_CENTS) || 5,
    tz: String(env.TIMEZONE || "America/Halifax"),
  };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  if (c.req.path.startsWith("/admin/") || c.req.path.startsWith("/o/")) {
    // Secret links: keep them out of search engines and caches.
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("Cache-Control", "no-store");
  }
});

app.onError((err, c) => {
  console.error(err);
  return c.html(messagePage("Something went wrong", "Please try again in a moment."), 500);
});

app.notFound((c) => c.html(messagePage("Page not found", "Check the link."), 404));

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strings(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function intOr(v: string | undefined, fallback: number): number {
  return v === undefined || v.trim() === "" ? fallback : Number(v);
}

// ---------- Public pages ----------

app.get("/", (c) =>
  c.html(
    messagePage(
      "Farmstand",
      "Reserve farmstand items online and pay cash at pickup. Scan the QR code on a stand's sign to see what's there.",
      html`<p><a href="${REPO_URL}">Source code (MIT licence)</a></p>`,
    ),
  ),
);

function noStand(c: C) {
  return c.html(messagePage("No stand at this address", "Check the sign for the link."), 404);
}

function turnstileKey(env: Env, stand: Stand): string | undefined {
  const key = String(env.TURNSTILE_SITE_KEY ?? "");
  return stand.turnstile_on && key && env.TURNSTILE_SECRET ? key : undefined;
}

async function turnstileOk(secret: string, token: string, ip: string | undefined): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await res.json<{ success?: boolean }>();
    return data.success === true;
  } catch {
    return false;
  }
}

async function renderStand(
  c: C,
  stand: Stand,
  extra: { error?: string; values?: Parameters<typeof standPage>[0]["values"] },
  status: 200 | 422 = 200,
) {
  const { tz, roundStep } = settings(c.env);
  const items = await listItems(c.env.DB, stand.id);
  return c.html(
    standPage({
      stand,
      items,
      now: Date.now(),
      tz,
      roundStep,
      idemKey: randomToken(16),
      turnstileSiteKey: turnstileKey(c.env, stand),
      ...extra,
    }),
    status,
  );
}

app.get(`/:slug{${SLUG}}`, async (c) => {
  const stand = await getStandBySlug(c.env.DB, c.req.param("slug"));
  if (!stand) return noStand(c);
  if (!stand.active) return c.html(messagePage(stand.name, "This stand isn't taking online orders right now."));
  return renderStand(c, stand, {});
});

app.post(`/:slug{${SLUG}}/order`, async (c) => {
  const stand = await getStandBySlug(c.env.DB, c.req.param("slug"));
  if (!stand) return noStand(c);
  if (!stand.active) return c.html(messagePage(stand.name, "This stand isn't taking online orders right now."));
  const body = await c.req.parseBody();
  const qty: Record<number, number> = {};
  for (const [k, v] of Object.entries(body)) {
    const m = /^q_(\d+)$/.exec(k);
    if (m && typeof v === "string" && v.trim() !== "") qty[Number(m[1])] = Number(v);
  }
  const values = { name: str(body.name), contact: str(body.contact), whenNote: str(body.when_note), qty };

  const siteKey = turnstileKey(c.env, stand);
  if (siteKey && c.env.TURNSTILE_SECRET) {
    const ok = await turnstileOk(c.env.TURNSTILE_SECRET, str(body["cf-turnstile-response"]), c.req.header("CF-Connecting-IP"));
    if (!ok) return renderStand(c, stand, { error: "We couldn't check that you're a person. Please try again.", values }, 422);
  }

  const { roundStep } = settings(c.env);
  const result = await placeOrder(
    c.env.DB,
    stand,
    { idemKey: str(body.idem_key) || randomToken(16), name: values.name, contact: values.contact, whenNote: values.whenNote, qty },
    { now: Date.now(), roundStep },
  );
  if (result.ok) return c.redirect(`/o/${result.token}`, 303);
  return renderStand(c, stand, { error: result.message, values }, result.kind === "closed" ? 200 : 422);
});

async function findOrder(c: C) {
  const order = await getOrderByToken(c.env.DB, c.req.param("token") ?? "");
  if (!order) return null;
  const stand = await getStand(c.env.DB, order.stand_id);
  return stand ? { order, stand } : null;
}

const noOrder = (c: C) => c.html(messagePage("Order not found", "Check the link, or ask the farmer."), 404);

app.get("/o/:token", async (c) => {
  const found = await findOrder(c);
  if (!found) return noOrder(c);
  const { tz } = settings(c.env);
  const url = `${new URL(c.req.url).origin}/o/${found.order.public_token}`;
  const lines = await getLines(c.env.DB, found.order.id);
  return c.html(orderPage({ ...found, lines, now: Date.now(), tz, url }));
});

app.get("/o/:token/v", async (c) => {
  const found = await findOrder(c);
  if (!found) return c.json({ error: "not found" }, 404);
  const { order } = found;
  return c.json({ v: String(order.updated_at), final: FINAL.has(order.status), label: statusLabel(order) });
});

app.post("/o/:token/:action{cancel|picked-up|not-found}", async (c) => {
  const found = await findOrder(c);
  if (!found) return noOrder(c);
  const { order, stand } = found;
  const now = Date.now();
  const action = c.req.param("action");
  if (action === "cancel") await cancelOrder(c.env.DB, stand.id, order.id, now);
  if (action === "not-found") await markNotFound(c.env.DB, stand.id, order.id, now);
  if (action === "picked-up" && stand.mode === "unattended") await pickUpOrder(c.env.DB, stand.id, order.id, "customer", now);
  return c.redirect(`/o/${order.public_token}`, 303);
});

// ---------- Seller pages ----------

const requireSeller = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.param("token") ?? "";
  const seller = await sellerFromToken(c.env.DB, token);
  if (!seller) {
    return c.html(
      messagePage("Link not recognised", "This link doesn't work any more. Ask the person who set up your stand for a new one."),
      404,
    );
  }
  c.set("seller", seller);
  c.set("token", token);
  await next();
});
app.use("/admin/:token", requireSeller);
app.use("/admin/:token/*", requireSeller);

async function sellerStand(c: C): Promise<Stand | null> {
  return standForSeller(c.env.DB, c.get("seller").id, c.req.param("slug") ?? "");
}

const noSellerStand = (c: C) => c.html(messagePage("Stand not found", "This stand isn't on your account."), 404);

function backToAdmin(c: C, stand: Stand, flash = "") {
  if (flash) {
    setCookie(c, "flash", flash, {
      path: "/admin",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 60,
      secure: new URL(c.req.url).protocol === "https:",
    });
  }
  return c.redirect(`/admin/${c.get("token")}#stand-${stand.slug}`, 303);
}

async function adminVersion(db: D1Database, sellerId: number): Promise<string> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(o.updated_at), 0) FROM orders o JOIN stands s ON s.id = o.stand_id WHERE s.seller_id = ?1) AS a,
         (SELECT COALESCE(MAX(i.updated_at), 0) FROM items i JOIN stands s ON s.id = i.stand_id WHERE s.seller_id = ?1) AS b,
         (SELECT COALESCE(MAX(v.at), 0) FROM visits v JOIN stands s ON s.id = v.stand_id WHERE s.seller_id = ?1) AS c`,
    )
    .bind(sellerId)
    .first<{ a: number; b: number; c: number }>();
  return `${row?.a ?? 0}.${row?.b ?? 0}.${row?.c ?? 0}`;
}

async function toUnpack(db: D1Database, standId: number): Promise<Order[]> {
  const { results } = await db
    .prepare("SELECT * FROM orders WHERE stand_id = ? AND to_unpack = 1 ORDER BY closed_at")
    .bind(standId)
    .all<Order>();
  return results;
}

async function buildPanel(db: D1Database, stand: Stand, now: number, tz: string): Promise<StandPanel> {
  const [items, open, unpack, recent, visit] = await Promise.all([
    listItems(db, stand.id, { includeHidden: true }),
    listOrders(db, stand.id, OPEN),
    toUnpack(db, stand.id),
    db
      .prepare("SELECT * FROM orders WHERE stand_id = ? AND closed_at > ? ORDER BY closed_at DESC LIMIT 40")
      .bind(stand.id, now - 36 * 3_600_000)
      .all<Order>()
      .then((r) => r.results),
    lastVisit(db, stand.id),
  ]);
  const today = localDate(now, tz);
  const closedToday = recent.filter((o) => o.closed_at !== null && localDate(o.closed_at, tz) === today);
  const lastVisitAt = visit?.at ?? null;
  const reopenable = new Set(closedToday.filter((o) => canReopen(o, { now, tz, lastVisitAt })).map((o) => o.id));
  const lines = await linesFor(db, [...open, ...unpack].map((o) => o.id));
  return { stand, items, open, unpack, closedToday, reopenable, lines, lastVisitAt };
}

app.get("/admin/:token", async (c) => {
  const seller = c.get("seller");
  const { tz, roundStep } = settings(c.env);
  const now = Date.now();
  const stands = await standsForSeller(c.env.DB, seller.id);
  const panels = await Promise.all(stands.map((s) => buildPanel(c.env.DB, s, now, tz)));
  const flash = getCookie(c, "flash");
  if (flash) deleteCookie(c, "flash", { path: "/admin" });
  const version = await adminVersion(c.env.DB, seller.id);
  return c.html(adminPage({ seller, token: c.get("token"), panels, now, tz, roundStep, version, flash }));
});

// The version endpoint uses "_v" so it can never collide with a stand slug.
app.get("/admin/:token/_v", async (c) => c.json({ v: await adminVersion(c.env.DB, c.get("seller").id) }));

const STALE = "That order changed in the meantime, so nothing was done.";

app.post(`/admin/:token/:slug{${SLUG}}/orders/:id{[0-9]+}/:action{pack|pickup|release|reopen|unpack}`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const { roundStep, tz } = settings(c.env);
  const now = Date.now();
  let flash = "";
  switch (c.req.param("action")) {
    case "pack": {
      const body = await c.req.parseBody();
      const packed: Record<number, number> = {};
      for (const [k, v] of Object.entries(body)) {
        const m = /^item_(\d+)$/.exec(k);
        if (m && typeof v === "string") packed[Number(m[1])] = intOr(v, Number.NaN);
      }
      const r = await packOrder(db, stand.id, id, packed, { now, roundStep });
      if (r === "stale") flash = STALE;
      if (r === "released") flash = "Nothing could be packed, so the order was released.";
      break;
    }
    case "pickup":
      if (!(await pickUpOrder(db, stand.id, id, "seller", now))) flash = STALE;
      break;
    case "release":
      if (!(await releaseOrder(db, stand.id, id, now))) flash = STALE;
      break;
    case "reopen": {
      const r = await reopenOrder(db, stand.id, id, { now, tz });
      if (r === "no_stock") flash = "Can't reopen: someone else has reserved those items since.";
      if (r === "not_allowed") flash = "That order can't be reopened.";
      break;
    }
    case "unpack":
      await clearUnpack(db, stand.id, id, now);
      break;
  }
  return backToAdmin(c, stand, flash);
});

app.post(`/admin/:token/:slug{${SLUG}}/items`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const body = strings(await c.req.parseBody());
  const price = parseMoney(body.price ?? "");
  if (price === null) return backToAdmin(c, stand, "Enter a price like 5.00.");
  const r = await addItem(
    c.env.DB,
    stand.id,
    { name: body.name ?? "", unit: body.unit ?? "", priceCents: price, stock: intOr(body.stock, 0) },
    Date.now(),
  );
  return backToAdmin(c, stand, r.ok ? `Added ${(body.name ?? "").trim()}.` : r.message);
});

app.post(`/admin/:token/:slug{${SLUG}}/items/:id{[0-9]+}/:action{edit|stock|sold-out|hide}`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const body = strings(await c.req.parseBody());
  const now = Date.now();
  let flash = "";
  switch (c.req.param("action")) {
    case "edit": {
      const price = parseMoney(body.price ?? "");
      if (price === null) {
        flash = "Enter a price like 5.00.";
        break;
      }
      const r = await editItem(db, stand.id, id, { name: body.name ?? "", unit: body.unit ?? "", priceCents: price }, now);
      if (!r.ok) flash = r.message;
      break;
    }
    case "stock": {
      const r = await adjustStock(db, stand.id, id, intOr(body.seen, Number.NaN), intOr(body.stock, Number.NaN), now);
      if (!r.ok) flash = r.message;
      break;
    }
    case "sold-out":
      await setSoldOut(db, stand.id, id, body.on === "1", now);
      break;
    case "hide":
      await setHidden(db, stand.id, id, body.on === "1", now);
      break;
  }
  return backToAdmin(c, stand, flash);
});

app.post(`/admin/:token/:slug{${SLUG}}/settings`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const body = strings(await c.req.parseBody());
  await c.env.DB.prepare("UPDATE stands SET pickup_info = ?, message = ?, paused = ? WHERE id = ? AND seller_id = ?")
    .bind((body.pickup_info ?? "").trim().slice(0, 200), (body.message ?? "").trim().slice(0, 140), body.paused === "1" ? 1 : 0, stand.id, c.get("seller").id)
    .run();
  return backToAdmin(c, stand, "Settings saved.");
});

async function visitData(db: D1Database, stand: Stand) {
  const [items, open, unpack] = await Promise.all([listItems(db, stand.id), listOrders(db, stand.id, OPEN), toUnpack(db, stand.id)]);
  const lines = await linesFor(db, [...open, ...unpack].map((o) => o.id));
  return {
    items,
    unpack,
    ready: open.filter((o) => o.status === "ready"),
    placed: open.filter((o) => o.status === "placed"),
    lines,
  };
}

app.get(`/admin/:token/:slug{${SLUG}}/visit`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const data = await visitData(c.env.DB, stand);
  const { roundStep } = settings(c.env);
  return c.html(visitPage({ stand, token: c.get("token"), ...data, visitKey: randomToken(16), roundStep }));
});

/** Turn the visit form's fields into a VisitForm. */
export function readVisitForm(values: Record<string, string>): VisitForm | { error: string } {
  const unpack: number[] = [];
  const gone: number[] = [];
  const pack: Record<number, Record<number, number>> = {};
  const entries: Record<number, VisitEntry> = {};
  const entry = (id: number) => (entries[id] ??= { counted: null, removed: 0, restocked: 0 });
  for (const [k, v] of Object.entries(values)) {
    let m: RegExpExecArray | null;
    if ((m = /^unpack_(\d+)$/.exec(k))) unpack.push(Number(m[1]));
    else if ((m = /^basket_(\d+)$/.exec(k)) && v === "gone") gone.push(Number(m[1]));
    else if ((m = /^pack_(\d+)_(\d+)$/.exec(k))) (pack[Number(m[1])] ??= {})[Number(m[2])] = intOr(v, Number.NaN);
    else if ((m = /^count_(\d+)$/.exec(k))) entry(Number(m[1])).counted = v.trim() === "" ? null : Number(v);
    else if ((m = /^removed_(\d+)$/.exec(k))) entry(Number(m[1])).removed = intOr(v, 0);
    else if ((m = /^restocked_(\d+)$/.exec(k))) entry(Number(m[1])).restocked = intOr(v, 0);
  }
  let cashCounted: number | null = null;
  if ((values.cash ?? "").trim() !== "") {
    cashCounted = parseMoney(values.cash ?? "");
    if (cashCounted === null) return { error: "Enter the cash like 35.50, or leave it blank." };
  }
  return {
    visitKey: values.visit_key || randomToken(16),
    unpack,
    gone,
    pack,
    entries,
    cashCounted,
    confirmed: values.confirm === "1",
  };
}

app.post(`/admin/:token/:slug{${SLUG}}/visit`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const values = strings(await c.req.parseBody());
  const { roundStep } = settings(c.env);
  const form = readVisitForm(values);
  const again = async (errors: { itemId: number; message: string }[], needsConfirm: Parameters<typeof visitPage>[0]["needsConfirm"] = []) => {
    const data = await visitData(c.env.DB, stand);
    return c.html(
      visitPage({ stand, token: c.get("token"), ...data, visitKey: values.visit_key ?? randomToken(16), roundStep, values, errors, needsConfirm }),
      422,
    );
  };
  if ("error" in form) return again([{ itemId: 0, message: form.error }]);
  const r = await saveVisit(c.env.DB, stand, form, { now: Date.now(), roundStep });
  if (!r.ok) return again(r.errors, r.needsConfirm);
  return c.redirect(`/admin/${c.get("token")}/${stand.slug}/visits/${r.visitId}`, 303);
});

app.get(`/admin/:token/:slug{${SLUG}}/visits/:id{[0-9]+}`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const found = await getVisit(c.env.DB, stand.id, Number(c.req.param("id")));
  if (!found) return c.html(messagePage("Visit not found", "Go back to your orders."), 404);
  const { tz } = settings(c.env);
  const now = Date.now();
  const week = await weekSummary(c.env.DB, stand.id, now);
  return c.html(visitSummaryPage({ stand, token: c.get("token"), ...found, week, now, tz }));
});

app.get(`/admin/:token/:slug{${SLUG}}/sign`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const url = `${new URL(c.req.url).origin}/${stand.slug}`;
  return c.html(signPage(stand, url, `/admin/${c.get("token")}#stand-${stand.slug}`));
});

function csvResponse(c: C, filename: string, body: string) {
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

app.get(`/admin/:token/:slug{${SLUG}}/orders.csv`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const { tz } = settings(c.env);
  const { results } = await c.env.DB.prepare("SELECT * FROM orders WHERE stand_id = ? ORDER BY created_at DESC LIMIT 5000")
    .bind(stand.id)
    .all<Order>();
  const lines = await linesFor(c.env.DB, results.map((o) => o.id));
  const when = (ts: number | null) =>
    ts === null ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(ts);
  const rows = results.map((o) => [
    when(o.created_at),
    o.code,
    o.status,
    o.customer_name,
    o.contact,
    (lines.get(o.id) ?? []).map((l) => `${l.item_name} x${units(l)}`).join("; "),
    formatMoney(o.total_cents),
    formatMoney(o.cash_cents),
    when(o.closed_at),
    o.closed_by,
  ]);
  return csvResponse(
    c,
    `${stand.slug}-orders.csv`,
    csv([["Created", "Code", "Status", "Customer", "Phone", "Items", "Total", "Cash", "Closed", "Closed by"], ...rows]),
  );
});

app.get(`/admin/:token/:slug{${SLUG}}/visits.csv`, async (c) => {
  const stand = await sellerStand(c);
  if (!stand) return noSellerStand(c);
  const { tz } = settings(c.env);
  const { results } = await c.env.DB.prepare("SELECT * FROM visits WHERE stand_id = ? ORDER BY at DESC LIMIT 5000")
    .bind(stand.id)
    .all<{ at: number; walkin_cents: number; app_cash_cents: number; expected_cents: number; cash_counted_cents: number | null }>();
  const when = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(ts);
  const rows = results.map((v) => [
    when(v.at),
    formatMoney(v.walkin_cents),
    formatMoney(v.app_cash_cents),
    formatMoney(v.expected_cents),
    v.cash_counted_cents === null ? "" : formatMoney(v.cash_counted_cents),
    v.cash_counted_cents === null ? "" : formatMoney(v.cash_counted_cents - v.expected_cents),
  ]);
  return csvResponse(
    c,
    `${stand.slug}-visits.csv`,
    csv([["Visited", "Walk-in sales", "App cash", "Expected", "Counted", "Difference"], ...rows]),
  );
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scrub(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;
