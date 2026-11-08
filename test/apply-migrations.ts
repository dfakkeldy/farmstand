import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Storage is isolated per test file, so each file starts from a freshly migrated database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
