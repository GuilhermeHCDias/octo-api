import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file. Applying is idempotent: a migration already
// recorded in the database is skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
