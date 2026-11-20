import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	// The key that signs Apple's client secret is made for each run: the
	// tests' fake of Apple checks the signature with its public half, and no
	// file of the repository holds a private key. It is in PEM, as the `.p8`
	// file Apple gives.
	const { privateKey } = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = (await crypto.subtle.exportKey(
		"pkcs8",
		privateKey,
	)) as ArrayBuffer;
	const applePrivateKey = [
		"-----BEGIN PRIVATE KEY-----",
		...(btoa(String.fromCharCode(...new Uint8Array(pkcs8))).match(/.{1,64}/g) ??
			[]),
		"-----END PRIVATE KEY-----",
		"",
	].join("\n");

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
						BETTER_AUTH_SECRET: "better_auth_secret_placeholder_0123456789",
						BETTER_AUTH_URL: "https://api.octo.test",
						APP_SIGN_IN_URL: "octo://sign-in",
						APPLE_CLIENT_ID: "apple_client_id_placeholder",
						APPLE_TEAM_ID: "APPLETEAM0",
						APPLE_KEY_ID: "APPLEKEY00",
						APPLE_PRIVATE_KEY: applePrivateKey,
						TEST_MIGRATIONS: migrations,
					},
				},
			}),
		],
	};
});
