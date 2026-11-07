import { html } from "hono/html";
import { formatMoney } from "../money";
import { formatTime } from "../time";
import type { Order, OrderLine, Stand } from "../types";
import { footer, freshness, type Html, layout } from "./layout";

export interface OrderView {
  order: Order;
  lines: OrderLine[];
  stand: Stand;
  now: number;
  tz: string;
  url: string;
}

export const FINAL = new Set(["picked_up", "released", "cancelled", "not_found"]);

export function statusLabel(order: Order): string {
  return order.status === "ready" ? "Ready" : order.status === "placed" ? "Reserved" : "Closed";
}

function lineText(l: OrderLine): Html {
  const unit = l.unit_label ? ` ${l.unit_label}` : "";
  if (l.packed_qty !== null && l.packed_qty < l.qty) {
    return html`<li>${l.item_name}: <strong>${l.packed_qty} of ${l.qty}</strong>${unit}</li>`;
  }
  return html`<li>${l.item_name}: ${l.qty}${unit}</li>`;
}

/** "Only 2 of 3 dozen eggs were left." for each short line. */
function shortNotes(lines: OrderLine[]): string {
  return lines
    .filter((l) => l.packed_qty !== null && l.packed_qty < l.qty)
    .map((l) => {
      const unit = l.unit_label ? ` ${l.unit_label}` : "";
      return `Only ${l.packed_qty} of ${l.qty}${unit} ${l.item_name.toLowerCase()} ${l.packed_qty === 1 ? "was" : "were"} left.`;
    })
    .join(" ");
}

function backToStand(stand: Stand): Html {
  return html`<p><a class="button" href="/${stand.slug}">See what's at ${stand.name} →</a></p>`;
}

function statusBlock(v: OrderView): Html {
  const { order, stand, lines } = v;
  const pickup = stand.pickup_info ? html`<p class="pickup">${stand.pickup_info}</p>` : "";
  switch (order.status) {
    case "placed":
      return html`<h1>Reserved. Don't come yet; come when this page says Ready.</h1>
${pickup}
<p>If walk-ins buy some first, your total changes here.</p>
<p class="total">Bring about <strong>${formatMoney(order.cash_cents)}</strong>.</p>`;
    case "ready": {
      const notes = shortNotes(lines);
      const was = order.cash_cents !== order.orig_cash_cents ? ` (was ${formatMoney(order.orig_cash_cents)})` : "";
      return html`<h1>Ready. Basket ${order.code} · ${order.customer_name}.</h1>
${pickup}
${notes ? html`<p class="notice">${notes}</p>` : ""}
<p class="total">Bring <strong>${formatMoney(order.cash_cents)}</strong> cash${was}.</p>`;
    }
    case "picked_up":
      return html`<h1>Picked up. Thanks, ${order.customer_name}!</h1>${backToStand(stand)}`;
    case "released":
      return order.prev_status === "ready"
        ? html`<h1>This basket wasn't picked up and went back on the shelf. Nothing to pay.</h1>${backToStand(stand)}`
        : html`<h1>The farmer couldn't fill this order. Nothing to pay.</h1>${backToStand(stand)}`;
    case "cancelled":
      return html`<h1>You cancelled this order. Nothing to pay.</h1>${backToStand(stand)}`;
    case "not_found":
      return html`<h1>Sorry about that. We've told the farmer. Nothing to pay.</h1>${backToStand(stand)}`;
  }
}

function actions(v: OrderView): Html {
  const { order, stand } = v;
  const base = `/o/${order.public_token}`;
  const open = order.status === "placed" || order.status === "ready";
  if (!open) return html``;
  const pickedUp =
    order.status === "ready" && stand.mode === "unattended"
      ? html`<form method="post" action="${base}/picked-up"><button class="primary" type="submit">I picked it up and left ${formatMoney(order.cash_cents)}</button></form>`
      : "";
  const notThere =
    order.status === "ready"
      ? html`<details class="confirm"><summary>Basket not there?</summary>
  <form method="post" action="${base}/not-found"><p>We'll tell the farmer. You won't owe anything.</p><button type="submit">Yes, the basket isn't there</button></form>
</details>`
      : "";
  return html`${pickedUp}
<div class="share">
  <button type="button" class="secondary" data-share="${v.url}">Save this link</button>
  <input id="share-url" class="share-url" readonly value="${v.url}" aria-label="Link to this order" hidden>
</div>
${notThere}
<details class="confirm"><summary>Cancel order</summary>
  <form method="post" action="${base}/cancel"><p>The items go back on sale.</p><button type="submit" class="danger">Yes, cancel my order</button></form>
</details>`;
}

export function orderPage(v: OrderView): Html {
  const { order, lines, stand } = v;
  const final = FINAL.has(order.status);
  return layout({
    title: `Order ${order.code} · ${stand.name}`,
    poll: final ? undefined : `/o/${order.public_token}/v`,
    version: String(order.updated_at),
    data: {
      "order-token": order.public_token,
      "order-code": order.code,
      "order-stand": stand.slug,
      "order-final": final ? "1" : "0",
    },
    body: html`<main class="page narrow">
  <p class="eyebrow">${stand.name} · order ${order.code}</p>
  <div class="status" aria-live="polite">${statusBlock(v)}</div>
  <ul class="lines">${lines.map(lineText)}</ul>
  ${actions(v)}
  ${final ? "" : freshness(formatTime(v.now, v.tz))}
</main>${footer()}`,
  });
}
