import { html } from "hono/html";
import { formatMoney, roundCash } from "../money";
import { formatWhen } from "../time";
import type { Item, Stand } from "../types";
import { footer, type Html, layout } from "./layout";

export interface StandView {
  stand: Stand;
  items: Item[];
  now: number;
  tz: string;
  roundStep: number;
  idemKey: string;
  error?: string;
  values?: { name?: string; contact?: string; whenNote?: string; qty?: Record<number, number> };
  turnstileSiteKey?: string;
}

function itemRow(item: Item, maxPerItem: number, qty: number): Html {
  const free = item.stock - item.held;
  const unit = item.unit_label ? html` <span class="muted">/ ${item.unit_label}</span>` : "";
  if (item.sold_out || free <= 0) {
    return html`<li class="item soldout">
  <div class="item-main"><span class="item-name">${item.name}</span>${unit}<span class="price">${formatMoney(item.price_cents)}</span></div>
  <div class="item-side"><span class="tag">Sold out</span></div>
</li>`;
  }
  const max = Math.min(free, maxPerItem);
  const id = `q_${item.id}`;
  return html`<li class="item">
  <div class="item-main">
    <label for="${id}" class="item-name">${item.name}</label>${unit}
    <span class="price">${formatMoney(item.price_cents)}</span>
    <span class="muted small">about ${free} left</span>
  </div>
  <div class="stepper">
    <button type="button" class="step" data-step="-1" data-for="${id}" aria-label="One less ${item.name}">−</button>
    <input id="${id}" name="${id}" type="number" inputmode="numeric" min="0" max="${max}" value="${qty}" data-price="${item.price_cents}">
    <button type="button" class="step" data-step="1" data-for="${id}" aria-label="One more ${item.name}">+</button>
  </div>
</li>`;
}

export function standPage(v: StandView): Html {
  const { stand } = v;
  const counted = stand.last_counted_at
    ? `Counted ${formatWhen(stand.last_counted_at, v.now, v.tz)}. Walk-ins may buy some before your order is packed.`
    : "Walk-ins may buy some before your order is packed.";
  const qty = v.values?.qty ?? {};
  const turnstile = Boolean(v.turnstileSiteKey);
  const startTotal = roundCash(
    v.items.reduce((sum, i) => sum + (qty[i.id] ?? 0) * i.price_cents, 0),
    v.roundStep,
  );

  let content: Html;
  if (stand.paused) {
    content = html`<div class="notice"><p><strong>Online orders are paused.</strong></p>${stand.message ? html`<p>${stand.message}</p>` : ""}</div>`;
  } else if (v.items.length === 0) {
    content = html`<p class="notice">Nothing listed yet. Check back soon.</p>`;
  } else {
    content = html`
<form method="post" action="/${stand.slug}/order" data-order-form data-round="${v.roundStep}" novalidate>
  <input type="hidden" name="idem_key" value="${v.idemKey}">
  ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ""}
  <p class="muted small">${counted}</p>
  <ul class="items">${v.items.map((i) => itemRow(i, stand.max_per_item, qty[i.id] ?? 0))}</ul>
  <p class="total" aria-live="polite">Bring about <strong id="total-amount">${formatMoney(startTotal)}</strong> cash</p>
  <div class="field">
    <label for="name">Your name</label>
    <input id="name" name="name" autocomplete="given-name" maxlength="60" required value="${v.values?.name ?? ""}">
  </div>
  <div class="field">
    <label for="contact">Phone (optional), only if the farmer needs to reach you</label>
    <input id="contact" name="contact" type="tel" autocomplete="tel" maxlength="40" value="${v.values?.contact ?? ""}">
  </div>
  <div class="field">
    <label for="when_note">When you plan to come (optional)</label>
    <input id="when_note" name="when_note" maxlength="120" value="${v.values?.whenNote ?? ""}">
  </div>
  ${turnstile ? html`<div class="cf-turnstile" data-sitekey="${v.turnstileSiteKey}"></div>` : ""}
  <button type="submit" class="primary">Reserve, pay cash at pickup</button>
</form>`;
  }

  return layout({
    title: stand.name,
    turnstile,
    body: html`<main class="page">
  <header class="head">
    <h1>${stand.name}</h1>
    ${stand.message && !stand.paused ? html`<p class="message">${stand.message}</p>` : ""}
    ${stand.pickup_info ? html`<p class="pickup">${stand.pickup_info}</p>` : ""}
    ${stand.mode === "unattended" ? html`<p class="muted small">At the stand now? Just take what you need and pay in the box.</p>` : ""}
  </header>
  <div id="my-orders" class="my-orders" data-stand="${stand.slug}" hidden></div>
  ${content}
</main>${footer()}`,
  });
}
