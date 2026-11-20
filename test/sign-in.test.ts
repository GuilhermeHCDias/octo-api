import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApplePerson, fakeApple } from "./support/apple";
import { openBrowser } from "./support/browser";
import {
	allProviderAccounts,
	allSessions,
	allUsers,
	allVerifications,
	databaseContents,
	emptyDatabase,
} from "./support/database";
import { fakeGitHub, type GitHubPerson } from "./support/github";
import { installFakeNetwork } from "./support/network";
import {
	API,
	appleSignIn,
	challengeOf,
	gitHubSignIn,
	newVerifier,
	startSignIn,
	tradeCode,
} from "./support/sign-in";

const OCTOCAT: GitHubPerson = {
	id: 583231,
	login: "octocat",
	name: "The Octocat",
	emails: [{ email: "octocat@github.com", primary: true, verified: true }],
};

const APPLESEED: ApplePerson = {
	sub: "001234.5678abcd.0912",
	email: "johnny@icloud.com",
	name: { firstName: "Johnny", lastName: "Appleseed" },
};

let github: ReturnType<typeof fakeGitHub>;
let apple: ReturnType<typeof fakeApple>;
let verifier: string;
let challenge: string;

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	apple = fakeApple();
	installFakeNetwork(github, apple);
	verifier = newVerifier();
	challenge = await challengeOf(verifier);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Fails the test unless `end` is APP_SIGN_IN_URL with an error and no code. */
function expectFailure(end: URL): void {
	expect(end.href.split("?")[0]).toBe(env.APP_SIGN_IN_URL);
	expect(end.searchParams.get("error")).toMatch(/^\w+$/);
	expect(end.searchParams.has("code")).toBe(false);
}

describe("GET /sign-in/github", () => {
	it("redirects the browser to GitHub's authorization page, naming the API's callback as the return address", async () => {
		const response = await startSignIn(openBrowser(), "github", challenge);

		expect(response.status).toBe(302);
		const page = new URL(response.headers.get("Location") ?? "");
		expect(page.origin + page.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(page.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
		expect(page.searchParams.get("redirect_uri")).toBe(
			`${API}/api/auth/callback/github`,
		);
		expect(page.searchParams.get("response_type")).toBe("code");
		expect(page.searchParams.get("scope")?.split(" ")).toContain("user:email");
		expect(page.searchParams.get("state")).toMatch(/\S{16,}/);
		// The API asks GitHub nothing until the browser comes back.
		expect(github.requests).toEqual([]);
	});
});

describe("GET /sign-in/apple", () => {
	it("redirects the browser to Apple's authorization page, naming the API's callback as the return address", async () => {
		const response = await startSignIn(openBrowser(), "apple", challenge);

		expect(response.status).toBe(302);
		const page = new URL(response.headers.get("Location") ?? "");
		expect(page.origin + page.pathname).toBe(
			"https://appleid.apple.com/auth/authorize",
		);
		expect(page.searchParams.get("client_id")).toBe(env.APPLE_CLIENT_ID);
		expect(page.searchParams.get("redirect_uri")).toBe(
			`${API}/api/auth/callback/apple`,
		);
		expect(page.searchParams.get("response_mode")).toBe("form_post");
		expect(page.searchParams.get("state")).toMatch(/\S{16,}/);
	});
});

describe.each(["github", "apple"])("GET /sign-in/%s", (provider) => {
	it("ties the sign-in to the browser with a cookie that lives as long as the sign-in's state, 10 minutes", async () => {
		const response = await startSignIn(openBrowser(), provider, challenge);

		const cookies = response.headers.getSetCookie();
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).toMatch(/;\s*Max-Age=600(;|$)/i);
		const [state] = await allVerifications();
		const secondsLeft =
			(new Date(state?.expiresAt ?? 0).getTime() - Date.now()) / 1000;
		expect(Math.round(secondsLeft / 60)).toBe(10);
	});

	it.each([
		["is missing", ""],
		["is empty", "?challenge="],
		[
			"is shorter than a SHA-256",
			"?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URW",
		],
		[
			"is longer than a SHA-256",
			"?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMx",
		],
		[
			"carries base64 padding",
			"?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM=",
		],
		[
			"is plain base64, not base64url",
			"?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM",
		],
		[
			"is the SHA-256 in hexadecimal",
			"?challenge=13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3",
		],
	])(
		"answers 400 and starts nothing when the challenge %s",
		async (_case, query) => {
			const response = await openBrowser().get(
				`${API}/sign-in/${provider}${query}`,
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "Invalid challenge" });
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(await allVerifications()).toEqual([]);
		},
	);
});

describe("GET /sign-in/<any other name>", () => {
	it.each(["google", "token", "GitHub", "github/extra", ""])(
		"answers 404 for %j, even with a good challenge",
		async (name) => {
			const response = await openBrowser().get(
				`${API}/sign-in/${name}?challenge=${challenge}`,
			);

			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "Not Found" });
			expect(await allVerifications()).toEqual([]);
		},
	);
});

describe("the provider's return to the callback, with an authorization", () => {
	it("creates the user at a first sign-in with GitHub, with the provider account and a session", async () => {
		const end = await gitHubSignIn(github, OCTOCAT, challenge);

		expect(end.searchParams.has("error")).toBe(false);
		const [user, ...otherUsers] = await allUsers();
		expect(otherUsers).toEqual([]);
		expect(user).toEqual(
			expect.objectContaining({
				name: "The Octocat",
				email: "octocat@github.com",
				emailVerified: 1,
			}),
		);
		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({
				providerId: "github",
				accountId: "583231",
				userId: user?.id,
			}),
		]);
		expect(await allSessions()).toEqual([
			expect.objectContaining({ userId: user?.id }),
		]);
	});

	it("creates the user at a first sign-in with Apple, whose client secret the API signed with the team's key", async () => {
		const end = await appleSignIn(apple, APPLESEED, challenge);

		expect(end.searchParams.has("error")).toBe(false);
		const [user, ...otherUsers] = await allUsers();
		expect(otherUsers).toEqual([]);
		expect(user).toEqual(
			expect.objectContaining({
				name: "Johnny Appleseed",
				email: "johnny@icloud.com",
				emailVerified: 1,
			}),
		);
		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({
				providerId: "apple",
				accountId: "001234.5678abcd.0912",
				userId: user?.id,
			}),
		]);
		expect(await allSessions()).toEqual([
			expect.objectContaining({ userId: user?.id }),
		]);
		// The fake answers a token only to a client secret signed by the key.
		expect(
			apple.requests.map(({ method, url }) => `${method} ${url.pathname}`),
		).toContain("POST /auth/token");
	});

	it.each(["GitHub", "Apple"])(
		"redirects the browser of a sign-in with %s to APP_SIGN_IN_URL with a code and nothing else of the session",
		async (provider) => {
			const browser = openBrowser();

			const end = await (provider === "GitHub"
				? gitHubSignIn(github, OCTOCAT, challenge, browser)
				: appleSignIn(apple, APPLESEED, challenge, { browser }));

			expect(end.href.split("?")[0]).toBe("octo://sign-in");
			expect([...end.searchParams.keys()]).toEqual(["code"]);
			expect(end.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
			const [session] = await allSessions();
			expect(end.href).not.toContain(session?.token);
			// The browser is left with no cookie: neither the session's nor
			// the one that tied the sign-in to it.
			expect([...browser.cookies.keys()]).toEqual([]);
		},
	);

	it("sends nothing of the session to the browser besides the code", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "github", challenge);
		const callback = github.authorize(
			start.headers.get("Location") ?? "",
			OCTOCAT,
		);

		const response = await browser.get(callback);

		expect(response.status).toBe(302);
		const [session] = await allSessions();
		expect(session?.token).toMatch(/\S{32}/);
		const sent = JSON.stringify([
			[...response.headers],
			response.headers.getSetCookie(),
			await response.text(),
		]);
		expect(sent).not.toContain(session?.token);
		expect(response.headers.has("set-auth-token")).toBe(false);
		expect(
			response.headers
				.getSetCookie()
				.filter((cookie) => !/Max-Age=0/i.test(cookie)),
		).toEqual([]);
	});

	it("keeps with the session the client's address as Cloudflare reports it, and the browser's user agent", async () => {
		const browser = openBrowser({
			"CF-Connecting-IP": "203.0.113.7",
			// What a client can write itself is not believed.
			"X-Forwarded-For": "198.51.100.99",
		});

		await gitHubSignIn(github, OCTOCAT, challenge, browser);

		expect(await allSessions()).toEqual([
			expect.objectContaining({
				ipAddress: "203.0.113.7",
				userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15",
			}),
		]);
	});

	it("finds the user of a provider account at a later sign-in, creating no second user", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);
		const [user] = await allUsers();

		// The same GitHub account, whose login and e-mail changed since.
		const end = await gitHubSignIn(
			github,
			{
				...OCTOCAT,
				login: "octocat-renamed",
				emails: [{ email: "new@github.com", primary: true, verified: true }],
			},
			challenge,
		);

		expect(end.searchParams.get("code")).toMatch(/\S+/);
		expect(await allUsers()).toEqual([
			expect.objectContaining({ id: user?.id }),
		]);
		expect(await allProviderAccounts()).toHaveLength(1);
		expect((await allSessions()).map(({ userId }) => userId)).toEqual([
			user?.id,
			user?.id,
		]);
	});

	it("gives two people two users", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);
		await gitHubSignIn(
			github,
			{
				id: 1,
				login: "mojombo",
				emails: [{ email: "tom@example.com", primary: true, verified: true }],
			},
			challenge,
		);

		expect((await allUsers()).map(({ email }) => email).sort()).toEqual([
			"octocat@github.com",
			"tom@example.com",
		]);
	});
});

describe("the provider's return to the callback, refused or failed", () => {
	beforeEach(() => {
		// Better Auth logs every failed sign-in.
		for (const level of ["error", "warn", "info", "log"] as const) {
			vi.spyOn(console, level).mockImplementation(() => {});
		}
	});

	it("opens no session and redirects to APP_SIGN_IN_URL with an error when the person refuses at GitHub", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "github", challenge);

		const response = await browser.get(
			github.refuse(start.headers.get("Location") ?? ""),
		);

		expect(response.status).toBe(302);
		const end = new URL(response.headers.get("Location") ?? "");
		expectFailure(end);
		expect(end.searchParams.get("error")).toBe("access_denied");
		expect(await allSessions()).toEqual([]);
		expect(await allUsers()).toEqual([]);
		expect(github.requests).toEqual([]);
	});

	it("passes on no error text of the provider's that is not a plain code", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "github", challenge);
		const callback = new URL(
			github.refuse(start.headers.get("Location") ?? ""),
		);
		callback.searchParams.set("error", "octo://sign-in?code=<a code>");

		const response = await browser.get(callback.href);

		const end = new URL(response.headers.get("Location") ?? "");
		expectFailure(end);
		expect([...end.searchParams]).toEqual([["error", "sign_in_failed"]]);
	});

	it("opens no session and redirects to APP_SIGN_IN_URL with an error when the person refuses at Apple", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "apple", challenge);
		const { url, form } = apple.refuse(start.headers.get("Location") ?? "");

		const posted = await browser.post(url, form, "https://appleid.apple.com");
		const response = await browser.get(posted.headers.get("Location") ?? "");

		expectFailure(new URL(response.headers.get("Location") ?? ""));
		expect(await allSessions()).toEqual([]);
		expect(await allUsers()).toEqual([]);
	});

	it("fails when GitHub does not know the code", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "github", challenge);
		const callback = new URL(
			github.authorize(start.headers.get("Location") ?? "", OCTOCAT),
		);
		callback.searchParams.set("code", "a_code_github_never_issued");

		const response = await browser.get(callback.href);

		expectFailure(new URL(response.headers.get("Location") ?? ""));
		expect(await allSessions()).toEqual([]);
		expect(await allUsers()).toEqual([]);
	});

	it("fails when the callback is opened in a browser that did not start the sign-in", async () => {
		const start = await startSignIn(openBrowser(), "github", challenge);
		const callback = github.authorize(
			start.headers.get("Location") ?? "",
			OCTOCAT,
		);

		const response = await openBrowser().get(callback);

		expectFailure(new URL(response.headers.get("Location") ?? ""));
		expect(await allSessions()).toEqual([]);
		expect(await allUsers()).toEqual([]);
	});

	it("fails when the callback carries a state the API never issued", async () => {
		const browser = openBrowser();
		await startSignIn(browser, "github", challenge);

		const response = await browser.get(
			`${API}/api/auth/callback/github?code=any&state=a_state_never_issued`,
		);

		expectFailure(new URL(response.headers.get("Location") ?? ""));
		expect(await allSessions()).toEqual([]);
	});

	it.each([
		["has no address", []],
		["hides its addresses from the token", null],
	])(
		"fails and creates no user when the GitHub account %s",
		async (_case, emails) => {
			const end = await gitHubSignIn(github, { ...OCTOCAT, emails }, challenge);

			expectFailure(end);
			expect(await allSessions()).toEqual([]);
			expect(await allUsers()).toEqual([]);
		},
	);

	it("fails when GitHub is down", async () => {
		const browser = openBrowser();
		const start = await startSignIn(browser, "github", challenge);
		const callback = github.authorize(
			start.headers.get("Location") ?? "",
			OCTOCAT,
		);
		github.goDown();

		const response = await browser.get(callback);

		expectFailure(new URL(response.headers.get("Location") ?? ""));
		expect(await allSessions()).toEqual([]);
	});
});

describe("POST /sign-in/token", () => {
	let code: string;

	beforeEach(async () => {
		const end = await gitHubSignIn(github, OCTOCAT, challenge);
		code = end.searchParams.get("code") ?? "";
	});

	it("answers 200 with the session's signed token for the code and the verifier of its sign-in", async () => {
		const response = await tradeCode({ code, verifier });

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = await response.json<{ token: string }>();
		expect(Object.keys(body)).toEqual(["token"]);
		// The token of the session D1 holds, followed by its signature.
		const [session] = await allSessions();
		const [value, signature] = decodeURIComponent(body.token).split(".");
		expect(value).toBe(session?.token);
		expect(signature).toMatch(/\S{40,}/);
		// The answer is the body alone: no cookie for a client that has no jar.
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("trades the code of a sign-in with Apple too", async () => {
		const appleVerifier = newVerifier();
		const end = await appleSignIn(
			apple,
			APPLESEED,
			await challengeOf(appleVerifier),
		);

		const response = await tradeCode({
			code: end.searchParams.get("code"),
			verifier: appleVerifier,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			token: expect.stringMatching(/\S+\.\S+/),
		});
	});

	it("answers 401 and no token to a code already used", async () => {
		await tradeCode({ code, verifier });

		const response = await tradeCode({ code, verifier });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("trades a code that is 2 minutes and 59 seconds old", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 179_000 });

		const response = await tradeCode({ code, verifier });

		expect(response.status).toBe(200);
	});

	it("answers 401 and no token to a code older than 3 minutes", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 181_000 });

		const response = await tradeCode({ code, verifier });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("answers 401 and no token to a code never issued", async () => {
		const response = await tradeCode({
			code: "Zx8Qw2Lr5Tn9Vb3Mk7Hj1Gf4Ds6Ap0Uy",
			verifier,
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("answers 401 and no token to a verifier that is not the one of the sign-in", async () => {
		const response = await tradeCode({ code, verifier: newVerifier() });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("answers 401 to the challenge sent in the place of the verifier", async () => {
		const response = await tradeCode({ code, verifier: challenge });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("does not trade the code of one sign-in with the verifier of another", async () => {
		const otherVerifier = newVerifier();
		const otherEnd = await gitHubSignIn(
			github,
			{
				id: 1,
				login: "mojombo",
				emails: [{ email: "tom@example.com", primary: true, verified: true }],
			},
			await challengeOf(otherVerifier),
		);

		const response = await tradeCode({
			code: otherEnd.searchParams.get("code"),
			verifier,
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it.each([
		["has no verifier", (code: string) => ({ code })],
		["has no code", () => ({ verifier: "v" })],
		["has a code that is not a string", () => ({ code: 7, verifier: "v" })],
		[
			"has a verifier that is not a string",
			(code: string) => ({ code, verifier: {} }),
		],
		["is not an object", () => "code"],
		["is null", () => null],
	])("answers 401 when the body %s", async (_case, body) => {
		const response = await tradeCode(body(code));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});

	it("answers 401 when the body is not JSON", async () => {
		const response = await exports.default.fetch(`${API}/sign-in/token`, {
			method: "POST",
			body: "code=1&verifier=2",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Invalid code" });
	});
});

describe("the single-use code", () => {
	let code: string;

	beforeEach(async () => {
		const end = await gitHubSignIn(github, OCTOCAT, challenge);
		code = end.searchParams.get("code") ?? "";
	});

	it("is at no moment in D1 in a readable form", async () => {
		const afterTheSignIn = JSON.stringify(await databaseContents());
		await tradeCode({ code, verifier: newVerifier() });
		const afterARefusal = JSON.stringify(await databaseContents());
		await tradeCode({ code, verifier });
		const afterTheTrade = JSON.stringify(await databaseContents());

		expect(code).toMatch(/\S{32,}/);
		expect(afterTheSignIn).not.toContain(code);
		expect(afterARefusal).not.toContain(code);
		expect(afterTheTrade).not.toContain(code);
	});

	it("cannot be traded at Better Auth's own endpoint, which answers 404 and leaves the code good", async () => {
		const attempts = await Promise.all(
			[code, `${code}.${challenge}`].map((token) =>
				exports.default.fetch(`${API}/api/auth/one-time-token/verify`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
				}),
			),
		);

		for (const attempt of attempts) {
			expect(attempt.status).toBe(404);
			expect(await attempt.json()).toEqual({ error: "Not Found" });
			expect(attempt.headers.has("set-auth-token")).toBe(false);
			expect(attempt.headers.getSetCookie()).toEqual([]);
		}
		expect((await tradeCode({ code, verifier })).status).toBe(200);
	});

	it("cannot be asked of Better Auth by a client, even one with a session", async () => {
		const { token } = await (await tradeCode({ code, verifier })).json<{
			token: string;
		}>();
		const before = await allVerifications();

		const response = await exports.default.fetch(
			`${API}/api/auth/one-time-token/generate`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
		expect(await allVerifications()).toEqual(before);
	});
});
