import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseContents,
	emptyDatabase,
	insertBilling,
	insertSubscription,
	insertUser,
} from "./support/database";
import { fakeGitHub, type GitHubPerson } from "./support/github";
import { installFakeNetwork } from "./support/network";
import { signIn } from "./support/sign-in";
import { fakeStripe } from "./support/stripe";

const OCTOCAT: GitHubPerson = {
	id: 583231,
	login: "octocat",
	name: "The Octocat",
	emails: [{ email: "octocat@github.com", primary: true, verified: true }],
};

let github: ReturnType<typeof fakeGitHub>;
let stripe: ReturnType<typeof fakeStripe>;
let token: string;
// The id Better Auth gave the user of the sign-in.
let userId: string;

function account(method: string, bearer?: string): Promise<Response> {
	return exports.default.fetch("http://example.com/account", {
		method,
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	});
}

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	stripe = fakeStripe();
	installFakeNetwork(github, stripe);
	({ token, userId } = await signIn(github, OCTOCAT));
	github.requests.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GET /account", () => {
	it("answers 200 with no access and a null subscription for a user who never opened a Checkout", async () => {
		const before = await databaseContents();
		expect(before.billing).toEqual([]);

		const response = await account("GET", token);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			user_id: userId,
			email: "octocat@github.com",
			name: "The Octocat",
			access: false,
			subscription: null,
		});
		// Reading the account creates nothing.
		expect(await databaseContents()).toEqual(before);
	});

	it("answers the same for a user who opened a Checkout and never paid", async () => {
		await insertBilling({
			user_id: userId,
			checkout_session_id: "cs_test_previous",
		});

		const response = await account("GET", token);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			user_id: userId,
			email: "octocat@github.com",
			name: "The Octocat",
			access: false,
			subscription: null,
		});
	});

	it("answers with the subscription's status, plan, period end in ISO 8601 UTC and scheduled cancellation", async () => {
		await insertBilling({ user_id: userId, stripe_customer_id: "cus_octocat" });
		await insertSubscription({
			user_id: userId,
			status: "active",
			plan: "pro_year",
			current_period_end: "2027-11-14T12:00:00.000Z",
			cancel_at_period_end: 1,
		});

		const response = await account("GET", token);

		expect(await response.json()).toEqual({
			user_id: userId,
			email: "octocat@github.com",
			name: "The Octocat",
			access: true,
			subscription: {
				status: "active",
				plan: "pro_year",
				current_period_end: "2027-11-14T12:00:00.000Z",
				cancel_at_period_end: true,
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
		await insertBilling({ user_id: userId });
		await insertSubscription({ user_id: userId, status });

		const body = await (await account("GET", token)).json<{
			access: boolean;
			subscription: { status: string; cancel_at_period_end: boolean };
		}>();

		expect(body.access).toBe(access);
		expect(body.subscription.status).toBe(status);
		expect(body.subscription.cancel_at_period_end).toBe(false);
	});

	it("reads another user's subscription for nobody but that user", async () => {
		await insertUser({ id: "user_mojombo" });
		await insertBilling({ user_id: "user_mojombo" });
		await insertSubscription({ user_id: "user_mojombo", status: "active" });

		const body = await (await account("GET", token)).json();

		expect(body).toEqual({
			user_id: userId,
			email: "octocat@github.com",
			name: "The Octocat",
			access: false,
			subscription: null,
		});
	});

	it("answers each of two signed-in users their own account", async () => {
		const mojombo = await signIn(github, {
			id: 1,
			login: "mojombo",
			emails: [{ email: "tom@example.com", primary: true, verified: true }],
		});
		await insertBilling({ user_id: mojombo.userId });
		await insertSubscription({ user_id: mojombo.userId, status: "active" });

		const theirs = await (await account("GET", mojombo.token)).json();
		const mine = await (await account("GET", token)).json();

		expect(theirs).toEqual(
			expect.objectContaining({
				user_id: mojombo.userId,
				email: "tom@example.com",
				// GitHub's profile has no name: Better Auth takes the login.
				name: "mojombo",
				access: true,
			}),
		);
		expect(mine).toEqual(
			expect.objectContaining({ user_id: userId, access: false }),
		);
	});

	it("reads from D1 alone and changes nothing", async () => {
		await insertBilling({ user_id: userId, stripe_customer_id: "cus_octocat" });
		await insertSubscription({ user_id: userId, status: "active" });
		const before = await databaseContents();

		const response = await account("GET", token);

		expect(response.status).toBe(200);
		expect(await databaseContents()).toEqual(before);
		expect(stripe.requests).toEqual([]);
		expect(github.requests).toEqual([]);
	});
});

describe("PUT /account", () => {
	it.each([
		["a signed-in user", true],
		["anybody else", false],
	])("no longer exists: answers 404 to %s", async (_who, signedIn) => {
		const before = await databaseContents();

		const response = await account("PUT", signedIn ? token : undefined);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
		expect(await databaseContents()).toEqual(before);
		expect(github.requests).toEqual([]);
	});
});
