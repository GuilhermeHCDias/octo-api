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
import { installFakeNetwork } from "./support/network";
import { fakeStripe, stripeEvent, stripeSignature } from "./support/stripe";

const SUBSCRIBED_TYPES = [
	"checkout.session.completed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.paid",
	"invoice.payment_failed",
];

let stripe: ReturnType<typeof fakeStripe>;

function post(body: string, signature?: string): Promise<Response> {
	return exports.default.fetch("http://example.com/webhooks/stripe", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(signature && { "Stripe-Signature": signature }),
		},
		body,
	});
}

/** Posts a correctly signed event whose object belongs to `customer`. */
async function deliver(
	type: string,
	customer: string | null,
	object: Record<string, unknown> = {},
): Promise<Response> {
	const body = stripeEvent(type, { id: "obj_test", customer, ...object });
	return post(body, await stripeSignature(body));
}

beforeEach(async () => {
	await emptyDatabase();
	stripe = fakeStripe();
	installFakeNetwork(stripe);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /webhooks/stripe with a signature that does not hold", () => {
	const body = stripeEvent("customer.subscription.updated", {
		id: "sub_octocat",
		customer: "cus_octocat",
	});

	beforeEach(async () => {
		// A sync of this customer would change these rows.
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			stripe_customer_id: "cus_octocat",
		});
		stripe.setCustomer("cus_octocat", "billing@example.com");
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
		});
	});

	it.each([
		["is missing", async () => undefined],
		[
			"was made with another secret",
			() => stripeSignature(body, { secret: "whsec_of_somebody_else" }),
		],
		[
			"was made for another body",
			() => stripeSignature(body.replace("cus_octocat", "cus_mojombo")),
		],
		[
			"is older than Stripe's five-minute tolerance",
			() =>
				stripeSignature(body, {
					timestamp: Math.floor(Date.now() / 1000) - 301,
				}),
		],
		["is not a signature", async () => "t=now,v1=nonsense"],
	])(
		"answers 400 and writes nothing when the signature %s",
		async (_case, sign) => {
			const before = await databaseContents();

			const response = await post(body, await sign());

			expect(response.status).toBe(400);
			expect(await databaseContents()).toEqual(before);
			expect(stripe.requests).toEqual([]);
		},
	);

	it("accepts the same body with a signature four minutes old", async () => {
		const response = await post(
			body,
			await stripeSignature(body, {
				timestamp: Math.floor(Date.now() / 1000) - 240,
			}),
		);

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toHaveLength(1);
	});
});

describe("a signed event of a subscribed type, for a customer stored on an account", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
		});
		await insertAccount({
			github_user_id: 1,
			github_login: "mojombo",
			stripe_customer_id: "cus_mojombo",
			billing_email: "mojombo@example.com",
		});
		await insertSubscription({
			github_user_id: 1,
			stripe_subscription_id: "sub_mojombo",
			status: "active",
		});
		stripe.setCustomer("cus_octocat", "billing@example.com");
	});

	it.each(SUBSCRIBED_TYPES)(
		"on %s, stores the customer's current subscription and answers 200",
		async (type) => {
			stripe.setSubscription({
				id: "sub_octocat",
				customer: "cus_octocat",
				status: "active",
				plan: "pro_year",
				current_period_end: 1_826_107_200, // 2027-11-13T12:00:00Z
				cancel_at_period_end: true,
			});

			const response = await deliver(type, "cus_octocat");

			expect(response.status).toBe(200);
			expect(await allSubscriptions()).toContainEqual({
				github_user_id: 583231,
				stripe_subscription_id: "sub_octocat",
				status: "active",
				plan: "pro_year",
				current_period_end: "2027-11-13T12:00:00.000Z",
				cancel_at_period_end: 1,
				updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
			});
		},
	);

	it("mirrors the customer's e-mail as the billing e-mail and keeps the identity data", async () => {
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
		});

		await deliver("invoice.paid", "cus_octocat");

		expect(await allAccounts()).toContainEqual(
			expect.objectContaining({
				github_user_id: 583231,
				github_login: "octocat",
				github_email: "octocat@github.com",
				stripe_customer_id: "cus_octocat",
				billing_email: "billing@example.com",
			}),
		);
	});

	it("leaves every other account and subscription as they were", async () => {
		const [mojombo] = await allAccounts();
		const [mojomboSubscription] = await allSubscriptions();
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
		});

		const response = await deliver("invoice.paid", "cus_octocat");

		expect(response.status).toBe(200);
		expect(await allAccounts()).toContainEqual(mojombo);
		expect(await allSubscriptions()).toContainEqual(mojomboSubscription);
	});

	it("reads the customer of an event whose object carries it expanded", async () => {
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "trialing",
		});

		const body = stripeEvent("customer.subscription.updated", {
			id: "sub_octocat",
			customer: { id: "cus_octocat", object: "customer" },
		});
		const response = await post(body, await stripeSignature(body));

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({ github_user_id: 583231, status: "trialing" }),
		);
	});

	it("stores what Stripe has now, not the snapshot the event carries", async () => {
		await insertSubscription({
			github_user_id: 583231,
			stripe_subscription_id: "sub_octocat",
			status: "active",
		});
		// Stripe's current state: canceled. The event is an older one, delivered
		// late, whose snapshot still says active.
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "canceled",
		});

		const response = await deliver(
			"customer.subscription.updated",
			"cus_octocat",
			{ id: "sub_octocat", status: "active" },
		);

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({
				github_user_id: 583231,
				stripe_subscription_id: "sub_octocat",
				status: "canceled",
			}),
		);
	});

	it("leaves the same rows when the same event is delivered twice", async () => {
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "past_due",
		});
		const body = stripeEvent("invoice.payment_failed", {
			id: "in_octocat",
			customer: "cus_octocat",
		});
		const signature = await stripeSignature(body);

		const first = await post(body, signature);
		const afterFirst = await databaseContents();
		const second = await post(body, signature);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(afterFirst.subscriptions).toContainEqual(
			expect.objectContaining({ github_user_id: 583231, status: "past_due" }),
		);
		const ignoringUpdatedAt = ({
			accounts,
			subscriptions,
		}: typeof afterFirst) => ({
			accounts: accounts.map((row) => ({ ...row, updated_at: "" })),
			subscriptions: subscriptions.map((row) => ({ ...row, updated_at: "" })),
		});
		expect(ignoringUpdatedAt(await databaseContents())).toEqual(
			ignoringUpdatedAt(afterFirst),
		);
	});

	it("stores the live subscription when the customer also has canceled ones", async () => {
		stripe.setSubscription({
			id: "sub_first",
			customer: "cus_octocat",
			status: "canceled",
			created: 1_700_000_000,
		});
		stripe.setSubscription({
			id: "sub_live",
			customer: "cus_octocat",
			status: "unpaid",
			plan: "pro_year",
			created: 1_750_000_000,
		});
		// The most recent one never got a payment: it is not the current one.
		stripe.setSubscription({
			id: "sub_abandoned",
			customer: "cus_octocat",
			status: "incomplete_expired",
			created: 1_790_000_000,
		});

		await deliver("customer.subscription.updated", "cus_octocat");

		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({
				github_user_id: 583231,
				stripe_subscription_id: "sub_live",
				status: "unpaid",
				plan: "pro_year",
			}),
		);
	});

	it("stores the most recently created subscription when none is live", async () => {
		await insertSubscription({
			github_user_id: 583231,
			stripe_subscription_id: "sub_second",
			status: "active",
		});
		stripe.setSubscription({
			id: "sub_second",
			customer: "cus_octocat",
			status: "canceled",
			plan: "pro_year",
			created: 1_750_000_000,
		});
		stripe.setSubscription({
			id: "sub_first",
			customer: "cus_octocat",
			status: "canceled",
			created: 1_700_000_000,
		});

		await deliver("customer.subscription.deleted", "cus_octocat");

		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({
				github_user_id: 583231,
				stripe_subscription_id: "sub_second",
				status: "canceled",
				plan: "pro_year",
			}),
		);
	});

	it("removes the account's subscription when the customer has none in Stripe", async () => {
		await insertSubscription({
			github_user_id: 583231,
			stripe_subscription_id: "sub_gone",
			status: "active",
		});

		const response = await deliver(
			"customer.subscription.deleted",
			"cus_octocat",
		);

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toEqual([
			expect.objectContaining({ github_user_id: 1 }),
		]);
	});

	it("stores a null plan when the subscription's price has no lookup key", async () => {
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
			plan: null,
		});

		const response = await deliver("invoice.paid", "cus_octocat");

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({ github_user_id: 583231, plan: null }),
		);
	});
});

describe("a signed event of a subscribed type, for the customer of a first payment", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
		});
		await insertAccount({ github_user_id: 1, github_login: "mojombo" });
		stripe.setCustomer("cus_new", "paid-with@example.com");
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: "active",
			plan: "pro_monthly",
			metadata: { github_user_id: "583231" },
		});
	});

	it.each(SUBSCRIBED_TYPES)(
		"on %s, finds the account by the GitHub user id stamped on the subscription",
		async (type) => {
			const response = await deliver(type, "cus_new");

			expect(response.status).toBe(200);
			expect(await allAccounts()).toEqual([
				expect.objectContaining({
					github_user_id: 1,
					stripe_customer_id: null,
					billing_email: null,
				}),
				expect.objectContaining({
					github_user_id: 583231,
					github_email: "octocat@github.com",
					stripe_customer_id: "cus_new",
					billing_email: "paid-with@example.com",
				}),
			]);
			expect(await allSubscriptions()).toEqual([
				{
					github_user_id: 583231,
					stripe_subscription_id: "sub_new",
					status: "active",
					plan: "pro_monthly",
					current_period_end: "2026-12-14T12:00:00.000Z",
					cancel_at_period_end: 0,
					updated_at: expect.any(String),
				},
			]);
		},
	);

	it("ends in Stripe's current state whatever the order of the events", async () => {
		// The cancellation's event arrives before the purchase's.
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: "canceled",
			metadata: { github_user_id: "583231" },
		});

		await deliver("customer.subscription.deleted", "cus_new", {
			status: "canceled",
		});
		await deliver("checkout.session.completed", "cus_new");
		await deliver("customer.subscription.created", "cus_new", {
			status: "incomplete",
		});

		expect(await allSubscriptions()).toEqual([
			expect.objectContaining({
				github_user_id: 583231,
				stripe_subscription_id: "sub_new",
				status: "canceled",
			}),
		]);
	});
});

describe("a signed event that is not for the API", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			stripe_customer_id: "cus_octocat",
		});
		await insertSubscription({ github_user_id: 583231, status: "active" });
		stripe.setCustomer("cus_octocat", "billing@example.com");
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "canceled",
		});
	});

	it.each([
		"customer.updated",
		"invoice.created",
		"charge.refunded",
		"customer.subscription.paused",
	])(
		"answers 200 to %s without asking Stripe or changing anything",
		async (type) => {
			const before = await databaseContents();

			const response = await deliver(type, "cus_octocat");

			expect(response.status).toBe(200);
			expect(stripe.requests).toEqual([]);
			expect(await databaseContents()).toEqual(before);
		},
	);

	it("answers 200 and changes nothing when the event has no customer", async () => {
		const before = await databaseContents();

		const response = await deliver("checkout.session.completed", null);

		expect(response.status).toBe(200);
		expect(await databaseContents()).toEqual(before);
	});

	it.each([
		["has no stamped subscription", {}],
		["is stamped with a user that has no account", { github_user_id: "42" }],
		[
			"is stamped with something that is no user id",
			{ github_user_id: "583231 OR 1=1" },
		],
	])(
		"answers 200, changes nothing and logs the customer id when the customer %s",
		async (_case, metadata) => {
			const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
			stripe.setCustomer("cus_stranger", "stranger@example.com");
			stripe.setSubscription({
				id: "sub_stranger",
				customer: "cus_stranger",
				status: "active",
				metadata,
			});
			const before = await databaseContents();

			const response = await deliver("invoice.paid", "cus_stranger");

			expect(response.status).toBe(200);
			expect(await databaseContents()).toEqual(before);
			expect(logged).toHaveBeenCalledTimes(1);
			expect(logged.mock.calls[0]?.join(" ")).toContain("cus_stranger");
		},
	);
});

describe("a signed event of a subscribed type when Stripe fails", () => {
	it("answers 500 and changes nothing, so that Stripe delivers it again", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
		});
		await insertSubscription({ github_user_id: 583231, status: "active" });
		const before = await databaseContents();
		stripe.goDown();

		const response = await deliver(
			"customer.subscription.deleted",
			"cus_octocat",
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(await databaseContents()).toEqual(before);
		expect(logged).toHaveBeenCalled();
	});

	it("changes nothing when only the list of subscriptions fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
		});
		await insertSubscription({ github_user_id: 583231, status: "active" });
		stripe.setCustomer("cus_octocat", "billing@example.com");
		const before = await databaseContents();
		const answer = stripe.handle;
		stripe.handle = (request) => {
			if (request.url.pathname === "/v1/subscriptions") stripe.goDown();
			return answer(request);
		};

		const response = await deliver("invoice.paid", "cus_octocat");

		expect(response.status).toBe(500);
		expect(await databaseContents()).toEqual(before);
	});
});
