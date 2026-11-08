// Plain numbers, money and phone numbers ("-$2.00", "+1 902 555 0100") can't call a function.
const PLAIN = /^[+-]?\$?[\d .,()-]+$/;

/** One CSV cell. Cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function cell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !PLAIN.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
