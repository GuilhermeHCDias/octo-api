import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allAccounts,
	allSubscriptions,
	databaseContents,
	emptyDatabase,
	insertAccount,
	insertSubscription,
} from "./support/database";
import { fakeGitHub } from "./support/github";
import { installFakeNetwork } from "./support/network";
import { fakeStripe } from "./support/stripe";

const OCTOCAT = { id: 583231, login: "octocat" };
const TOKEN = "gho_octocat";

let github: ReturnType<typeof fakeGitHub>;
let stripe: ReturnType<typeof fakeStripe>;

function account(method: "PUT" | "GET", token = TOKEN): Promise<Response> {
	return exports.default.fetch("http://example.com/account", {
		method,
		headers: { Authorization: `Bearer ${token}` },
	});
}

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	stripe = fakeStripe();
	installFakeNetwork(github, stripe);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PUT /account, for a user with no account", () => {
	it("creates the account with the GitHub user id, login and primary verified e-mail", async () => {
		github.issueToken(TOKEN, OCTOCAT, [
			{ email: "old@example.com", primary: false, verified: true },
			{ email: "octocat@github.com", primary: true, verified: true },
		]);

		const response = await account("PUT");

		expect(response.status).toBe(200);
		expect(await allAccounts()).toEqual([
			{
				github_user_id: 583231,
				github_login: "octocat",
				github_email: "octocat@github.com",
				stripe_customer_id: null,
				billing_email: null,
				created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
				updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
				checkout_session_id: null,
			},
		]);
		expect(await allSubscriptions()).toEqual([]);
	});

	it("answers with the body of GET /account", async () => {
		github.issueToken(TOKEN, OCTOCAT);

		const created = await account("PUT");
		const read = await account("GET");

		expect(await created.json()).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: false,
			subscription: null,
		});
		expect(created.headers.get("content-type")).toContain("application/json");
		expect(await read.json()).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: false,
			subscription: null,
		});
	});

	it.each([
		[
			"has no primary address that is verified",
			[
				{ email: "unverified@example.com", primary: true, verified: false },
				{ email: "secondary@example.com", primary: false, verified: true },
			],
		],
		["has no address", []],
		["was issued without the user:email scope", null],
	])(
		"creates the account with a null e-mail when the token %s",
		async (_case, emails) => {
			github.issueToken(TOKEN, OCTOCAT, emails);

			const response = await account("PUT");

			expect(response.status).toBe(200);
			expect(await allAccounts()).toEqual([
				expect.objectContaining({ github_user_id: 583231, github_email: null }),
			]);
		},
	);

	it("never calls Stripe", async () => {
		github.issueToken(TOKEN, OCTOCAT);

		await account("PUT");

		expect(stripe.requests).toEqual([]);
	});

	it("creates nothing and answers 500 when GitHub fails to list the e-mails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		github.issueToken(TOKEN, OCTOCAT);
		const emailsFail = github.handle;
		github.handle = (request) =>
			request.url.pathname === "/user/emails"
				? Response.json({ message: "Unavailable" }, { status: 503 })
				: emailsFail(request);

		const response = await account("PUT");

		expect(response.status).toBe(500);
		expect(await allAccounts()).toEqual([]);
	});
});

describe("PUT /account, for a user whose account exists", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "old-login",
			github_email: "old@example.com",
			stripe_customer_id: "cus_octocat",
			billing_email: "billing@example.com",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			checkout_session_id: "cs_test_previous",
		});
		await insertSubscription({
			github_user_id: 583231,
			stripe_subscription_id: "sub_octocat",
			status: "active",
			plan: "pro_year",
			current_period_end: "2027-11-14T12:00:00.000Z",
			cancel_at_period_end: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		// Another account, which the request must leave alone.
		await insertAccount({
			github_user_id: 1,
			github_login: "mojombo",
			github_email: "mojombo@example.com",
		});
	});

	it("refreshes the login and the e-mail, and keeps the Stripe data and the subscription", async () => {
		github.issueToken(TOKEN, { id: 583231, login: "octocat" }, [
			{ email: "octocat@github.com", primary: true, verified: true },
		]);
		const subscriptionsBefore = await allSubscriptions();

		const response = await account("PUT");

		expect(response.status).toBe(200);
		const [other, refreshed] = await allAccounts();
		expect(refreshed).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
			stripe_customer_id: "cus_octocat",
			billing_email: "billing@example.com",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: expect.not.stringMatching("2026-01-01T00:00:00.000Z"),
			checkout_session_id: "cs_test_previous",
		});
		expect(other).toEqual(
			expect.objectContaining({
				github_login: "mojombo",
				github_email: "mojombo@example.com",
			}),
		);
		expect(await allSubscriptions()).toEqual(subscriptionsBefore);
		expect(stripe.requests).toEqual([]);
	});

	it("clears the e-mail when GitHub no longer returns one", async () => {
		github.issueToken(TOKEN, OCTOCAT, []);

		await account("PUT");

		expect(await allAccounts()).toContainEqual(
			expect.objectContaining({ github_user_id: 583231, github_email: null }),
		);
	});

	it("answers with the account's subscription and access", async () => {
		github.issueToken(TOKEN, OCTOCAT);

		const response = await account("PUT");

		expect(await response.json()).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: true,
			subscription: {
				status: "active",
				plan: "pro_year",
				current_period_end: "2027-11-14T12:00:00.000Z",
				cancel_at_period_end: true,
			},
		});
	});
});

describe("GET /account", () => {
	beforeEach(() => {
		github.issueToken(TOKEN, OCTOCAT, [
			{ email: "octocat@github.com", primary: true, verified: true },
		]);
	});

	it("answers 404 and creates nothing when the user has no account", async () => {
		await insertAccount({ github_user_id: 1, github_login: "mojombo" });
		const before = await databaseContents();

		const response = await account("GET");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Account not found" });
		expect(await databaseContents()).toEqual(before);
	});

	it("answers 200 with a null subscription and no access for an account that never paid", async () => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });

		const response = await account("GET");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: false,
			subscription: null,
		});
	});

	it("answers with the subscription's status, plan, period end in ISO 8601 UTC and scheduled cancellation", async () => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });
		await insertSubscription({
			github_user_id: 583231,
			status: "active",
			plan: "pro_monthly",
			current_period_end: "2026-12-14T12:00:00.000Z",
			cancel_at_period_end: 0,
		});

		const response = await account("GET");

		expect(await response.json()).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: true,
			subscription: {
				status: "active",
				plan: "pro_monthly",
				current_period_end: "2026-12-14T12:00:00.000Z",
				cancel_at_period_end: false,
			},
		});
	});

	it.each([
		["active", true],
		["trialing", true],
		["past_due", true],
		["canceled", false],
		["unpaid", false],
		["incomplete", false],
		["incomplete_expired", false],
		["paused", false],
	])("for a %s subscription, answers access %s", async (status, access) => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });
		await insertSubscription({ github_user_id: 583231, status });

		const body = await (await account("GET")).json<{
			access: boolean;
			subscription: { status: string };
		}>();

		expect(body.access).toBe(access);
		expect(body.subscription.status).toBe(status);
	});

	it("reads another user's subscription for nobody but that user", async () => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });
		await insertAccount({ github_user_id: 1, github_login: "mojombo" });
		await insertSubscription({ github_user_id: 1, status: "active" });

		const body = await (await account("GET")).json();

		expect(body).toEqual({
			github_user_id: 583231,
			github_login: "octocat",
			access: false,
			subscription: null,
		});
	});

	it("reads from D1 alone and changes nothing", async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "old-login",
			github_email: "old@example.com",
			stripe_customer_id: "cus_octocat",
		});
		await insertSubscription({ github_user_id: 583231, status: "active" });
		const before = await databaseContents();

		const response = await account("GET");

		// The stored login, not the one GitHub has now.
		expect(await response.json()).toEqual(
			expect.objectContaining({ github_login: "old-login" }),
		);
		expect(await databaseContents()).toEqual(before);
		expect(stripe.requests).toEqual([]);
		// GitHub is asked for the token check and nothing else.
		expect(github.requests.map(({ url }) => url.pathname)).toEqual([
			"/applications/github_client_id_placeholder/token",
		]);
	});
});
