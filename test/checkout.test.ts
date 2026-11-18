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
import { CHECKOUT_URL, checkoutUrl, fakeStripe } from "./support/stripe";

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

/** The requests the Worker made to Stripe, in order, as "METHOD /path". */
function stripeCalls(): string[] {
	return stripe.requests.map(({ method, url }) => `${method} ${url.pathname}`);
}

/** The URL a 200 answered, without the e-mail the API adds to it. */
async function answeredUrl(response: Response): Promise<string> {
	const { url } = await response.json<{ url: string }>();
	const answered = new URL(url);
	answered.searchParams.delete("prefilled_email");
	return answered.href;
}

async function storedSessionId(): Promise<string | null | undefined> {
	const { accounts } = await databaseContents();
	return accounts.find(({ github_user_id }) => github_user_id === 583231)
		?.checkout_session_id;
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

	it("stores the session's id on the account and changes nothing else in D1", async () => {
		const before = await databaseContents();

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		const [account] = before.accounts;
		expect(await databaseContents()).toEqual({
			accounts: [{ ...account, checkout_session_id: "cs_test_a1B2c3" }],
			subscriptions: [],
		});
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
		// The route now asks Stripe about a stored customer, so Stripe has it.
		stripe.setCustomer("cus_octocat", "billing@example.com");
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
			stripe.setSubscription({
				id: "sub_of_583231",
				customer: "cus_octocat",
				status,
			});

			const response = await checkoutPlan("pro_year");

			expect(response.status).toBe(200);
			expect(stripe.sessions).toHaveLength(1);
		},
	);

	it.each([
		["has no subscription row", null],
		["has a canceled subscription row", "canceled"],
	])(
		"mirrors the customer in D1, creates no session and answers 409 when Stripe has a live subscription and the account %s",
		async (_case, storedStatus) => {
			if (storedStatus) {
				await insertSubscription({
					github_user_id: 583231,
					stripe_subscription_id: "sub_old",
					status: storedStatus,
				});
				stripe.setSubscription({
					id: "sub_old",
					customer: "cus_octocat",
					status: storedStatus,
					created: 1_793_000_000,
				});
			}
			// Paid, and the webhook has not delivered it.
			stripe.setSubscription({
				id: "sub_paid",
				customer: "cus_octocat",
				status: "active",
				plan: "pro_year",
			});

			const response = await checkoutPlan("pro_monthly");

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "Already subscribed" });
			expect(stripe.sessions).toEqual([]);
			expect(await databaseContents()).toMatchObject({
				accounts: [{ stripe_customer_id: "cus_octocat" }],
				subscriptions: [
					{
						github_user_id: 583231,
						stripe_subscription_id: "sub_paid",
						status: "active",
						plan: "pro_year",
					},
				],
			});
		},
	);

	it("mirrors the customer in D1 before it creates the session, when Stripe has no live subscription either", async () => {
		// D1 is behind: Stripe has since given up on the subscription.
		await insertSubscription({
			github_user_id: 583231,
			stripe_subscription_id: "sub_old",
			status: "incomplete",
		});
		stripe.setSubscription({
			id: "sub_old",
			customer: "cus_octocat",
			status: "incomplete_expired",
		});

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		expect(await databaseContents()).toMatchObject({
			subscriptions: [
				{ stripe_subscription_id: "sub_old", status: "incomplete_expired" },
			],
		});
		const calls = stripeCalls();
		expect(calls).toContain("GET /v1/customers/cus_octocat");
		expect(calls.indexOf("GET /v1/subscriptions")).toBeGreaterThan(-1);
		expect(calls.indexOf("GET /v1/subscriptions")).toBeLessThan(
			calls.indexOf("POST /v1/checkout/sessions"),
		);
	});

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

describe("POST /checkout, for an account that opened a Checkout before", () => {
	it.each([
		["pro_monthly", "pro_monthly"],
		["pro_monthly", "pro_year"],
		["pro_year", "pro_monthly"],
	])(
		"expires the open %s Checkout before it answers with a new %s one",
		async (earlierPlan, laterPlan) => {
			await insertAccount({
				github_user_id: 583231,
				github_login: "octocat",
				github_email: "octocat@github.com",
			});

			const earlier = await checkoutPlan(earlierPlan);
			const later = await checkoutPlan(laterPlan);

			expect(earlier.status).toBe(200);
			expect(later.status).toBe(200);
			expect(stripe.checkoutSessions()).toEqual([
				{ id: "cs_test_a1B2c3", status: "expired", customer: null },
				{ id: "cs_test_number2", status: "open", customer: null },
			]);
			expect(await answeredUrl(later)).toBe(checkoutUrl("cs_test_number2"));
			expect(await storedSessionId()).toBe("cs_test_number2");
		},
	);

	it("creates the new session without trying to expire a previous one that already expired", async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			checkout_session_id: "cs_test_previous",
		});
		stripe.setSession({ id: "cs_test_previous", status: "expired" });

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ url: CHECKOUT_URL });
		expect(stripeCalls()).toContain(
			"GET /v1/checkout/sessions/cs_test_previous",
		);
		expect(stripeCalls()).not.toContain(
			"POST /v1/checkout/sessions/cs_test_previous/expire",
		);
		expect(stripe.checkoutSessions()).toEqual([
			{ id: "cs_test_previous", status: "expired", customer: null },
			{ id: "cs_test_a1B2c3", status: "open", customer: null },
		]);
		expect(await storedSessionId()).toBe("cs_test_a1B2c3");
	});
});

describe("POST /checkout, for an account whose previous Checkout was paid with no webhook delivered", () => {
	beforeEach(async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
			checkout_session_id: "cs_test_paid",
		});
	});

	/** What a payment leaves in Stripe: the session complete, with the customer and the subscription it created. */
	function payTheSession(subscriptionStatus = "active"): void {
		stripe.setSession({
			id: "cs_test_paid",
			status: "complete",
			customer: "cus_new",
		});
		stripe.setCustomer("cus_new", "paid@example.com");
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: subscriptionStatus,
			plan: "pro_year",
			metadata: { github_user_id: "583231" },
		});
	}

	it.each(["active", "trialing", "past_due", "unpaid", "paused"])(
		"mirrors the session's customer in D1, creates no session and answers 409 when its subscription is %s",
		async (status) => {
			payTheSession(status);

			const response = await checkoutPlan("pro_monthly");

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "Already subscribed" });
			expect(stripe.sessions).toEqual([]);
			expect(await databaseContents()).toEqual({
				accounts: [
					expect.objectContaining({
						github_user_id: 583231,
						stripe_customer_id: "cus_new",
						billing_email: "paid@example.com",
						checkout_session_id: "cs_test_paid",
					}),
				],
				subscriptions: [
					{
						github_user_id: 583231,
						stripe_subscription_id: "sub_new",
						status,
						plan: "pro_year",
						current_period_end: "2026-12-14T12:00:00.000Z",
						cancel_at_period_end: 0,
						updated_at: expect.any(String),
					},
				],
			});
		},
	);

	it("does the same when the payment lands after the session was read, and Stripe refuses to expire it", async () => {
		stripe.setSession({ id: "cs_test_paid", status: "open" });
		stripe.beforeNextAnswer("/v1/checkout/sessions/cs_test_paid", async () =>
			payTheSession(),
		);

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "Already subscribed" });
		expect(stripeCalls()).toContain(
			"POST /v1/checkout/sessions/cs_test_paid/expire",
		);
		expect(stripe.sessions).toEqual([]);
		expect(stripe.checkoutSessions()).toEqual([
			{ id: "cs_test_paid", status: "complete", customer: "cus_new" },
		]);
		expect(await databaseContents()).toMatchObject({
			accounts: [{ stripe_customer_id: "cus_new" }],
			subscriptions: [{ stripe_subscription_id: "sub_new", status: "active" }],
		});
	});

	it.each(["canceled", "incomplete_expired"])(
		"mirrors the session's customer and opens a new Checkout for that customer when its subscription is %s",
		async (status) => {
			payTheSession(status);

			const response = await checkoutPlan("pro_monthly");

			expect(response.status).toBe(200);
			// A returning customer by now: named on the session, no e-mail added.
			expect(await response.json()).toEqual({ url: CHECKOUT_URL });
			expect(stripe.sessions).toHaveLength(1);
			expect(stripe.sessions[0]?.get("customer")).toBe("cus_new");
			expect(await databaseContents()).toMatchObject({
				accounts: [
					{
						stripe_customer_id: "cus_new",
						billing_email: "paid@example.com",
						checkout_session_id: "cs_test_a1B2c3",
					},
				],
				subscriptions: [{ stripe_subscription_id: "sub_new", status }],
			});
		},
	);

	it("creates no session, keeps D1 as it was and answers the logged 500 when the session's customer matches no account", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		payTheSession();
		// The stamp that leads the sync to the account is gone from Stripe.
		stripe.setSubscription({
			id: "sub_new",
			customer: "cus_new",
			status: "active",
			plan: "pro_year",
			metadata: {},
		});
		const before = await databaseContents();

		const response = await checkoutPlan("pro_monthly");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
		expect(logged).toHaveBeenCalled();
		expect(stripe.sessions).toEqual([]);
		expect(await databaseContents()).toEqual(before);
	});
});

describe("POST /checkout, when two requests of the same account overlap", () => {
	type Answer = { status: number; url: string };

	// Read where the response arrives: workerd lets no other request's
	// context read its body, and the overlapping one arrives inside the first.
	async function answerOf(response: Response): Promise<Answer> {
		return { status: response.status, url: await answeredUrl(response) };
	}

	/** One session is left open, the account stores it, and every answer leads to it. */
	async function expectOneCheckout(answers: Answer[]): Promise<void> {
		const open = stripe
			.checkoutSessions()
			.filter(({ status }) => status === "open");
		expect(open).toHaveLength(1);
		const winner = open[0]?.id ?? "";
		expect(await storedSessionId()).toBe(winner);
		expect(answers).toEqual([
			{ status: 200, url: checkoutUrl(winner) },
			{ status: 200, url: checkoutUrl(winner) },
		]);
	}

	it("leaves one of their two sessions open, stores it and answers its URL to both", async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			github_email: "octocat@github.com",
		});
		const overlapping: Answer[] = [];
		// The second request runs whole while Stripe creates the first one's session.
		stripe.beforeNextAnswer("/v1/checkout/sessions", async () => {
			overlapping.push(await answerOf(await checkoutPlan("pro_monthly")));
		});

		const answer = await answerOf(await checkoutPlan("pro_monthly"));

		expect(stripe.checkoutSessions()).toHaveLength(2);
		await expectOneCheckout([answer, ...overlapping]);
	});

	it("does the same when both find the account's previous Checkout open", async () => {
		await insertAccount({
			github_user_id: 583231,
			github_login: "octocat",
			checkout_session_id: "cs_test_previous",
		});
		stripe.setSession({ id: "cs_test_previous", status: "open" });
		const overlapping: Answer[] = [];
		// The second request runs whole while the first one reads the session.
		stripe.beforeNextAnswer(
			"/v1/checkout/sessions/cs_test_previous",
			async () => {
				overlapping.push(await answerOf(await checkoutPlan("pro_year")));
			},
		);

		const answer = await answerOf(await checkoutPlan("pro_monthly"));

		expect(stripe.checkoutSessions()).toHaveLength(3);
		expect(stripe.checkoutSessions()[0]).toMatchObject({
			id: "cs_test_previous",
			status: "expired",
		});
		await expectOneCheckout([answer, ...overlapping]);
	});
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

describe("POST /checkout when Stripe fails before the new session", () => {
	const cases: [string, () => Promise<void>][] = [
		[
			"reads the stored session",
			async () => {
				await insertAccount({
					github_user_id: 583231,
					github_login: "octocat",
					checkout_session_id: "cs_test_previous",
				});
				stripe.setSession({ id: "cs_test_previous", status: "open" });
				stripe.failRequestsTo("/v1/checkout/sessions/cs_test_previous");
			},
		],
		[
			"expires the stored session",
			async () => {
				await insertAccount({
					github_user_id: 583231,
					github_login: "octocat",
					checkout_session_id: "cs_test_previous",
				});
				stripe.setSession({ id: "cs_test_previous", status: "open" });
				stripe.failRequestsTo("/v1/checkout/sessions/cs_test_previous/expire");
			},
		],
		[
			"syncs the customer of a paid session",
			async () => {
				await insertAccount({
					github_user_id: 583231,
					github_login: "octocat",
					checkout_session_id: "cs_test_previous",
				});
				stripe.setSession({
					id: "cs_test_previous",
					status: "complete",
					customer: "cus_new",
				});
				stripe.setCustomer("cus_new", "paid@example.com");
				stripe.setSubscription({
					id: "sub_new",
					customer: "cus_new",
					status: "active",
					metadata: { github_user_id: "583231" },
				});
				stripe.failRequestsTo("/v1/subscriptions");
			},
		],
		[
			"syncs the customer the account stores",
			async () => {
				await insertAccount({
					github_user_id: 583231,
					github_login: "octocat",
					stripe_customer_id: "cus_octocat",
				});
				stripe.setCustomer("cus_octocat", "billing@example.com");
				stripe.failRequestsTo("/v1/customers/cus_octocat");
			},
		],
	];

	it.each(cases)(
		"creates no session, keeps D1 as it was and answers the logged 500 when the failure comes as it %s",
		async (_case, arrange) => {
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			await arrange();
			const before = await databaseContents();

			const response = await checkoutPlan("pro_monthly");

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: "Internal Server Error" });
			expect(logged).toHaveBeenCalled();
			expect(stripeCalls()).not.toContain("POST /v1/checkout/sessions");
			expect(await databaseContents()).toEqual(before);
		},
	);
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
