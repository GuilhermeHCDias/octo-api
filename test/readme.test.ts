import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import wranglerConfig from "../wrangler.jsonc?raw";

// The names under `secrets.required`, read from the configuration's text.
const requiredSettings =
	wranglerConfig
		.match(/"required":\s*\[([^\]]*)\]/)?.[1]
		?.match(/[A-Z][A-Z0-9_]+/g) ?? [];

describe("the README", () => {
	it("lists every secret and setting the Worker requires", () => {
		expect(requiredSettings).toHaveLength(6);
		for (const name of requiredSettings) {
			expect(readme).toContain(name);
		}
	});

	it("says how to set them for local development without a file the repository lacks", () => {
		expect(readme).toContain(".dev.vars");
		expect(readme).not.toContain(".dev.vars.example");
	});

	it("describes the Stripe webhook destination with its six events", () => {
		expect(readme).toContain("/webhooks/stripe");
		for (const event of [
			"checkout.session.completed",
			"customer.subscription.created",
			"customer.subscription.updated",
			"customer.subscription.deleted",
			"invoice.paid",
			"invoice.payment_failed",
		]) {
			expect(readme).toContain(event);
		}
	});

	it("says that opening a Checkout expires the previous one, and that 409 covers a payment not yet delivered", () => {
		const row =
			readme
				.split("\n")
				.find((line) => line.startsWith("| `POST /checkout`")) ?? "";

		expect(row).toMatch(/expires the account's previous one/i);
		expect(row).toMatch(/409 .* a payment the webhook has not delivered yet/);
	});

	it("adds the Dashboard's one-subscription limit to the Stripe setup, with the portal's login link it needs", () => {
		const stripeSetup = readme.slice(
			readme.indexOf("### Stripe"),
			readme.indexOf("### GitHub"),
		);

		expect(stripeSetup).toMatch(/one subscription/i);
		expect(stripeSetup).toMatch(/second layer/i);
		expect(stripeSetup).toMatch(/login link/i);
		expect(stripeSetup).toContain(
			"https://docs.stripe.com/payments/checkout/limit-subscriptions",
		);
	});

	it("describes the two prices by their lookup keys, the payment methods and the OAuth App's scope", () => {
		expect(readme).toContain("pro_monthly");
		expect(readme).toContain("pro_year");
		expect(readme).toMatch(/payment methods/i);
		expect(readme).toContain("OAuth App");
		expect(readme).toContain("user:email");
	});
});
