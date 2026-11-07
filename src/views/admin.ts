import { html } from "hono/html";
import { formatMoney } from "../money";
import { formatTime, formatWhen } from "../time";
import type { Item, Order, OrderLine, Seller, Stand } from "../types";
import { units } from "../types";
import { freshness, type Html, layout } from "./layout";

export interface StandPanel {
  stand: Stand;
  items: Item[];
  open: Order[];
  unpack: Order[];
  closedToday: Order[];
  reopenable: Set<number>;
  lines: Map<number, OrderLine[]>;
  lastVisitAt: number | null;
}

export interface AdminView {
  seller: Seller;
  token: string;
  panels: StandPanel[];
  now: number;
  tz: string;
  roundStep: number;
  version: string;
  flash?: string;
}

const DAY = 86_400_000;

function base(v: AdminView, stand: Stand): string {
  return `/admin/${v.token}/${stand.slug}`;
}

function orderHead(o: Order, v: AdminView): Html {
  const old = v.now - o.created_at > DAY;
  const phone = o.contact ? html` · <a href="tel:${o.contact.replace(/[^\d+]/g, "")}">${o.contact}</a>` : "";
  return html`<div class="order-head">
  ${old ? html`<span class="tag warn">Not closed</span>` : ""}
  <strong class="code">${o.code}</strong> · ${o.customer_name}${phone}
  <span class="muted small">${formatWhen(o.created_at, v.now, v.tz)}</span>
</div>
${o.when_note ? html`<p class="small">“${o.when_note}”</p>` : ""}`;
}

function packCard(o: Order, lines: OrderLine[], v: AdminView, stand: Stand): Html {
  const b = base(v, stand);
  return html`<li class="card">
  ${orderHead(o, v)}
  <form method="post" action="${b}/orders/${o.id}/pack" data-pack data-round="${v.roundStep}">
    <ul class="pack-lines">${lines.map((l) => {
      const id = `p_${o.id}_${l.item_id}`;
      return html`<li class="pack-line">
      <label for="${id}">${l.item_name}${l.unit_label ? ` (${l.unit_label})` : ""} <span class="muted">asked ${l.qty}</span></label>
      <div class="stepper">
        <button type="button" class="step" data-step="-1" data-for="${id}" aria-label="One less">−</button>
        <input id="${id}" name="item_${l.item_id}" type="number" inputmode="numeric" min="0" max="${l.qty}" value="${l.qty}" data-price="${l.price_cents}">
        <button type="button" class="step" data-step="1" data-for="${id}" aria-label="One more">+</button>
      </div>
    </li>`;
    })}</ul>
    <p class="label-text">Write on the basket: <strong>${o.code} · ${o.customer_name} · <span data-label-amount>${formatMoney(o.cash_cents)}</span></strong></p>
    <button type="submit" class="primary">Packed, mark Ready</button>
  </form>
  ${stand.mode === "staffed" ? html`<form method="post" action="${b}/orders/${o.id}/pickup"><button type="submit" class="secondary">Handed over now (picked up)</button></form>` : ""}
  <details class="confirm"><summary>Release</summary>
    <form method="post" action="${b}/orders/${o.id}/release"><p>The items go back on sale and the customer sees "The farmer couldn't fill this order."</p><button type="submit" class="danger">Release order ${o.code}</button></form>
  </details>
</li>`;
}

function readyCard(o: Order, lines: OrderLine[], v: AdminView, stand: Stand): Html {
  const b = base(v, stand);
  return html`<li class="card">
  ${orderHead(o, v)}
  <p class="small">${lines.map((l) => `${l.item_name} ${units(l)}`).join(" · ")} · <strong>${formatMoney(o.cash_cents)}</strong></p>
  <form method="post" action="${b}/orders/${o.id}/pickup"><button type="submit" class="primary">Picked up</button></form>
  <details class="confirm"><summary>Release</summary>
    <form method="post" action="${b}/orders/${o.id}/release"><p>The basket goes on your unpack list and the items go back on sale.</p><button type="submit" class="danger">Release order ${o.code}</button></form>
  </details>
</li>`;
}

export function unpackReason(o: Order): string {
  if (o.status === "not_found") return `Look for ${o.code} (customer couldn't find it)`;
  if (o.status === "cancelled") return `${o.code} (cancelled)`;
  return `${o.code} (released)`;
}

function unpackCard(o: Order, v: AdminView, stand: Stand): Html {
  const b = base(v, stand);
  return html`<li class="card">
  <p><strong>${unpackReason(o)}</strong> · ${o.customer_name}</p>
  <div class="row">
    <form method="post" action="${b}/orders/${o.id}/unpack"><button type="submit" class="secondary">Back on shelf</button></form>
    <form method="post" action="${b}/orders/${o.id}/unpack"><button type="submit" class="secondary">Not here</button></form>
  </div>
</li>`;
}

const CLOSED_WORDS: Record<string, string> = {
  picked_up: "Picked up",
  released: "Released",
  cancelled: "Cancelled by customer",
  not_found: "Basket not found",
};

function closedRow(o: Order, v: AdminView, stand: Stand, canReopen: boolean): Html {
  return html`<li class="closed-row">
  <span><strong>${o.code}</strong> · ${o.customer_name} · ${CLOSED_WORDS[o.status] ?? o.status} ${o.closed_at ? formatTime(o.closed_at, v.tz) : ""}</span>
  ${canReopen ? html`<form method="post" action="${base(v, stand)}/orders/${o.id}/reopen"><button type="submit" class="link">Reopen</button></form>` : ""}
</li>`;
}

function itemCard(i: Item, v: AdminView, stand: Stand): Html {
  const b = `${base(v, stand)}/items/${i.id}`;
  const free = i.stock - i.held;
  return html`<li class="card item-card${i.active ? "" : " hidden-item"}">
  <div class="item-head">
    <strong>${i.name}</strong>${i.unit_label ? html` <span class="muted">/ ${i.unit_label}</span>` : ""} · ${formatMoney(i.price_cents)}
    ${i.sold_out ? html`<span class="tag">Sold out</span>` : ""}${i.active ? "" : html`<span class="tag">Hidden</span>`}
  </div>
  <p class="small">about ${free} free · ${i.held} held · ${i.stock} stock</p>
  <div class="row">
    <form method="post" action="${b}/sold-out"><input type="hidden" name="on" value="${i.sold_out ? "0" : "1"}"><button type="submit" class="secondary">${i.sold_out ? "Back in stock" : "Sold out"}</button></form>
    <form method="post" action="${b}/hide"><input type="hidden" name="on" value="${i.active ? "1" : "0"}"><button type="submit" class="secondary">${i.active ? "Hide" : "Show"}</button></form>
  </div>
  <details><summary>Fix a mistake in stock</summary>
    <form method="post" action="${b}/stock" class="inline-form">
      <input type="hidden" name="seen" value="${i.stock}">
      <label for="s_${i.id}">Stock</label>
      <input id="s_${i.id}" name="stock" type="number" inputmode="numeric" min="0" value="${i.stock}">
      <button type="submit" class="secondary">Save</button>
    </form>
    <p class="muted small">To record what's on the shelf, do a visit.</p>
  </details>
  <details><summary>Edit name or price</summary>
    <form method="post" action="${b}/edit" class="stack-form">
      <label for="n_${i.id}">Name</label><input id="n_${i.id}" name="name" maxlength="40" value="${i.name}" required>
      <label for="u_${i.id}">Unit (dozen, bag, bunch)</label><input id="u_${i.id}" name="unit" maxlength="20" value="${i.unit_label}">
      <label for="pr_${i.id}">Price</label><input id="pr_${i.id}" name="price" inputmode="decimal" value="${(i.price_cents / 100).toFixed(2)}" required>
      <button type="submit" class="secondary">Save</button>
    </form>
  </details>
</li>`;
}

function addItemForm(v: AdminView, stand: Stand, open: boolean): Html {
  return html`<details class="add-item"${open ? " open" : ""}><summary>Add item</summary>
  <form method="post" action="${base(v, stand)}/items" class="stack-form">
    <label for="an_${stand.id}">Name</label><input id="an_${stand.id}" name="name" maxlength="40" required placeholder="Eggs">
    <label for="au_${stand.id}">Unit (dozen, bag, bunch)</label><input id="au_${stand.id}" name="unit" maxlength="20" placeholder="dozen">
    <label for="ap_${stand.id}">Price</label><input id="ap_${stand.id}" name="price" inputmode="decimal" required placeholder="5.00">
    <label for="as_${stand.id}">How many are on the stand now</label><input id="as_${stand.id}" name="stock" type="number" inputmode="numeric" min="0" value="0">
    <button type="submit" class="primary">Add item</button>
  </form>
</details>`;
}

function settingsForm(v: AdminView, stand: Stand): Html {
  return html`<details><summary>Stand settings</summary>
  <form method="post" action="${base(v, stand)}/settings" class="stack-form">
    <label for="pi_${stand.id}">Pickup info: where baskets go and when you usually visit</label>
    <textarea id="pi_${stand.id}" name="pickup_info" maxlength="200" rows="2" placeholder="Baskets go on the left shelf. Usually packed by 5 pm.">${stand.pickup_info}</textarea>
    <label for="m_${stand.id}">Message to customers (shown on your stand page)</label>
    <input id="m_${stand.id}" name="message" maxlength="140" value="${stand.message}" placeholder="Strawberries Saturday">
    <label class="check"><input type="checkbox" name="paused" value="1"${stand.paused ? " checked" : ""}> Pause online orders</label>
    <button type="submit" class="secondary">Save settings</button>
  </form>
</details>`;
}

function nextLine(p: StandPanel, v: AdminView): Html {
  const toPack = p.open.filter((o) => o.status === "placed").length;
  const ready = p.open.filter((o) => o.status === "ready").length;
  const old = p.open.filter((o) => v.now - o.created_at > DAY).length;
  const parts: Html[] = [];
  const slug = p.stand.slug;
  if (toPack) parts.push(html`<a href="#pack-${slug}">${toPack} to pack</a>`);
  if (ready) parts.push(html`<a href="#ready-${slug}">${ready} ready</a>`);
  if (p.unpack.length) parts.push(html`<a href="#unpack-${slug}">${p.unpack.length} to unpack</a>`);
  if (old) parts.push(html`<span class="warn-text">${old} not closed</span>`);
  parts.push(html`<span>${p.lastVisitAt ? `last visit ${formatWhen(p.lastVisitAt, v.now, v.tz)}` : "no visit yet"}</span>`);
  const joined = parts.map((x, i) => (i ? html` · ${x}` : x));
  return html`<p class="next-line">${joined} <a class="button primary small-btn" href="${base(v, p.stand)}/visit">Start visit</a></p>`;
}

function checklist(p: StandPanel, v: AdminView): Html {
  return html`<ol class="checklist">
  <li>Add your first item (below).</li>
  <li>Say where baskets go and when you visit (Stand settings, pickup info).</li>
  <li><a href="${base(v, p.stand)}/sign">Print your sign</a>.</li>
  <li>Add this page to your home screen, so it's one tap away.</li>
</ol>`;
}

function panel(p: StandPanel, v: AdminView): Html {
  const { stand } = p;
  const notClosedFirst = (a: Order, b: Order) => a.created_at - b.created_at;
  const toPack = p.open.filter((o) => o.status === "placed").sort(notClosedFirst);
  const ready = p.open.filter((o) => o.status === "ready").sort(notClosedFirst);
  const visible = p.items.filter((i) => i.active);
  const firstRun = visible.length === 0;
  const lines = (o: Order) => p.lines.get(o.id) ?? [];
  return html`<section class="stand-panel" id="stand-${stand.slug}">
  <h2>${stand.name} <a class="small" href="/${stand.slug}">public page</a></h2>
  ${stand.paused ? html`<p class="notice">Online orders are paused.</p>` : ""}
  ${nextLine(p, v)}
  ${firstRun ? checklist(p, v) : ""}
  ${toPack.length ? html`<h3 id="pack-${stand.slug}">To pack</h3><ul class="cards">${toPack.map((o) => packCard(o, lines(o), v, stand))}</ul>` : ""}
  ${ready.length ? html`<h3 id="ready-${stand.slug}">Ready</h3><ul class="cards">${ready.map((o) => readyCard(o, lines(o), v, stand))}</ul>` : ""}
  ${p.unpack.length ? html`<h3 id="unpack-${stand.slug}">To unpack</h3><ul class="cards">${p.unpack.map((o) => unpackCard(o, v, stand))}</ul>` : ""}
  ${p.closedToday.length ? html`<h3>Closed today</h3><ul class="closed">${p.closedToday.map((o) => closedRow(o, v, stand, p.reopenable.has(o.id)))}</ul>` : ""}
  <h3>Items</h3>
  ${p.items.length ? html`<ul class="cards">${p.items.map((i) => itemCard(i, v, stand))}</ul>` : ""}
  ${addItemForm(v, stand, firstRun)}
  ${settingsForm(v, stand)}
  <p class="links"><a href="${base(v, stand)}/sign">Sign</a> · <a href="${base(v, stand)}/orders.csv">Orders (CSV)</a> · <a href="${base(v, stand)}/visits.csv">Visits (CSV)</a></p>
</section>`;
}

export function adminPage(v: AdminView): Html {
  return layout({
    title: `${v.seller.name} · Farmstand`,
    poll: `/admin/${v.token}/v`,
    version: v.version,
    body: html`<main class="page">
  <header class="head">
    <h1>${v.seller.name}</h1>
    <p class="key-warning">This link is your key. Don't share it.</p>
    ${freshness(formatTime(v.now, v.tz))}
  </header>
  ${v.flash ? html`<p class="flash" role="status">${v.flash}</p>` : ""}
  ${v.panels.length ? v.panels.map((p) => panel(p, v)) : html`<p class="notice">No stands yet. Ask the person who set this up to add one.</p>`}
</main>`,
  });
}
