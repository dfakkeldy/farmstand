/** "2026-11-07" in the given time zone; used to tell whether two moments fall on the same day. */
export function localDate(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ts);
}

/** "9:10 a.m." */
export function formatTime(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ts);
}

/** "9:10 a.m. today", "4:05 p.m. yesterday" or "4:05 p.m. Tue, Nov 3". */
export function formatWhen(ts: number, now: number, tz: string): string {
  const time = formatTime(ts, tz);
  const day = localDate(ts, tz);
  if (day === localDate(now, tz)) return `${time} today`;
  if (day === localDate(now - 86_400_000, tz)) return `${time} yesterday`;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(ts);
  return `${time} ${date}`;
}
