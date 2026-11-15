// Bindings only the tests have, set in vitest.config.ts.
declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
