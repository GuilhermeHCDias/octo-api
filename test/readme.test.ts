import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import wranglerConfig from "../wrangler.jsonc?raw";

// The names under `secrets.required`, read from the configuration's text.
const requiredSettings =
	wranglerConfig
		.match(/"required":\s*\[([^\]]*)\]/)?.[1]
		?.match(/[A-Z][A-Z0-9_]+/g) ?? [];

/** The text of the section a heading opens, up to the next of its level. */
function section(heading: string): string {
	const start = readme.indexOf(`\n${heading}\n`);
	if (start === -1) return "";
	const level = heading.match(/^#+/)?.[0].length ?? 1;
	const rest = readme.slice(start + heading.length + 2);
	const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
	return end === -1 ? rest : rest.slice(0, end);
}

describe("the README", () => {
	it("lists every secret and setting the Worker requires, in the table and in the .dev.vars example", () => {
		expect(requiredSettings).toHaveLength(13);
		const example = section("### Secrets and settings").match(
			/```sh\n([\s\S]*?)```/,
		)?.[1];
		for (const name of requiredSettings) {
			expect(readme).toContain(`| \`${name}\``);
			expect(example).toMatch(new RegExp(`^${name}=`, "m"));
		}
		expect(readme).not.toMatch(/\bsix (names|values|secrets)\b/);
	});

	it("asks for a random BETTER_AUTH_SECRET of at least 32 bytes, with the command that makes one", () => {
		const row =
			readme
				.split("\n")
				.find((line) => line.startsWith("| `BETTER_AUTH_SECRET`")) ?? "";

		expect(row).toMatch(/random/i);
		expect(row).toMatch(/at least 32 bytes/);
		expect(readme).toContain("openssl rand -base64 32");
	});

	it("describes the account as Octo's own, reached with GitHub or with Apple", () => {
		const introduction = readme.slice(0, readme.indexOf("## Routes"));

		expect(introduction).toMatch(/account of its own|Octo's own/i);
		expect(introduction).toContain("Better Auth");
		expect(introduction).toContain("GitHub");
		expect(introduction).toContain("Apple");
		expect(readme).not.toMatch(/an\s+account is the user's GitHub identity/);
	});

	it("describes the sign-in from the browser to the token, with the challenge and the verifier", () => {
		const signIn = section("## Signing in");

		for (const part of [
			"GET /sign-in/github",
			"GET /sign-in/apple",
			"challenge",
			"verifier",
			"SHA-256",
			"base64url",
			"/api/auth/callback/",
			"APP_SIGN_IN_URL",
			"`code`",
			"`error`",
			"POST /sign-in/token",
			'{"token":',
			"3 minutes",
			'{"error":"Invalid code"}',
			'{"error":"Invalid challenge"}',
			"Authorization: Bearer",
		]) {
			expect(signIn).toContain(part);
		}
	});

	it("describes the sign-out and what ends a session", () => {
		const signIn = section("## Signing in");

		expect(signIn).toContain("POST /api/auth/sign-out");
		expect(signIn).toMatch(/7 days/);
	});

	it("describes the new /account and no longer the one that created accounts", () => {
		const row =
			readme.split("\n").find((line) => line.startsWith("| `GET /account`")) ??
			"";

		for (const field of [
			"user_id",
			"email",
			"name",
			"access",
			"subscription",
		]) {
			expect(row).toContain(`\`${field}\``);
		}
		expect(readme).not.toContain("| `PUT /account`");
		expect(readme).not.toContain("github_user_id");
		expect(readme).not.toContain("github_login");
	});

	it("describes the setup of GitHub's OAuth App with its callback URL", () => {
		const github = section("### GitHub");

		expect(github).toContain("OAuth App");
		expect(github).toContain("/api/auth/callback/github");
		expect(github).toContain("user:email");
	});

	it("describes the setup at Apple: the App ID, the Services ID, the return URL and the key", () => {
		const apple = section("### Apple");

		for (const part of [
			"App ID",
			"Services ID",
			"/api/auth/callback/apple",
			"APPLE_CLIENT_ID",
			"APPLE_TEAM_ID",
			"APPLE_KEY_ID",
			"APPLE_PRIVATE_KEY",
			".p8",
		]) {
			expect(apple).toContain(part);
		}
		expect(apple).toMatch(/HTTPS/);
	});

	it("recommends, and does not require, a Cloudflare rate limiting rule by client address on the two sign-in paths", () => {
		const cloudflare = section("### Cloudflare");

		expect(cloudflare).toMatch(/rate limiting rule/i);
		expect(cloudflare).toMatch(/recommended/i);
		expect(cloudflare).toMatch(/not required|nothing .* depends on it/i);
		expect(cloudflare).toContain("`/sign-in/`");
		expect(cloudflare).toContain("`/api/auth/`");
		expect(cloudflare).toMatch(/client('s)? (IP )?address/i);
		expect(cloudflare).toMatch(/domain/);
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
		const stripeSetup = section("### Stripe");

		expect(stripeSetup).toMatch(/one subscription/i);
		expect(stripeSetup).toMatch(/second layer/i);
		expect(stripeSetup).toMatch(/login link/i);
		expect(stripeSetup).toContain(
			"https://docs.stripe.com/payments/checkout/limit-subscriptions",
		);
	});

	it("describes the two prices by their lookup keys and the payment methods", () => {
		expect(readme).toContain("pro_monthly");
		expect(readme).toContain("pro_year");
		expect(readme).toMatch(/payment methods/i);
	});
});
