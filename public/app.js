// Farmstand progressive enhancement. Every page works without this file.
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
  const round = (c, step) => (step <= 1 ? c : Math.round(c / step) * step);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  // − / + steppers next to number inputs.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (!b) return;
    const input = document.getElementById(b.dataset.for);
    if (!input) return;
    const min = input.min === "" ? 0 : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    const v = (parseInt(input.value, 10) || 0) + Number(b.dataset.step);
    input.value = String(Math.max(min, Math.min(max, v)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Live "Bring about $X" total on the stand page; one submit only.
  const orderForm = $("form[data-order-form]");
  if (orderForm) {
    const step = Number(orderForm.dataset.round) || 5;
    const total = $("#total-amount");
    const update = () => {
      let t = 0;
      $$("input[data-price]", orderForm).forEach((i) => { t += (parseInt(i.value, 10) || 0) * Number(i.dataset.price); });
      if (total) total.textContent = money(round(t, step));
    };
    orderForm.addEventListener("input", update);
    update();
    const button = $("button[type=submit]", orderForm);
    const label = button ? button.textContent : "";
    orderForm.addEventListener("submit", () => {
      if (button) { button.disabled = true; button.textContent = "Reserving…"; }
    });
    // Back after ordering can restore this page from the browser's cache: make it usable again,
    // with a fresh key so a second order isn't mistaken for the first.
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      if (button) { button.disabled = false; button.textContent = label; }
      const key = $('input[name="idem_key"]', orderForm);
      if (key) key.value = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    });
  }

  // Basket label amount follows the packing steppers.
  $$("[data-pack]").forEach((block) => {
    const step = Number(block.dataset.round) || 5;
    const out = $("[data-label-amount]", block);
    block.addEventListener("input", () => {
      let t = 0;
      $$("input[data-price]", block).forEach((i) => { t += (parseInt(i.value, 10) || 0) * Number(i.dataset.price); });
      if (out) out.textContent = money(round(t, step));
    });
  });

  // Refresh when something changed, only while visible and nothing is being edited.
  const poll = document.body.dataset.poll;
  if (poll) {
    const version = document.body.dataset.version;
    const offline = $("#offline");
    let dirty = false;
    document.addEventListener("input", () => { dirty = true; });
    let timer = 0;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(poll, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (offline) offline.hidden = true;
        if (j.v !== version && !dirty) location.reload();
        if (j.final) clearInterval(timer);
      } catch {
        if (offline) offline.hidden = false;
      }
    };
    timer = setInterval(check, 30000);
    document.addEventListener("visibilitychange", check);
  }

  // "Save this link": share sheet where available, otherwise copy.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-share]");
    if (!b) return;
    const url = b.dataset.share;
    try {
      if (navigator.share) { await navigator.share({ title: document.title, url }); return; }
      await navigator.clipboard.writeText(url);
      b.textContent = "Link copied";
    } catch {
      const field = $("#share-url");
      if (field) { field.hidden = false; field.select(); }
    }
  });

  // Remember this phone's open orders, so the stand page can show "Your order WREN-27 is Ready".
  const d = document.body.dataset;
  if (d.orderToken && d.orderStand) {
    const key = `farmstand:orders:${d.orderStand}`;
    const list = (store.get(key) || []).filter((x) => x.token !== d.orderToken);
    if (d.orderFinal !== "1") list.push({ token: d.orderToken, code: d.orderCode });
    store.set(key, list.slice(-5));
  }
  const mine = $("#my-orders");
  if (mine) {
    const key = `farmstand:orders:${mine.dataset.stand}`;
    (store.get(key) || []).forEach(async (x) => {
      try {
        const r = await fetch(`/o/${encodeURIComponent(x.token)}/v`, { cache: "no-store" });
        if (r.status === 404 || !r.ok) return;
        const j = await r.json();
        if (j.final) {
          store.set(key, (store.get(key) || []).filter((y) => y.token !== x.token));
          return;
        }
        const a = document.createElement("a");
        a.href = `/o/${encodeURIComponent(x.token)}`;
        a.className = "banner-link";
        a.textContent = `Your order ${x.code} is ${j.label} →`;
        mine.append(a);
        mine.hidden = false;
      } catch { /* offline: no banner */ }
    });
  }

  // The visit: live result per row, a draft kept on the phone, and a send that survives no signal.
  const clear = document.body.dataset.clearDraft;
  if (clear) store.del(clear);

  const vf = $("form[data-visit]");
  if (vf) {
    const key = vf.dataset.draftKey;
    const status = $("#visit-status");
    const DRAFT_MAX_AGE = 2 * 3600 * 1000;

    const calc = () => {
      const stock = {}, tally = {}, baskets = {};
      $$("[data-count]", vf).forEach((r) => {
        const id = r.dataset.item;
        stock[id] = Number(r.dataset.stock);
        tally[id] = Number(r.dataset.tally);
        baskets[id] = 0;
      });
      $$("[data-basket]", vf).forEach((b) => {
        const gone = $('input[value="gone"]', b)?.checked;
        for (const [id, n] of Object.entries(JSON.parse(b.dataset.units || "{}"))) {
          if (!(id in stock)) continue;
          if (gone) stock[id] -= n; else baskets[id] += n;
        }
      });
      $$("[data-pack-input]", vf).forEach((i) => {
        const id = i.dataset.item;
        if (!(id in stock)) return;
        const q = Number(i.dataset.qty);
        let p = parseInt(i.value, 10);
        if (Number.isNaN(p)) p = q;
        p = Math.max(0, Math.min(q, p));
        stock[id] -= q - p;
        tally[id] += q - p;
        baskets[id] += p;
      });
      $$("[data-count]", vf).forEach((r) => {
        const id = r.dataset.item;
        const out = $(".count-result", r);
        const raw = $(`input[name="count_${id}"]`, r).value.trim();
        const counted = parseInt(raw, 10);
        if (raw === "" || Number.isNaN(counted)) { out.textContent = ""; return; }
        // Same rule as the server: walk-in sold = max(0, gone + tally).
        const gone = stock[id] - (counted + baskets[id]);
        const sold = Math.max(0, gone + tally[id]);
        out.textContent = gone >= 0 ? `→ ${sold} sold` : `→ found ${-gone} more${sold ? `, ${sold} sold` : ""}`;
      });
    };

    const save = () => {
      const data = {};
      for (const el of vf.elements) {
        if (!el.name) continue;
        if (el.type === "radio" || el.type === "checkbox") { if (el.checked) data[el.name] = el.value; }
        else data[el.name] = el.value;
      }
      store.set(key, { at: Date.now(), data });
    };

    const restore = () => {
      const draft = store.get(key);
      let saved = [];
      try { saved = JSON.parse(vf.dataset.savedKeys || "[]"); } catch { /* none */ }
      // Drop a draft that is old, or that was saved but whose "Saved" page never arrived.
      if (!draft || Date.now() - draft.at > DRAFT_MAX_AGE || saved.includes(draft.data.visit_key)) {
        store.del(key);
        return;
      }
      for (const el of vf.elements) {
        if (!el.name || !(el.name in draft.data)) continue;
        if (el.type === "radio" || el.type === "checkbox") el.checked = draft.data[el.name] === el.value;
        else el.value = draft.data[el.name];
      }
      if (status) status.textContent = "Restored the counts you started on this phone.";
    };

    if (vf.dataset.restore === "1") restore();
    calc();
    vf.addEventListener("input", () => { calc(); save(); });
    vf.addEventListener("change", () => { calc(); save(); });

    vf.addEventListener("submit", async (e) => {
      e.preventDefault();
      save();
      const btn = $("button[type=submit]", vf);
      btn.disabled = true;
      btn.textContent = "Saving…";
      if (status) status.textContent = "";
      try {
        const res = await fetch(vf.action, { method: "POST", body: new FormData(vf) });
        if (res.redirected) { location.href = res.url; return; }
        // Something needs fixing: send the form the plain way so the page shows what.
        HTMLFormElement.prototype.submit.call(vf);
      } catch {
        btn.disabled = false;
        btn.textContent = "Not sent yet, tap to retry";
        if (status) status.textContent = "No signal. Your counts are kept on this phone.";
      }
    });
  }
})();
