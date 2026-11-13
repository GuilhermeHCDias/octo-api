import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// The tests never read .dev.vars: a fresh clone and the CI have
				// none, and a developer's real keys must not reach a test.
				bindings: {
					STRIPE_SECRET_KEY: "sk_test_placeholder",
					STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
				},
			},
		}),
	],
});
