import { betterAuth } from "better-auth";
import { bearer, oneTimeToken } from "better-auth/plugins";

/** The providers a person can sign in with. */
export const PROVIDERS = ["github", "apple"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * The header that carries a sign-in's challenge to the making of its code.
 * Only the API's own call to Better Auth sets it: no client reaches the
 * endpoint that reads it.
 */
export const CHALLENGE_HEADER = "x-octo-sign-in-challenge";

/** A challenge: the base64url, unpadded, of a SHA-256. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isChallenge(value: unknown): value is string {
	return typeof value === "string" && CHALLENGE.test(value);
}

/** The challenge of a verifier, as PKCE's S256 makes it (RFC 7636). */
export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * What Better Auth stores, hashed, for a sign-in's single-use code: the code
 * and the sign-in's challenge together. A code is therefore found only by
 * who also holds the verifier of that challenge.
 */
export function boundCode(code: string, challenge: string): string {
	return `${code}.${challenge}`;
}

/**
 * What the API writes where Better Auth would keep a provider's tokens.
 * After a sign-in Octo asks the provider nothing, so a token in D1 would only
 * be something to leak.
 */
const NO_PROVIDER_TOKENS = {
	accessToken: null,
	refreshToken: null,
	idToken: null,
	accessTokenExpiresAt: null,
	refreshTokenExpiresAt: null,
};

function randomCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Better Auth for one request: the Octo account, its provider links and its
 * sessions live in D1, in Better Auth's own tables.
 *
 * `appleClientSecret` is needed only by the requests that talk to Apple (see
 * `appleClientSecret` in apple.ts); without it Apple is not a provider.
 */
export function createAuth(
	env: CloudflareBindings,
	appleClientSecret?: string,
) {
	return betterAuth({
		database: env.DB,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		// Apple answers its page with a form posted from its own origin.
		trustedOrigins: ["https://appleid.apple.com"],
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
			},
			...(appleClientSecret && {
				apple: {
					clientId: env.APPLE_CLIENT_ID,
					clientSecret: appleClientSecret,
				},
			}),
		},
		databaseHooks: {
			// Every write of a provider account: the first sign-in, the account
			// added to an existing user, and each later sign-in.
			account: {
				create: {
					before: async (account) => ({
						data: { ...account, ...NO_PROVIDER_TOKENS },
					}),
				},
				update: {
					before: async (account) => ({
						data: { ...account, ...NO_PROVIDER_TOKENS },
					}),
				},
			},
		},
		advanced: {
			// Behind Cloudflare the client's address is in this header alone.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
		// Closed to clients, and still called by the API itself. A sign-in
		// starts at GET /sign-in/<provider> and its code is traded at
		// POST /sign-in/token, which checks the verifier: Better Auth's own
		// endpoints for the three steps would skip the challenge.
		disabledPaths: [
			"/sign-in/social",
			"/one-time-token/generate",
			"/one-time-token/verify",
		],
		plugins: [
			// Reads `Authorization: Bearer` as the session, and only with the
			// signature: the bare token, as D1 holds it, is refused.
			bearer({ requireSignature: true }),
			oneTimeToken({
				// The default: the code of a sign-in lives 3 minutes.
				expiresIn: 3,
				storeToken: "hashed",
				disableClientRequest: true,
				generateToken: async (_session, ctx) => {
					const challenge = ctx.headers?.get(CHALLENGE_HEADER);
					if (!isChallenge(challenge)) {
						throw new Error("A sign-in code was asked for with no challenge");
					}
					return boundCode(randomCode(), challenge);
				},
			}),
		],
	});
}
