const APPLE = "https://appleid.apple.com";

// How long a client secret lives. Each request that needs one signs its own,
// so it only has to outlast that request.
const SECONDS_TO_LIVE = 300;

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

/**
 * The client secret Apple asks of a Services ID: a JWT naming the team, the
 * key and the Services ID, signed (ES256) with the team's private key. Apple
 * refuses one that expires more than six months ahead, so none is stored: the
 * API signs a short-lived one whenever it talks to Apple, and nothing expires.
 *
 * APPLE_PRIVATE_KEY is the content of the `.p8` file Apple gives, a PKCS #8
 * key in PEM. Its line breaks may arrive as real ones or as a literal `\n`.
 */
export async function appleClientSecret(
	env: CloudflareBindings,
): Promise<string> {
	const der = Uint8Array.from(
		atob(env.APPLE_PRIVATE_KEY.replace(/-----[A-Z ]+-----|\\n|\s/g, "")),
		(character) => character.charCodeAt(0),
	);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${base64Url(
		JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID }),
	)}.${base64Url(
		JSON.stringify({
			iss: env.APPLE_TEAM_ID,
			iat: now,
			exp: now + SECONDS_TO_LIVE,
			aud: APPLE,
			sub: env.APPLE_CLIENT_ID,
		}),
	)}`;
	// Web Crypto signs ECDSA as the two numbers side by side, which is the
	// form a JWT carries.
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(unsigned),
	);
	return `${unsigned}.${base64Url(signature)}`;
}
