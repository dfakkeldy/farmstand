import { html } from "hono/html";
import { formatMoney } from "../money";
import { formatWhen } from "../time";
import type { Item, Order, OrderLine, Stand, Visit, VisitLineRow } from "../types";
import { units } from "../types";
import type { ConfirmNeed } from "../visit";
import { unpackReason } from "./admin";
import { type Html, layout } from "./layout";

export interface VisitPageView {
  stand: Stand;
  token: string;
  items: Item[];
  unpack: Order[];
  ready: Order[];
  placed: Order[];
  lines: Map<number, OrderLine[]>;
  visitKey: string;
  roundStep: number;
  /** Raw form values when the page comes back with errors or a confirm. */
  values?: Record<string, string>;
  errors?: { itemId: number; message: string }[];
  needsConfirm?: ConfirmNeed[];
}

function unitsJson(lines: OrderLine[]): string {
  return JSON.stringify(Object.fromEntries(lines.map((l) => [l.item_id, units(l)])));
}

export function visitPage(v: VisitPageView): Html {
  const b = `/admin/${v.token}/${v.stand.slug}`;
  const val = (k: string, d = "") => v.values?.[k] ?? d;
  const errFor = (id: number) => v.errors?.filter((e) => e.itemId === id) ?? [];
  const general = v.errors?.filter((e) => e.itemId === 0) ?? [];
  const lines = (o: Order) => v.lines.get(o.id) ?? [];

  const sectionA = v.unpack.length
    ? html`<fieldset><legend>A. Unpack first</legend>
  ${v.unpack.map((o) => {
    const name = `unpack_${o.id}`;
    const pick = val(name);
    return html`<div class="choice">
    <p>${unpackReason(o)}: ${lines(o).map((l) => `${l.item_name} ${units(l)}`).join(", ")}</p>
    <label><input type="radio" name="${name}" value="shelf" required${pick === "shelf" ? " checked" : ""}> Back on shelf</label>
    <label><input type="radio" name="${name}" value="gone"${pick === "gone" ? " checked" : ""}> Not here</label>
  </div>`;
  })}
</fieldset>`
    : "";

  const sectionB = v.ready.length
    ? html`<fieldset><legend>B. Baskets waiting for pickup</legend>
  ${v.ready.map((o) => {
    const name = `basket_${o.id}`;
    const gone = val(name) === "gone";
    return html`<div class="choice" data-basket data-units='${unitsJson(lines(o))}'>
    <p><strong>${o.code}</strong> · ${o.customer_name} · ${formatMoney(o.cash_cents)}</p>
    <label><input type="radio" name="${name}" value="here"${gone ? "" : " checked"}> Still here</label>
    <label><input type="radio" name="${name}" value="gone"${gone ? " checked" : ""}> Gone (picked up)</label>
  </div>`;
  })}
</fieldset>`
    : "";

  const sectionC = v.placed.length
    ? html`<fieldset><legend>C. Pack these orders</legend>
  ${v.placed.map((o) => html`<div class="pack-block" data-pack data-round="${v.roundStep}">
    <p><strong>${o.code}</strong> · ${o.customer_name}</p>
    ${lines(o).map((l) => {
      const id = `pack_${o.id}_${l.item_id}`;
      return html`<div class="pack-line">
      <label for="${id}">${l.item_name} <span class="muted">asked ${l.qty}</span></label>
      <div class="stepper">
        <button type="button" class="step" data-step="-1" data-for="${id}" aria-label="One less ${l.item_name}">−</button>
        <input id="${id}" name="${id}" type="number" inputmode="numeric" min="0" max="${l.qty}" value="${val(id, String(l.qty))}" data-price="${l.price_cents}" data-item="${l.item_id}" data-qty="${l.qty}" data-pack-input>
        <button type="button" class="step" data-step="1" data-for="${id}" aria-label="One more ${l.item_name}">+</button>
      </div>
    </div>`;
    })}
    <p class="label-text">Write on the basket: <strong>${o.code} · ${o.customer_name} · <span data-label-amount>${formatMoney(o.cash_cents)}</span></strong></p>
  </div>`)}
</fieldset>`
    : "";

  const sectionD = html`<fieldset><legend>D. Count the shelf</legend>
  <p class="muted small">Count loose items before you take anything away. Don't count what's in baskets. Leave a box blank to skip an item.</p>
  ${v.items.map((i) => {
    const errs = errFor(i.id);
    return html`<div class="count-row" data-count data-item="${i.id}" data-stock="${i.stock}" data-tally="${i.short_since_visit}" data-price="${i.price_cents}">
    <p class="count-name"><strong>${i.name}</strong>${i.unit_label ? ` (${i.unit_label})` : ""} <output class="count-result" aria-live="polite"></output></p>
    <div class="count-inputs">
      <label>On the shelf <input name="count_${i.id}" type="number" inputmode="numeric" min="0" placeholder="skip" value="${val(`count_${i.id}`)}"></label>
      <label>Taking away <input name="removed_${i.id}" type="number" inputmode="numeric" min="0" placeholder="0" value="${val(`removed_${i.id}`)}"></label>
      <label>Adding <input name="restocked_${i.id}" type="number" inputmode="numeric" min="0" placeholder="0" value="${val(`restocked_${i.id}`)}"></label>
    </div>
    ${errs.map((e) => html`<p class="error">${e.message}</p>`)}
  </div>`;
  })}
</fieldset>`;

  const sectionE = html`<fieldset><legend>E. Cash box (optional)</legend>
  <label for="cash">Count the box, empty it, and enter the amount</label>
  <input id="cash" name="cash" inputmode="decimal" placeholder="not counted" value="${val("cash")}">
</fieldset>`;

  const confirm = v.needsConfirm?.length
    ? html`<div class="notice" role="alert">
  ${v.needsConfirm.map((n) => html`<p>You counted ${n.counted} ${n.name.toLowerCase()}; we expected ${n.expected}. Is ${n.counted} right?</p>`)}
  <label class="check"><input type="checkbox" name="confirm" value="1" required> Yes, my counts are right</label>
</div>`
    : "";

  return layout({
    title: `Visit · ${v.stand.name}`,
    body: html`<main class="page narrow">
  <p class="eyebrow"><a href="/admin/${v.token}#stand-${v.stand.slug}">← Orders</a></p>
  <h1>Visit ${v.stand.name}</h1>
  ${general.map((e) => html`<p class="error" role="alert">${e.message}</p>`)}
  ${v.errors?.length && !general.length ? html`<p class="error" role="alert">Please check the rows marked below.</p>` : ""}
  <form method="post" action="${b}/visit" data-visit data-draft-key="farmstand-visit-${v.stand.slug}" data-restore="${v.values ? "0" : "1"}">
    <input type="hidden" name="visit_key" value="${val("visit_key", v.visitKey)}">
    ${confirm}
    ${sectionA}${sectionB}${sectionC}${sectionD}${sectionE}
    <button type="submit" class="primary">Save visit</button>
    <p id="visit-status" class="muted" role="status"></p>
  </form>
</main>`,
  });
}

export interface VisitSummaryView {
  stand: Stand;
  token: string;
  visit: Visit;
  lines: VisitLineRow[];
  week: { shelfCents: number; appCents: number; diffCents: number };
  now: number;
  tz: string;
}

function boxWords(diff: number): string {
  if (Math.abs(diff) <= 100) return "Box about right";
  return diff < 0 ? `${formatMoney(-diff)} short` : `${formatMoney(diff)} over`;
}

export function visitSummaryPage(v: VisitSummaryView): Html {
  const { visit, week } = v;
  const box =
    visit.cash_counted_cents === null
      ? html`<p>Box not counted. Expected so far: <strong>${formatMoney(visit.expected_cents)}</strong>.</p>`
      : html`<p class="box-result">${boxWords(visit.cash_counted_cents - visit.expected_cents)}</p>
<p class="small">Expected ${formatMoney(visit.expected_cents)} (shelf ${formatMoney(visit.expected_cents - visit.app_cash_cents)}, app ${formatMoney(visit.app_cash_cents)}) · counted ${formatMoney(visit.cash_counted_cents)}</p>`;
  const weekDiff = week.diffCents === 0 ? "box even" : week.diffCents < 0 ? `${formatMoney(-week.diffCents)} short` : `${formatMoney(week.diffCents)} over`;
  return layout({
    title: `Visit saved · ${v.stand.name}`,
    data: { "clear-draft": `farmstand-visit-${v.stand.slug}` },
    body: html`<main class="page narrow">
  <p class="eyebrow">${v.stand.name} · ${formatWhen(visit.at, v.now, v.tz)}</p>
  <h1>Saved</h1>
  ${box}
  <ul class="lines">${v.lines.map((l) => {
    const sold = l.counted === null ? "not counted" : `${l.walk_in_sold} sold to walk-ins (${formatMoney(l.walk_in_sold * l.price_cents)})`;
    const more = l.found_more ? `, found ${l.found_more} more than expected` : "";
    const added = l.restocked ? `, added ${l.restocked}` : "";
    return html`<li>${l.item_name}: ${sold}${more}${added}</li>`;
  })}</ul>
  <p class="week">This week: ${formatMoney(week.shelfCents)} shelf · ${formatMoney(week.appCents)} app · ${weekDiff}</p>
  <p><a class="button primary" href="/admin/${v.token}#stand-${v.stand.slug}">Back to orders</a></p>
</main>`,
  });
}
