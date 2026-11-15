import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			// Applies the migrations to the local D1 before each test file.
			setupFiles: ["./test/support/apply-migrations.ts"],
		},
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// The tests never read .dev.vars: a fresh clone and the CI have
					// none, and a developer's real keys must not reach a test.
					bindings: {
						STRIPE_SECRET_KEY: "sk_test_placeholder",
						STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
						GITHUB_CLIENT_ID: "github_client_id_placeholder",
						GITHUB_CLIENT_SECRET: "github_client_secret_placeholder",
						CHECKOUT_SUCCESS_URL: "https://octo.test/checkout/success",
						CHECKOUT_CANCEL_URL: "https://octo.test/checkout/cancel",
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
	};
});
