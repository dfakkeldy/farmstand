/** Round a cash amount to the nearest `step` cents (Canada: 5; 1–2 down, 3–4 up). */
export function roundCash(cents: number, step: number): number {
  if (step <= 1) return cents;
  return Math.round(cents / step) * step;
}

/** 1400 -> "$14.00", -200 -> "-$2.00". */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Parse what a person types for a cash amount ("35", "$35.50", "1,234.5") into cents. */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replaceAll(",", "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const dollars = Number(m[1]);
  const cents = Number((m[2] ?? "").padEnd(2, "0"));
  return dollars * 100 + cents;
}
