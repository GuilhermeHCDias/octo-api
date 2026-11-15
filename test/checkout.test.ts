import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	databaseContents,
	emptyDatabase,
	insertAccount,
	insertSubscription,
} from "./support/database";
import { fakeGitHub } from "./support/github";
import { installFakeNetwork } from "./support/network";
import { CHECKOUT_URL, fakeStripe } from "./support/stripe";

const TOKEN = "gho_octocat";

let github: ReturnType<typeof fakeGitHub>;
let stripe: ReturnType<typeof fakeStripe>;

function checkout(body?: string): Promise<Response> {
	return exports.default.fetch("http://example.com/checkout", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body,
	});
}

function checkoutPlan(plan: unknown): Promise<Response> {
	return checkout(JSON.stringify({ plan }));
}

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	github.issueToken(TOKEN, { id: 583231, login: "octocat" });
	stripe = fakeStripe();
	installFakeNetwork(github, stripe);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /checkout, for an account with no Stripe customer", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octo+cat@github.com",
		});
	});

	it.each([
		["pro_monthly", "price_monthly_123"],
		["pro_year", "price_year_456"],
	])(
		"creates a subscription Checkout Session for the price with the lookup key %s",
		async (plan, price) => {
			const response = await checkoutPlan(plan);

			expect(response.status).toBe(200);
			expect(stripe.sessions).toHaveLength(1);
			const session = Object.fromEntries(stripe.sessions[0] ?? []);
			expect(session).toMatchObject({
				mode: "subscription",
				"line_items[0][price]": price,
				"line_items[0][quantity]": "1",
			});
			expect(
				Object.keys(session).filter((name) => name.startsWith("line_items[1]")),
			).toEqual([]);
		},
	);

	it("stamps the GitHub user id on the session and on the subscription it creates", async () => {
		await checkoutPlan("pro_monthly");

		expect(Object.fromEntries(stripe.sessions[0] ?? [])).toMatchObject({
			client_reference_id: "583231",
			"subscription_data[metadata][github_user_id]": "583231",
		});
	});

	it("sends the success and cancel URLs of the Worker's configuration", async () => {
		await checkoutPlan("pro_monthly");

		expect(Object.fromEntries(stripe.sessions[0] ?? [])).toMatchObject({
			success_url: "https://octo.test/checkout/success",
			cancel_url: "https://octo.test/checkout/cancel",
		});
	});

	it("lists no payment methods, leaving them to the Stripe Dashboard", async () => {
		await checkoutPlan("pro_monthly");

		expect(stripe.sessions).toHaveLength(1);
		const names = [...(stripe.sessions[0]?.keys() ?? [])];
		expect(names.filter((name) => name.startsWith("payment_method"))).toEqual(
			[],
		);
	});

	it("names no customer and locks no e-mail on the session", async () => {
		await checkoutPlan("pro_monthly");

		expect(stripe.sessions).toHaveLength(1);
		const names = [...(stripe.sessions[0]?.keys() ?? [])];
		expect(names.filter((name) => name.startsWith("customer"))).toEqual([]);
	});

	it("answers 200 with the Checkout URL carrying the GitHub e-mail as prefilled_email", async () => {
		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		const { url } = await response.json<{ url: string }>();
		const returned = new URL(url);
		expect(returned.searchParams.get("prefilled_email")).toBe(
			"octo+cat@github.com",
		);
		// Nothing else about Stripe's URL changes, fragment included.
		returned.searchParams.delete("prefilled_email");
		expect(returned.href).toBe(CHECKOUT_URL);
	});

	it("changes nothing in D1", async () => {
		const before = await databaseContents();

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		expect(await databaseContents()).toEqual(before);
	});
});

describe("POST /checkout, for an account with no Stripe customer and no GitHub e-mail", () => {
	it("answers with the Checkout URL as Stripe returned it", async () => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });

		const response = await checkoutPlan("pro_year");

		expect(await response.json()).toEqual({ url: CHECKOUT_URL });
	});
});

describe("POST /checkout, for an account with a Stripe customer", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
			stripe_customer_id: "cus_octocat",
			billing_email: "billing@example.com",
		});
	});

	it("names the stored customer on the session and returns Stripe's URL untouched", async () => {
		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ url: CHECKOUT_URL });
		const session = Object.fromEntries(stripe.sessions[0] ?? []);
		expect(session.customer).toBe("cus_octocat");
		expect(session).not.toHaveProperty("customer_email");
		expect(session).toMatchObject({
			mode: "subscription",
			client_reference_id: "583231",
			"subscription_data[metadata][github_user_id]": "583231",
		});
	});

	it.each(["canceled", "incomplete", "incomplete_expired"])(
		"opens a new Checkout when the stored subscription is %s",
		async (status) => {
			await insertSubscription({ github_user_id: 583231, status });

			const response = await checkoutPlan("pro_year");

			expect(response.status).toBe(200);
			expect(stripe.sessions).toHaveLength(1);
		},
	);

	it.each(["active", "trialing", "past_due", "unpaid", "paused"])(
		"creates no session and answers 409 when the stored subscription is %s",
		async (status) => {
			await insertSubscription({ github_user_id: 583231, status });

			const response = await checkoutPlan("pro_year");

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "Already subscribed" });
			expect(stripe.requests).toEqual([]);
		},
	);
});

describe("POST /checkout with an invalid plan", () => {
	beforeEach(async () => {
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });
	});

	it.each([
		["is neither of the two plans", JSON.stringify({ plan: "pro_weekly" })],
		["is a price id", JSON.stringify({ plan: "price_monthly_123" })],
		["is not a string", JSON.stringify({ plan: ["pro_monthly"] })],
		["is missing", JSON.stringify({})],
		["comes in a body that is not an object", JSON.stringify("pro_monthly")],
		["comes in a body that is not JSON", "plan=pro_monthly"],
		["comes in no body", undefined],
	])(
		"creates no session and answers 400 when the plan %s",
		async (_case, body) => {
			const response = await checkout(body);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "Invalid plan" });
			expect(stripe.requests).toEqual([]);
		},
	);
});

describe("POST /checkout, for a user with no account", () => {
	it("creates no session and no account, and answers 404", async () => {
		await insertAccount({ github_user_id: 1, github_login: "mojombo" });
		const before = await databaseContents();

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Account not found" });
		expect(stripe.requests).toEqual([]);
		expect(await databaseContents()).toEqual(before);
	});
});

describe("POST /checkout when Stripe fails", () => {
	it("answers the scaffold's 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await insertAccount({ github_user_id: 583231, github_login: "octocat" });
		stripe.goDown();

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
	});
});
