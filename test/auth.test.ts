import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseContents,
	emptyDatabase,
	insertAccount,
} from "./support/database";
import { fakeGitHub } from "./support/github";
import { installFakeNetwork } from "./support/network";
import { fakeStripe } from "./support/stripe";

const ORIGIN = "http://example.com";

const authenticatedRoutes = [
	{ method: "PUT", path: "/account" },
	{ method: "GET", path: "/account" },
	{ method: "POST", path: "/checkout", body: { plan: "pro_monthly" } },
];

let github: ReturnType<typeof fakeGitHub>;
let stripe: ReturnType<typeof fakeStripe>;

function call(
	route: (typeof authenticatedRoutes)[number],
	headers: Record<string, string>,
): Promise<Response> {
	return exports.default.fetch(`${ORIGIN}${route.path}`, {
		method: route.method,
		headers: { "Content-Type": "application/json", ...headers },
		body: route.body ? JSON.stringify(route.body) : undefined,
	});
}

beforeEach(async () => {
	await emptyDatabase();
	// The account exists: a 401 must come from the token, not from a 404.
	await insertAccount({ github_user_id: 583231, github_login: "octocat" });
	github = fakeGitHub();
	stripe = fakeStripe();
	installFakeNetwork(github, stripe);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(authenticatedRoutes)("$method $path", (route) => {
	it("answers 401 without asking GitHub when there is no Authorization header", async () => {
		const before = await databaseContents();

		const response = await call(route, {});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(github.requests).toEqual([]);
		expect(stripe.requests).toEqual([]);
		expect(await databaseContents()).toEqual(before);
	});

	it("answers 401 when the Authorization header is not a Bearer token", async () => {
		github.issueToken("gho_valid", { id: 583231, login: "octocat" });

		const response = await call(route, { Authorization: "Basic gho_valid" });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(github.requests).toEqual([]);
	});

	it("answers 401 and does nothing else when GitHub does not recognize the token as Octo's", async () => {
		const before = await databaseContents();

		const response = await call(route, {
			Authorization: "Bearer gho_from_another_app",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		// One request: the token check. No e-mails read, no Stripe call.
		expect(
			github.requests.map(({ method, url }) => `${method} ${url.pathname}`),
		).toEqual(["POST /applications/github_client_id_placeholder/token"]);
		expect(stripe.requests).toEqual([]);
		expect(await databaseContents()).toEqual(before);
	});

	it("lets a token issued to Octo's OAuth App through", async () => {
		github.issueToken("gho_valid", { id: 583231, login: "octocat" });

		const response = await call(route, { Authorization: "Bearer gho_valid" });

		expect(response.status).toBe(200);
	});

	it("never writes the token to a log, even when GitHub fails", async () => {
		const logs = (["log", "info", "warn", "error", "debug"] as const).map(
			(level) => vi.spyOn(console, level).mockImplementation(() => {}),
		);
		github.issueToken("gho_valid", { id: 583231, login: "octocat" });

		await call(route, { Authorization: "Bearer gho_valid" });
		await call(route, { Authorization: "Bearer gho_from_another_app" });
		github.goDown();
		const failed = await call(route, { Authorization: "Bearer gho_valid" });

		expect(failed.status).toBe(500);
		const logged = logs
			.flatMap((log) => log.mock.calls.flat())
			.map((value) =>
				value instanceof Error
					? `${value.stack} ${JSON.stringify(value)} ${String(value.cause)}`
					: JSON.stringify(value),
			)
			.join("\n");
		expect(logged).toContain("503");
		expect(logged).not.toContain("gho_");
	});
});

describe("a valid token", () => {
	it("is never written to D1", async () => {
		github.issueToken("gho_valid", { id: 583231, login: "octocat" }, [
			{ email: "octocat@github.com", primary: true, verified: true },
		]);

		for (const route of authenticatedRoutes) {
			await call(route, { Authorization: "Bearer gho_valid" });
		}

		expect(JSON.stringify(await databaseContents())).not.toContain("gho_");
	});
});
