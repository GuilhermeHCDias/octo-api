import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allSessions,
	databaseContents,
	emptyDatabase,
} from "./support/database";
import { fakeGitHub, type GitHubPerson } from "./support/github";
import { installFakeNetwork } from "./support/network";
import { API, signIn } from "./support/sign-in";
import { fakeStripe } from "./support/stripe";

const OCTOCAT: GitHubPerson = {
	id: 583231,
	login: "octocat",
	name: "The Octocat",
	emails: [{ email: "octocat@github.com", primary: true, verified: true }],
};

const authenticatedRoutes = [
	{ method: "GET", path: "/account" },
	{ method: "POST", path: "/checkout", body: { plan: "pro_monthly" } },
];

let github: ReturnType<typeof fakeGitHub>;
let stripe: ReturnType<typeof fakeStripe>;
// The token the app holds after a sign-in: the session's, signed.
let token: string;

function call(
	route: (typeof authenticatedRoutes)[number],
	headers: Record<string, string>,
): Promise<Response> {
	return exports.default.fetch(`${API}${route.path}`, {
		method: route.method,
		headers: { "Content-Type": "application/json", ...headers },
		body: route.body ? JSON.stringify(route.body) : undefined,
	});
}

function signOut(headers: Record<string, string>): Promise<Response> {
	return exports.default.fetch(`${API}/api/auth/sign-out`, {
		method: "POST",
		headers,
	});
}

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	stripe = fakeStripe();
	installFakeNetwork(github, stripe);
	({ token } = await signIn(github, OCTOCAT));
	// What the sign-in asked GitHub is not what a route asks.
	github.requests.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe.each(authenticatedRoutes)("$method $path", (route) => {
	/** A 401 that asked nothing of GitHub or Stripe and wrote nothing. */
	async function expectRefusal(headers: Record<string, string>): Promise<void> {
		const before = await databaseContents();

		const response = await call(route, headers);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(github.requests).toEqual([]);
		expect(stripe.requests).toEqual([]);
		expect(await databaseContents()).toEqual(before);
	}

	it("answers for the signed token of a sign-in, without a call to GitHub", async () => {
		const response = await call(route, { Authorization: `Bearer ${token}` });

		expect(response.status).toBe(200);
		expect(github.requests).toEqual([]);
	});

	it("answers 401 when there is no Authorization header", async () => {
		await expectRefusal({});
	});

	it("answers 401 when the Authorization header is not a Bearer token", async () => {
		await expectRefusal({ Authorization: `Basic ${token}` });
		await expectRefusal({ Authorization: token });
	});

	it("answers 401 to a token the API never issued", async () => {
		await expectRefusal({
			Authorization:
				"Bearer Zx8Qw2Lr5Tn9Vb3Mk7Hj1Gf4Ds6Ap0Uy.c2lnbmF0dXJlLW9mLW5vYm9keS1hdC1hbGwtMDEyMzQ1Ng",
		});
	});

	it("answers 401 to the token of a session with another signature", async () => {
		const [value, signature = ""] = decodeURIComponent(token).split(".");
		const forged = (signature.startsWith("A") ? "B" : "A") + signature.slice(1);

		await expectRefusal({ Authorization: `Bearer ${value}.${forged}` });
	});

	it("answers 401 to the bare value of session.token as D1 holds it", async () => {
		const [session] = await allSessions();
		expect(decodeURIComponent(token).split(".")[0]).toBe(session?.token);

		await expectRefusal({ Authorization: `Bearer ${session?.token}` });
	});

	it("answers 401 to a GitHub token, even the one GitHub issued for the sign-in", async () => {
		await expectRefusal({ Authorization: "Bearer gho_issued_2" });
	});

	it("answers 401 to the signed token sent as a cookie and not as the header", async () => {
		await expectRefusal({
			Cookie: `__Secure-better-auth.session_token=${token}; better-auth.session_token=${token}`,
		});
	});

	it("still answers for a session that is 6 days old", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * 86_400_000 });

		const response = await call(route, { Authorization: `Bearer ${token}` });

		expect(response.status).toBe(200);
	});

	it("answers 401 to the token of a session that expired, after 7 days unused", async () => {
		vi.useFakeTimers({
			toFake: ["Date"],
			now: Date.now() + 7 * 86_400_000 + 1000,
		});

		const response = await call(route, { Authorization: `Bearer ${token}` });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(stripe.requests).toEqual([]);
	});

	it("answers 401 to the token of a session that POST /api/auth/sign-out ended", async () => {
		const signedOut = await signOut({ Authorization: `Bearer ${token}` });
		expect(signedOut.status).toBe(200);
		expect(await allSessions()).toEqual([]);

		await expectRefusal({ Authorization: `Bearer ${token}` });
	});

	it("never writes the token to a log", async () => {
		const logs = (["log", "info", "warn", "error", "debug"] as const).map(
			(level) => vi.spyOn(console, level).mockImplementation(() => {}),
		);
		const [value = ""] = decodeURIComponent(token).split(".");

		await call(route, { Authorization: `Bearer ${token}` });
		await call(route, { Authorization: `Bearer ${value}` });
		stripe.goDown();
		await call(route, { Authorization: `Bearer ${token}` });

		const logged = logs
			.flatMap((log) => log.mock.calls.flat())
			.map((value) =>
				value instanceof Error
					? `${value.stack} ${JSON.stringify(value)} ${String(value.cause)}`
					: JSON.stringify(value),
			)
			.join("\n");
		expect(logged).not.toContain(value);
	});
});

describe("POST /api/auth/sign-out", () => {
	it("ends the session of the token it is sent, and no other of the same user", async () => {
		const other = await signIn(github, OCTOCAT);
		expect(await allSessions()).toHaveLength(2);

		const response = await signOut({ Authorization: `Bearer ${token}` });

		expect(response.status).toBe(200);
		const remaining = await allSessions();
		expect(remaining).toHaveLength(1);
		expect(decodeURIComponent(other.token).split(".")[0]).toBe(
			remaining[0]?.token,
		);
		const stillIn = await call(
			{ method: "GET", path: "/account" },
			{ Authorization: `Bearer ${other.token}` },
		);
		expect(stillIn.status).toBe(200);
	});

	it("ends no session for the bare value of session.token", async () => {
		const [session] = await allSessions();

		await signOut({ Authorization: `Bearer ${session?.token}` });

		expect(await allSessions()).toHaveLength(1);
	});
});
