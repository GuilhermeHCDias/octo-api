import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	allBilling,
	allSubscriptions,
	allUsers,
	databaseContents,
	emptyDatabase,
	insertBilling,
	insertSubscription,
	insertUser,
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

// The users of these tests never sign in: the webhook reads their rows.
const OCTOCAT = "user_octocat";
const MOJOMBO = "user_mojombo";

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
	vi.useRealTimers();
});

describe("POST /webhooks/stripe with a signature that does not hold", () => {
	const body = stripeEvent("customer.subscription.updated", {
		id: "sub_octocat",
		customer: "cus_octocat",
	});

	beforeEach(async () => {
		// A sync of this customer would change these rows.
		await insertUser({ id: OCTOCAT });
		await insertBilling({
			user_id: OCTOCAT,
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

describe("a signed event of a subscribed type, for a customer stored on a user's billing row", () => {
	beforeEach(async () => {
		await insertUser({ id: OCTOCAT, email: "octocat@github.com" });
		await insertBilling({
			user_id: OCTOCAT,
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
			checkout_session_id: "cs_test_octocat",
		});
		await insertUser({ id: MOJOMBO });
		await insertBilling({
			user_id: MOJOMBO,
			stripe_customer_id: "cus_mojombo",
			billing_email: "mojombo@example.com",
		});
		await insertSubscription({
			user_id: MOJOMBO,
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
				user_id: OCTOCAT,
				stripe_subscription_id: "sub_octocat",
				status: "active",
				plan: "pro_year",
				current_period_end: "2027-11-13T12:00:00.000Z",
				cancel_at_period_end: 1,
				updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
			});
		},
	);

	it("mirrors the customer's e-mail as the billing e-mail, and keeps the user and the stored Checkout", async () => {
		const users = await allUsers();
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
		});

		await deliver("invoice.paid", "cus_octocat");

		expect(await allBilling()).toContainEqual({
			user_id: OCTOCAT,
			stripe_customer_id: "cus_octocat",
			billing_email: "billing@example.com",
			checkout_session_id: "cs_test_octocat",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: expect.not.stringMatching("2026-01-01T00:00:00.000Z"),
		});
		// The user's own e-mail is Better Auth's, and the webhook leaves it.
		expect(await allUsers()).toEqual(users);
	});

	it("leaves every other user's billing and subscription as they were", async () => {
		const [mojombo] = await allBilling();
		expect(mojombo?.user_id).toBe(MOJOMBO);
		const [mojomboSubscription] = await allSubscriptions();
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
		});

		const response = await deliver("invoice.paid", "cus_octocat");

		expect(response.status).toBe(200);
		expect(await allBilling()).toContainEqual(mojombo);
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
			expect.objectContaining({ user_id: OCTOCAT, status: "trialing" }),
		);
	});

	it("stores what Stripe has now, not the snapshot the event carries", async () => {
		await insertSubscription({
			user_id: OCTOCAT,
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
				user_id: OCTOCAT,
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
			expect.objectContaining({ user_id: OCTOCAT, status: "past_due" }),
		);
		const ignoringUpdatedAt = (contents: typeof afterFirst) => ({
			...contents,
			billing: contents.billing.map((row) => ({ ...row, updated_at: "" })),
			subscriptions: contents.subscriptions.map((row) => ({
				...row,
				updated_at: "",
			})),
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
				user_id: OCTOCAT,
				stripe_subscription_id: "sub_live",
				status: "unpaid",
				plan: "pro_year",
			}),
		);
	});

	it("stores the most recently created subscription when none is live", async () => {
		await insertSubscription({
			user_id: OCTOCAT,
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
				user_id: OCTOCAT,
				stripe_subscription_id: "sub_second",
				status: "canceled",
				plan: "pro_year",
			}),
		);
	});

	it("removes the user's subscription when the customer has none in Stripe", async () => {
		await insertSubscription({
			user_id: OCTOCAT,
			stripe_subscription_id: "sub_gone",
			status: "active",
		});

		const response = await deliver(
			"customer.subscription.deleted",
			"cus_octocat",
		);

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toEqual([
			expect.objectContaining({ user_id: MOJOMBO }),
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
			expect.objectContaining({ user_id: OCTOCAT, plan: null }),
		);
	});

	it("stores as scheduled a cancellation the customer portal set through cancel_at", async () => {
		// Under flexible billing the portal leaves the flag false and sets the
		// date instead.
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "active",
			cancel_at_period_end: false,
			cancel_at: 1_797_249_600,
		});

		const response = await deliver(
			"customer.subscription.updated",
			"cus_octocat",
		);

		expect(response.status).toBe(200);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({
				user_id: OCTOCAT,
				status: "active",
				cancel_at_period_end: 1,
			}),
		);
	});

	it("ends in Stripe's current state when two deliveries overlap and the older answer arrives last", async () => {
		// Only the clock is faked, so the two syncs start at distinct times.
		vi.useFakeTimers({ toFake: ["Date"] });
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "incomplete",
		});
		// The first delivery reads the subscription while it is incomplete.
		// Before Stripe's answer arrives, the payment goes through and a second
		// delivery syncs the new state.
		let second: Response | undefined;
		stripe.beforeNextAnswer("/v1/subscriptions", async () => {
			vi.setSystemTime(Date.now() + 1000);
			stripe.setSubscription({
				id: "sub_octocat",
				customer: "cus_octocat",
				status: "active",
			});
			second = await deliver("customer.subscription.updated", "cus_octocat");
			vi.setSystemTime(Date.now() + 1000);
		});

		const first = await deliver("customer.subscription.created", "cus_octocat");

		expect(first.status).toBe(200);
		expect(second?.status).toBe(200);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({ user_id: OCTOCAT, status: "active" }),
		);
	});

	it("forgets a customer deleted in Stripe, so the next Checkout creates a new one", async () => {
		await insertSubscription({
			user_id: OCTOCAT,
			stripe_subscription_id: "sub_octocat",
			status: "active",
		});
		// Deleting a customer cancels its subscriptions, which sends the event.
		stripe.deleteCustomer("cus_octocat");
		stripe.setSubscription({
			id: "sub_octocat",
			customer: "cus_octocat",
			status: "canceled",
		});

		const response = await deliver(
			"customer.subscription.deleted",
			"cus_octocat",
		);

		expect(response.status).toBe(200);
		expect(await allBilling()).toContainEqual(
			expect.objectContaining({
				user_id: OCTOCAT,
				stripe_customer_id: null,
				billing_email: null,
				checkout_session_id: "cs_test_octocat",
			}),
		);
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({ user_id: OCTOCAT, status: "canceled" }),
		);
	});
});

describe("a signed event of a subscribed type, for the customer of a first payment", () => {
	beforeEach(async () => {
		await insertUser({ id: OCTOCAT, email: "octocat@github.com" });
		// As POST /checkout leaves it: the Checkout, and no customer yet.
		await insertBilling({
			user_id: OCTOCAT,
			checkout_session_id: "cs_test_octocat",
		});
		await insertUser({ id: MOJOMBO });
		stripe.setCustomer("cus_new", "paid-with@example.com");
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: "active",
			plan: "pro_monthly",
			metadata: { user_id: OCTOCAT },
		});
	});

	it.each(SUBSCRIBED_TYPES)(
		"on %s, finds the user by the id stamped on the subscription",
		async (type) => {
			const users = await allUsers();

			const response = await deliver(type, "cus_new");

			expect(response.status).toBe(200);
			// The other user gets no billing row.
			expect(await allBilling()).toEqual([
				{
					user_id: OCTOCAT,
					stripe_customer_id: "cus_new",
					billing_email: "paid-with@example.com",
					checkout_session_id: "cs_test_octocat",
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: expect.not.stringMatching("2026-01-01T00:00:00.000Z"),
				},
			]);
			expect(await allUsers()).toEqual(users);
			expect(await allSubscriptions()).toEqual([
				{
					user_id: OCTOCAT,
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

	it("creates the billing row of a stamped user who has none", async () => {
		stripe.setCustomer("cus_other", "other@example.com");
		stripe.setSubscription({
			id: "sub_other",
			customer: "cus_other",
			status: "active",
			metadata: { user_id: MOJOMBO },
		});

		const response = await deliver("invoice.paid", "cus_other");

		expect(response.status).toBe(200);
		expect(await allBilling()).toContainEqual({
			user_id: MOJOMBO,
			stripe_customer_id: "cus_other",
			billing_email: "other@example.com",
			checkout_session_id: null,
			created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
			updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
		});
		expect(await allSubscriptions()).toContainEqual(
			expect.objectContaining({
				user_id: MOJOMBO,
				stripe_subscription_id: "sub_other",
				status: "active",
			}),
		);
	});

	it("ends in Stripe's current state whatever the order of the events", async () => {
		// The cancellation's event arrives before the purchase's.
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: "canceled",
			metadata: { user_id: OCTOCAT },
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
				user_id: OCTOCAT,
				stripe_subscription_id: "sub_new",
				status: "canceled",
			}),
		]);
	});
});

describe("a signed event that is not for the API", () => {
	beforeEach(async () => {
		await insertUser({ id: OCTOCAT });
		await insertBilling({
			user_id: OCTOCAT,
			stripe_customer_id: "cus_octocat",
		});
		await insertSubscription({ user_id: OCTOCAT, status: "active" });
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
		["is stamped with a user that does not exist", { user_id: "user_nobody" }],
		[
			"is stamped with something that is no user id",
			{ user_id: "user_octocat' OR '1'='1" },
		],
		[
			"carries only the stamp of the accounts that were dropped",
			{ github_user_id: "583231" },
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
		await insertUser({ id: OCTOCAT });
		await insertBilling({
			user_id: OCTOCAT,
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
		});
		await insertSubscription({ user_id: OCTOCAT, status: "active" });
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
		await insertUser({ id: OCTOCAT });
		await insertBilling({
			user_id: OCTOCAT,
			stripe_customer_id: "cus_octocat",
			billing_email: "old-billing@example.com",
		});
		await insertSubscription({ user_id: OCTOCAT, status: "active" });
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
