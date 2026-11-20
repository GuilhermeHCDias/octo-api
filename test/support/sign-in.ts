import { env, exports } from "cloudflare:workers";
import type { ApplePerson, fakeApple } from "./apple";
import { type Browser, openBrowser } from "./browser";
import type { fakeGitHub, GitHubPerson } from "./github";

/** The API's own address, as BETTER_AUTH_URL names it. */
export const API = "https://api.octo.test";

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** The challenge of a verifier: the base64url of its SHA-256. */
export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return base64Url(new Uint8Array(digest));
}

/** A random verifier, as the app makes one for each sign-in. */
export function newVerifier(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Opens the page that starts a sign-in, as the app makes the browser do. */
export function startSignIn(
	browser: Browser,
	provider: string,
	challenge: string,
): Promise<Response> {
	return browser.get(`${API}/sign-in/${provider}?challenge=${challenge}`);
}

/**
 * A whole sign-in with GitHub in `browser`, up to the address the API sends
 * the browser to at the end: APP_SIGN_IN_URL with a code or with an error.
 */
export async function gitHubSignIn(
	github: ReturnType<typeof fakeGitHub>,
	person: GitHubPerson,
	challenge: string,
	browser: Browser = openBrowser(),
): Promise<URL> {
	const start = await startSignIn(browser, "github", challenge);
	const callback = github.authorize(
		start.headers.get("Location") ?? "",
		person,
	);
	const end = await browser.get(callback);
	return new URL(end.headers.get("Location") ?? "");
}

/** The same with Apple, whose page answers with a form the browser posts. */
export async function appleSignIn(
	apple: ReturnType<typeof fakeApple>,
	person: ApplePerson,
	challenge: string,
	{
		browser = openBrowser(),
		first = true,
	}: { browser?: Browser; first?: boolean } = {},
): Promise<URL> {
	const start = await startSignIn(browser, "apple", challenge);
	const { url, form } = await apple.authorize(
		start.headers.get("Location") ?? "",
		person,
		{ first },
	);
	const posted = await browser.post(url, form, "https://appleid.apple.com");
	const end = await browser.get(posted.headers.get("Location") ?? "");
	return new URL(end.headers.get("Location") ?? "");
}

/** `POST /sign-in/token`, as the app sends it. */
export function tradeCode(body: unknown): Promise<Response> {
	return exports.default.fetch(`${API}/sign-in/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Signs `person` in with GitHub, from the browser to the token, and answers
 * the session token the app would keep with the id of the Octo user.
 */
export async function signIn(
	github: ReturnType<typeof fakeGitHub>,
	person: GitHubPerson,
): Promise<{ token: string; userId: string }> {
	const verifier = newVerifier();
	const end = await gitHubSignIn(github, person, await challengeOf(verifier));
	const code = end.searchParams.get("code");
	if (!code) throw new Error(`The sign-in ended with no code: ${end}`);
	const response = await tradeCode({ code, verifier });
	if (response.status !== 200) {
		throw new Error(`The code was refused: ${await response.text()}`);
	}
	const { token } = await response.json<{ token: string }>();
	const userId = await env.DB.prepare(
		`SELECT userId FROM account WHERE providerId = 'github' AND accountId = ?`,
	)
		.bind(String(person.id))
		.first<string>("userId");
	if (!userId) throw new Error(`No user for GitHub's ${person.login}`);
	return { token, userId };
}
