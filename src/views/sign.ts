import { html, raw } from "hono/html";
import { renderSVG } from "uqr";
import type { Stand } from "../types";
import { type Html, layout } from "./layout";

/** The printable sign. Public data only: it is served at /<stand>/sign, never under /admin. */
export function signPage(stand: Stand, url: string): Html {
  const qr = renderSVG(url, { border: 1 });
  const shown = url.replace(/^https?:\/\//, "");
  return layout({
    title: `Sign · ${stand.name}`,
    body: html`<p class="no-print page">Print this page (one sheet) and post it at the stand.</p>
<main class="sign">
  <h1>${stand.name}</h1>
  <p class="sign-lead">Order ahead, pay cash at pickup</p>
  <div class="qr" role="img" aria-label="QR code for ${shown}">${raw(qr)}</div>
  <p class="sign-url">${shown}</p>
  <p class="sign-note">Labelled baskets are reserved for online orders</p>
</main>`,
  });
}
