import { isAPIError } from "better-auth/api";
import { Hono } from "hono";
import { appleClientSecret } from "../apple";
import {
	boundCode,
	challengeOf,
	createAuth,
	isChallenge,
	PROVIDERS,
	type Provider,
} from "../auth";

/**
 * Where Better Auth is told to send the browser after a sign-in. No route
 * answers it: the callback (routes/auth.ts) ends the sign-in itself, and
 * reads from this address the challenge the sign-in began with.
 */
export const SIGNED_IN_PATH = "/sign-in/done";

const signIn = new Hono<{ Bindings: CloudflareBindings }>();

// The app opens the system browser here. The challenge is the base64url
// SHA-256 of a random verifier the app keeps: only who holds the verifier can
// trade the code this sign-in ends with (PKCE, RFC 7636).
signIn.get("/:provider", async (c) => {
	const provider = c.req.param("provider") as Provider;
	if (!PROVIDERS.includes(provider)) return c.notFound();

	const challenge = c.req.query("challenge");
	if (!isChallenge(challenge)) {
		return c.json({ error: "Invalid challenge" }, 400);
	}

	const auth = createAuth(
		c.env,
		provider === "apple" ? await appleClientSecret(c.env) : undefined,
	);
	const { headers, response } = await auth.api.signInSocial({
		body: {
			provider,
			callbackURL: `${SIGNED_IN_PATH}?challenge=${challenge}`,
			disableRedirect: true,
		},
		headers: c.req.raw.headers,
		returnHeaders: true,
	});
	if (!response.url) {
		throw new Error(`Better Auth gave no authorization page for ${provider}`);
	}

	// The cookie that ties the sign-in to this browser goes with the redirect.
	for (const cookie of headers.getSetCookie()) {
		c.header("Set-Cookie", cookie, { append: true });
	}
	return c.redirect(response.url, 302);
});

// The app trades the code its sign-in ended with for the session's token.
// The code is found only together with the challenge of the verifier, so a
// wrong verifier is a code never issued.
signIn.post("/token", async (c) => {
	const body: unknown = await c.req.json().catch(() => null);
	const { code, verifier } =
		typeof body === "object" && body !== null
			? (body as { code?: unknown; verifier?: unknown })
			: {};
	if (typeof code !== "string" || typeof verifier !== "string") {
		return c.json({ error: "Invalid code" }, 401);
	}

	try {
		const { headers } = await createAuth(c.env).api.verifyOneTimeToken({
			body: { token: boundCode(code, await challengeOf(verifier)) },
			returnHeaders: true,
		});
		// The session's token with its signature, as the bearer plugin gives
		// it: the only form `Authorization: Bearer` is accepted in.
		const token = headers.get("set-auth-token");
		if (!token) throw new Error("Better Auth gave a session with no token");
		return c.json({ token });
	} catch (error) {
		// Better Auth refuses a code used, expired or unknown.
		if (isAPIError(error)) return c.json({ error: "Invalid code" }, 401);
		throw error;
	}
});

export default signIn;
