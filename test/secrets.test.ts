import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("the Stripe secrets", () => {
	it("reach the Worker with the test values, with no .dev.vars file", () => {
		expect(env.STRIPE_SECRET_KEY).toBe("sk_test_placeholder");
		expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_placeholder");
	});
});

describe("the GitHub OAuth App's credentials and the Checkout URLs", () => {
	it("reach the Worker with the test values, with no .dev.vars file", () => {
		expect(env.GITHUB_CLIENT_ID).toBe("github_client_id_placeholder");
		expect(env.GITHUB_CLIENT_SECRET).toBe("github_client_secret_placeholder");
		expect(env.CHECKOUT_SUCCESS_URL).toBe("https://octo.test/checkout/success");
		expect(env.CHECKOUT_CANCEL_URL).toBe("https://octo.test/checkout/cancel");
	});
});
