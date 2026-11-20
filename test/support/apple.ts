import { env } from "cloudflare:workers";
import type { FakeService, RecordedRequest } from "./network";

const APPLE = "https://appleid.apple.com";
const SIX_MONTHS = 15_777_000;
const KEY_ID = "APPLE_ID_TOKEN_KEY";

/** A person at Apple, as the ID token of a sign-in describes them. */
export type ApplePerson = {
	// Apple's id of the person for Octo's team.
	sub: string;
	email: string;
	name?: { firstName: string; lastName: string };
};

function base64Url(data: ArrayBuffer | string): string {
	const bytes =
		typeof data === "string"
			? new TextEncoder().encode(data)
			: new Uint8Array(data);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(
		atob(text.replace(/-/g, "+").replace(/_/g, "/")),
		(character) => character.charCodeAt(0),
	);
}

// The key Apple signs its ID tokens with, made for the tests: one per test
// file, since making an RSA key is slow.
const idTokenKey = crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
) as Promise<CryptoKeyPair>;

/** The public half of the key in APPLE_PRIVATE_KEY, as Apple holds it. */
async function teamPublicKey(): Promise<CryptoKey> {
	const der = fromBase64Url(
		env.APPLE_PRIVATE_KEY.replace(/-----[A-Z ]+-----|\s/g, "")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, ""),
	);
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		der,
		algorithm,
		true,
		["sign"],
	);
	const { kty, crv, x, y } = (await crypto.subtle.exportKey(
		"jwk",
		privateKey,
	)) as JsonWebKey;
	return crypto.subtle.importKey("jwk", { kty, crv, x, y }, algorithm, false, [
		"verify",
	]);
}

/**
 * Whether `secret` is a client secret Apple accepts from Octo: a JWT signed
 * (ES256) with the team's key, naming the key, the team and the Services ID,
 * not expired and expiring at most six months ahead.
 */
async function isOctosClientSecret(secret: string): Promise<boolean> {
	const [header, payload, signature] = secret.split(".");
	if (!header || !payload || !signature) return false;
	try {
		const { alg, kid } = JSON.parse(
			new TextDecoder().decode(fromBase64Url(header)),
		);
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
		const now = Date.now() / 1000;
		return (
			alg === "ES256" &&
			kid === env.APPLE_KEY_ID &&
			claims.iss === env.APPLE_TEAM_ID &&
			claims.sub === env.APPLE_CLIENT_ID &&
			claims.aud === APPLE &&
			typeof claims.iat === "number" &&
			claims.iat <= now + 5 &&
			typeof claims.exp === "number" &&
			claims.exp > now &&
			claims.exp <= now + SIX_MONTHS &&
			(await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				await teamPublicKey(),
				fromBase64Url(signature),
				new TextEncoder().encode(`${header}.${payload}`),
			))
		);
	} catch {
		return false;
	}
}

type Authorization = { person: ApplePerson; redirectUri: string };

/**
 * Apple as a sign-in provider: the authorization page a browser visits, which
 * answers with a form posted to the return URL, the exchange of its code for
 * an ID token, and the keys that verify that token.
 */
export function fakeApple() {
	const authorizations = new Map<string, Authorization>();
	const requests: RecordedRequest[] = [];
	let count = 0;

	async function idTokenOf(person: ApplePerson): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		const signed = `${base64Url(
			JSON.stringify({ alg: "RS256", kid: KEY_ID }),
		)}.${base64Url(
			JSON.stringify({
				iss: APPLE,
				aud: env.APPLE_CLIENT_ID,
				iat: now,
				exp: now + 600,
				sub: person.sub,
				email: person.email,
				// As Apple: a string. Apple only reports addresses it verified.
				email_verified: "true",
			}),
		)}`;
		const signature = await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			(await idTokenKey).privateKey,
			new TextEncoder().encode(signed),
		);
		return `${signed}.${base64Url(signature)}`;
	}

	async function exchangeCode(request: RecordedRequest): Promise<Response> {
		const form = new URLSearchParams(request.body);
		if (
			form.get("client_id") !== env.APPLE_CLIENT_ID ||
			!(await isOctosClientSecret(form.get("client_secret") ?? ""))
		) {
			return Response.json({ error: "invalid_client" }, { status: 400 });
		}
		const code = form.get("code") ?? "";
		const authorization = authorizations.get(code);
		// As Apple: a code is spent by its first exchange.
		authorizations.delete(code);
		if (
			!authorization ||
			form.get("grant_type") !== "authorization_code" ||
			form.get("redirect_uri") !== authorization.redirectUri
		) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		count += 1;
		return Response.json({
			access_token: `apple_access_token_${count}`,
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: `apple_refresh_token_${count}`,
			id_token: await idTokenOf(authorization.person),
		});
	}

	return {
		hosts: ["appleid.apple.com"],
		requests,

		/**
		 * What Apple does when `person` approves the authorization page at
		 * `authorizationUrl`: the form it makes the browser post to the return
		 * URL. The `user` field comes only with a person's first authorization.
		 */
		async authorize(
			authorizationUrl: string | URL,
			person: ApplePerson,
			{ first = true }: { first?: boolean } = {},
		): Promise<{ url: string; form: URLSearchParams }> {
			const page = new URL(authorizationUrl);
			if (
				page.origin + page.pathname !== `${APPLE}/auth/authorize` ||
				page.searchParams.get("client_id") !== env.APPLE_CLIENT_ID ||
				page.searchParams.get("response_mode") !== "form_post"
			) {
				throw new Error(
					`Not the authorization page of Octo's Services ID: ${page}`,
				);
			}
			count += 1;
			const code = `apple_code_${count}`;
			const redirectUri = page.searchParams.get("redirect_uri") ?? "";
			authorizations.set(code, { person, redirectUri });
			const form = new URLSearchParams({
				code,
				state: page.searchParams.get("state") ?? "",
				id_token: await idTokenOf(person),
			});
			if (first && person.name) {
				form.set(
					"user",
					JSON.stringify({ name: person.name, email: person.email }),
				);
			}
			return { url: redirectUri, form };
		},

		/** The form Apple posts for a person who cancels the page. */
		refuse(authorizationUrl: string | URL): {
			url: string;
			form: URLSearchParams;
		} {
			const page = new URL(authorizationUrl);
			return {
				url: page.searchParams.get("redirect_uri") ?? "",
				form: new URLSearchParams({
					error: "user_cancelled_authorize",
					state: page.searchParams.get("state") ?? "",
				}),
			};
		},

		async handle(request: RecordedRequest): Promise<Response> {
			requests.push(request);
			const route = `${request.method} ${request.url.pathname}`;
			if (route === "POST /auth/token") return exchangeCode(request);
			if (route === "GET /auth/keys") {
				const jwk = (await crypto.subtle.exportKey(
					"jwk",
					(
						await idTokenKey
					).publicKey,
				)) as JsonWebKey;
				return Response.json({
					keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }],
				});
			}
			return Response.json({ error: "not_found" }, { status: 404 });
		},
	} satisfies FakeService & Record<string, unknown>;
}
