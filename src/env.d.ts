// Values that are not in wrangler.jsonc, so `wrangler types` cannot see them.
declare namespace Cloudflare {
  interface Env {
    /** Turnstile secret, set with `wrangler secret put TURNSTILE_SECRET`. Optional. */
    TURNSTILE_SECRET?: string;
    /** Test-only binding with the D1 migrations (see vitest.config.ts). */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
