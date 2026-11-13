import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("the Stripe secrets", () => {
	it("reach the Worker with the test values, with no .dev.vars file", () => {
		expect(env.STRIPE_SECRET_KEY).toBe("sk_test_placeholder");
		expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_placeholder");
	});
});
