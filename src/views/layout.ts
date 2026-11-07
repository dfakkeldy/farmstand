import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export const REPO_URL = "https://github.com/dfakkeldy/farmstand";
const ASSET_VERSION = "1";

export interface LayoutOpts {
  title: string;
  body: Html;
  /** JSON endpoint polled every 30 s while the page is visible. */
  poll?: string;
  version?: string;
  /** Extra data-* attributes on <body> (keys without the data- prefix). */
  data?: Record<string, string>;
  turnstile?: boolean;
}

export function layout(o: LayoutOpts): Html {
  const data = Object.entries(o.data ?? {}).map(([k, v]) => html` data-${k}="${v}"`);
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${o.title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}">
${o.turnstile ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
</head>
<body${o.poll ? html` data-poll="${o.poll}" data-version="${o.version ?? ""}"` : ""}${data}>
${o.body}
<script src="/app.js?v=${ASSET_VERSION}" defer></script>
</body>
</html>`;
}

/** "Updated 10:42" plus the line shown when a refresh fails. */
export function freshness(time: string): Html {
  return html`<p class="stamp" id="stamp">Updated ${time}</p>
<p class="offline" id="offline" hidden role="status">No signal. Showing what we knew at ${time}.</p>`;
}

export function footer(): Html {
  return html`<footer class="foot"><a href="${REPO_URL}">Farmstand</a> · reserve online, pay cash at pickup</footer>`;
}

export function messagePage(title: string, text: string, extra: Html | string = ""): Html {
  return layout({
    title,
    body: html`<main class="page narrow"><h1>${title}</h1><p>${text}</p>${extra}</main>${footer()}`,
  });
}
