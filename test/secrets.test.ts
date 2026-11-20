import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import wranglerConfig from "../wrangler.jsonc?raw";

describe("the Wrangler configuration", () => {
	it("requires the six settings of the payment and the seven of the sign-in", () => {
		const required = wranglerConfig
			.match(/"required":\s*\[([^\]]*)\]/)?.[1]
			?.match(/[A-Z][A-Z0-9_]+/g);

		expect(required).toEqual([
			"STRIPE_SECRET_KEY",
			"STRIPE_WEBHOOK_SECRET",
			"GITHUB_CLIENT_ID",
			"GITHUB_CLIENT_SECRET",
			"CHECKOUT_SUCCESS_URL",
			"CHECKOUT_CANCEL_URL",
			"BETTER_AUTH_SECRET",
			"BETTER_AUTH_URL",
			"APP_SIGN_IN_URL",
			"APPLE_CLIENT_ID",
			"APPLE_TEAM_ID",
			"APPLE_KEY_ID",
			"APPLE_PRIVATE_KEY",
		]);
	});
});

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

describe("Better Auth's settings and the app's sign-in URL", () => {
	it("reach the Worker with the test values, with no .dev.vars file", () => {
		expect(env.BETTER_AUTH_SECRET).toBe(
			"better_auth_secret_placeholder_0123456789",
		);
		expect(env.BETTER_AUTH_URL).toBe("https://api.octo.test");
		expect(env.APP_SIGN_IN_URL).toBe("octo://sign-in");
	});
});

describe("the settings of the sign-in with Apple", () => {
	it("reach the Worker with the test values, with no .dev.vars file", () => {
		expect(env.APPLE_CLIENT_ID).toBe("apple_client_id_placeholder");
		expect(env.APPLE_TEAM_ID).toBe("APPLETEAM0");
		expect(env.APPLE_KEY_ID).toBe("APPLEKEY00");
	});

	it("include a private key made for the run, which no file of the repository holds", async () => {
		const pem = env.APPLE_PRIVATE_KEY;
		expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);

		const der = Uint8Array.from(
			atob(pem.replace(/-----[A-Z ]+-----|\s/g, "")),
			(character) => character.charCodeAt(0),
		);
		const key = await crypto.subtle.importKey(
			"pkcs8",
			der,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
		expect(key.type).toBe("private");
	});
});
