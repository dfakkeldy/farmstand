// Values that are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface FarmstandExtraEnv {
  /** Turnstile secret, set with `wrangler secret put TURNSTILE_SECRET`. Optional. */
  TURNSTILE_SECRET?: string;
  /** Test-only binding with the D1 migrations (see vitest.config.ts). */
  TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
}

// The global Env (used by the Worker) and Cloudflare.Env (used by `cloudflare:workers`).
interface Env extends FarmstandExtraEnv {}
declare namespace Cloudflare {
  interface Env extends FarmstandExtraEnv {}
}
