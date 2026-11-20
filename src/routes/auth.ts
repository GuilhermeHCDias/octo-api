import { Hono } from "hono";
import { appleClientSecret } from "../apple";
import { CHALLENGE_HEADER, createAuth, isChallenge } from "../auth";
import { SIGNED_IN_PATH } from "./sign-in";

const auth = new Hono<{ Bindings: CloudflareBindings }>();

/** APP_SIGN_IN_URL with one parameter: the only place a sign-in ends. */
function appSignInUrl(env: CloudflareBindings, name: string, value: string) {
	const url = new URL(env.APP_SIGN_IN_URL);
	url.searchParams.set(name, value);
	return url.href;
}

// The provider sends the browser back here. Better Auth does the sign-in;
// its answer, which carries the session's cookie, never leaves the Worker:
// the browser gets only a redirect to the app, with a single-use code that
// the app trades at POST /sign-in/token, or with the error.
auth.get("/callback/:provider", async (c) => {
	const betterAuth = createAuth(
		c.env,
		c.req.param("provider") === "apple"
			? await appleClientSecret(c.env)
			: undefined,
	);
	const answer = await betterAuth.handler(c.req.raw);

	// Of Better Auth's cookies the browser gets only the ones that end: the
	// one that tied the sign-in to it.
	for (const cookie of answer.headers.getSetCookie()) {
		if (/;\s*Max-Age=0/i.test(cookie)) {
			c.header("Set-Cookie", cookie, { append: true });
		}
	}

	const location = new URL(
		answer.headers.get("Location") ?? "",
		c.env.BETTER_AUTH_URL,
	);
	const sessionToken = answer.headers.get("set-auth-token");
	const challenge = location.searchParams.get("challenge");
	if (
		location.pathname !== SIGNED_IN_PATH ||
		!sessionToken ||
		!isChallenge(challenge)
	) {
		// Better Auth names the failure with a code, its own or the provider's.
		// Anything else that arrives in its place is not passed on to the app.
		const reported = location.searchParams.get("error") ?? "";
		return c.redirect(
			appSignInUrl(
				c.env,
				"error",
				/^\w+$/.test(reported) ? reported : "sign_in_failed",
			),
			302,
		);
	}

	const { token } = await betterAuth.api.generateOneTimeToken({
		headers: new Headers({
			Authorization: `Bearer ${sessionToken}`,
			[CHALLENGE_HEADER]: challenge,
		}),
	});
	// What is stored is the code with the challenge; the app gets the code.
	return c.redirect(
		appSignInUrl(c.env, "code", token.slice(0, token.indexOf("."))),
		302,
	);
});

// Everything else under /api/auth is Better Auth's: the form Apple posts to
// the callback, the sign-out and the session.
auth.on(["GET", "POST"], "/*", async (c) => {
	const answer = await createAuth(c.env).handler(c.req.raw);
	return answer.status === 404 ? c.notFound() : answer;
});

export default auth;
