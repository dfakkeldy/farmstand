export const SCRUB_AFTER_MS = 30 * 86_400_000;

/** Remove names, phone numbers and notes from closed orders older than 30 days. Totals stay. */
export async function scrub(db: D1Database, now: number): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE orders SET customer_name = 'Customer', contact = NULL, when_note = NULL, scrubbed_at = ?
       WHERE scrubbed_at IS NULL AND status NOT IN ('placed', 'ready') AND closed_at < ?`,
    )
    .bind(now, now - SCRUB_AFTER_MS)
    .run();
  return res.meta.changes;
}
