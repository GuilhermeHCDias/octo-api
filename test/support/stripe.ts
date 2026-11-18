import { env } from "cloudflare:workers";
import type { FakeService, RecordedRequest } from "./network";

export type FakeSubscription = {
	id: string;
	customer: string;
	status: string;
	// Seconds since the epoch, as Stripe sends them.
	created: number;
	current_period_end: number;
	cancel_at_period_end: boolean;
	// Seconds since the epoch: the date of a scheduled cancellation, or null.
	cancel_at: number | null;
	// The lookup key of the subscription's price.
	plan: string | null;
	metadata: Record<string, string>;
};

export type FakeSession = {
	id: string;
	status: "open" | "complete" | "expired";
	// The customer the session names, or the one its payment created.
	customer: string | null;
};

const PRICES = [
	{ id: "price_monthly_123", lookup_key: "pro_monthly" },
	{ id: "price_year_456", lookup_key: "pro_year" },
];

const FIRST_SESSION_ID = "cs_test_a1B2c3";

/** The URL of a session's page. It carries a fragment, as Stripe's do. */
export function checkoutUrl(sessionId: string): string {
	return `https://checkout.stripe.com/c/pay/${sessionId}#fidkdWxOYHwnPyd1blpxYHZxWjA0`;
}

/** The URL of the first session a fake creates. */
export const CHECKOUT_URL = checkoutUrl(FIRST_SESSION_ID);

function list(data: unknown[]) {
	return { object: "list", data, has_more: false };
}

function subscriptionObject(subscription: FakeSubscription) {
	return {
		id: subscription.id,
		object: "subscription",
		customer: subscription.customer,
		status: subscription.status,
		created: subscription.created,
		cancel_at_period_end: subscription.cancel_at_period_end,
		cancel_at: subscription.cancel_at,
		metadata: subscription.metadata,
		items: list([
			{
				id: `si_${subscription.id}`,
				object: "subscription_item",
				current_period_end: subscription.current_period_end,
				price: {
					id: `price_of_${subscription.id}`,
					object: "price",
					lookup_key: subscription.plan,
				},
			},
		]),
	};
}

function sessionObject(session: FakeSession) {
	return {
		id: session.id,
		object: "checkout.session",
		mode: "subscription",
		status: session.status,
		customer: session.customer,
		// As Stripe: only an open session has a page.
		url: session.status === "open" ? checkoutUrl(session.id) : null,
	};
}

function stripeError(status: number, type: string, message: string): Response {
	return Response.json(
		{ error: { type, message } },
		// Tells the SDK not to retry, so a failing test does not wait on it.
		{ status, headers: { "stripe-should-retry": "false" } },
	);
}

/**
 * Stripe's API as the Worker uses it: prices by lookup key, Checkout
 * Sessions (created, read and expired), customers and their subscriptions.
 * The tests set its state, the "current state in Stripe", and read the
 * sessions it was asked to create.
 */
export function fakeStripe() {
	const customers = new Map<
		string,
		{ id: string; email: string | null } | { id: string; deleted: true }
	>();
	const interludes = new Map<string, () => Promise<void>>();
	const subscriptions = new Map<string, FakeSubscription>();
	const requests: RecordedRequest[] = [];
	const sessions: URLSearchParams[] = [];
	const checkoutSessions = new Map<string, FakeSession>();
	const failingPaths = new Set<string>();
	let outage = false;

	function listSubscriptions(query: URLSearchParams): Response {
		const status = query.get("status");
		const data = [...subscriptions.values()]
			.filter(({ customer }) => customer === query.get("customer"))
			// As Stripe: without `status`, canceled subscriptions are left out.
			.filter((subscription) =>
				status === "all"
					? true
					: status
						? subscription.status === status
						: subscription.status !== "canceled",
			)
			.sort((a, b) => b.created - a.created)
			.map(subscriptionObject);
		return Response.json(list(data));
	}

	function answer(request: RecordedRequest): Response {
		requests.push(request);
		if (outage || failingPaths.has(request.url.pathname)) {
			return stripeError(500, "api_error", "Stripe is down");
		}
		if (
			request.headers.get("authorization") !== `Bearer ${env.STRIPE_SECRET_KEY}`
		) {
			return stripeError(401, "invalid_request_error", "Invalid API Key");
		}

		const { pathname, searchParams } = request.url;
		const route = `${request.method} ${pathname}`;

		if (route === "GET /v1/prices") {
			const keys = [...searchParams]
				.filter(([name]) => name.startsWith("lookup_keys"))
				.map(([, value]) => value);
			const data = PRICES.filter(({ lookup_key }) =>
				keys.includes(lookup_key),
			).map((price) => ({ object: "price", ...price }));
			return Response.json(list(data));
		}

		if (route === "POST /v1/checkout/sessions") {
			const params = new URLSearchParams(request.body);
			sessions.push(params);
			const session: FakeSession = {
				id:
					sessions.length === 1
						? FIRST_SESSION_ID
						: `cs_test_number${sessions.length}`,
				status: "open",
				customer: params.get("customer"),
			};
			checkoutSessions.set(session.id, session);
			return Response.json(sessionObject(session));
		}

		const session = pathname.match(
			/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/,
		);
		if (session) {
			const found = checkoutSessions.get(session[1] ?? "");
			if (!found) {
				return stripeError(
					404,
					"invalid_request_error",
					"No such checkout.session",
				);
			}
			if (request.method === "GET" && !session[2]) {
				return Response.json(sessionObject(found));
			}
			if (request.method === "POST" && session[2]) {
				// As Stripe: only an open session can be expired.
				if (found.status !== "open") {
					return stripeError(
						400,
						"invalid_request_error",
						`Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of ${found.status}.`,
					);
				}
				const expired: FakeSession = { ...found, status: "expired" };
				checkoutSessions.set(expired.id, expired);
				return Response.json(sessionObject(expired));
			}
		}

		if (route === "GET /v1/subscriptions") {
			return listSubscriptions(searchParams);
		}

		const customer = pathname.match(/^\/v1\/customers\/([^/]+)$/);
		if (request.method === "GET" && customer) {
			const found = customers.get(customer[1] ?? "");
			return found
				? Response.json({ object: "customer", ...found })
				: stripeError(404, "invalid_request_error", "No such customer");
		}

		return stripeError(404, "invalid_request_error", `No route ${route}`);
	}

	return {
		host: "api.stripe.com",
		requests,
		/** The parameters of every Checkout Session the Worker created. */
		sessions,

		/**
		 * Adds the session, or replaces the one with the same id: a session
		 * opened earlier, or the state a payment or the passing of time left
		 * one in.
		 */
		setSession(
			session: Pick<FakeSession, "id" | "status"> & Partial<FakeSession>,
		): void {
			checkoutSessions.set(session.id, { customer: null, ...session });
		},

		/** Every Checkout Session Stripe holds, in the state it is in now. */
		checkoutSessions(): FakeSession[] {
			return [...checkoutSessions.values()];
		},

		setCustomer(id: string, email: string | null): void {
			customers.set(id, { id, email });
		},

		/** Adds the subscription, or replaces the one with the same id. */
		setSubscription(
			subscription: Pick<FakeSubscription, "id" | "customer" | "status"> &
				Partial<FakeSubscription>,
		): void {
			subscriptions.set(subscription.id, {
				created: 1_794_000_000,
				current_period_end: 1_797_249_600, // 2026-12-14T12:00:00Z
				cancel_at_period_end: false,
				cancel_at: null,
				plan: "pro_monthly",
				metadata: {},
				...subscription,
			});
		},

		/**
		 * Deletes the customer, as the Dashboard does: Stripe still answers a
		 * retrieve, with `deleted: true` and nothing else about the customer.
		 */
		deleteCustomer(id: string): void {
			customers.set(id, { id, deleted: true });
		},

		/**
		 * Makes the answer to the next request for `pathname` a slow one: Stripe
		 * reads its state when the request arrives, `meanwhile` runs, and only
		 * then does the answer, stale by now, reach the Worker.
		 */
		beforeNextAnswer(pathname: string, meanwhile: () => Promise<void>): void {
			interludes.set(pathname, meanwhile);
		},

		/** Makes every later request fail with a 500. */
		goDown(): void {
			outage = true;
		},

		/** Makes every later request for `pathname`, and no other, fail with a 500. */
		failRequestsTo(pathname: string): void {
			failingPaths.add(pathname);
		},

		handle(request: RecordedRequest): Response | Promise<Response> {
			const response = answer(request);
			const meanwhile = interludes.get(request.url.pathname);
			if (!meanwhile) return response;
			interludes.delete(request.url.pathname);
			return meanwhile().then(() => response);
		},
	} satisfies FakeService & Record<string, unknown>;
}

/**
 * The `Stripe-Signature` header Stripe sends with `payload`: a timestamp and
 * the HMAC-SHA256 of "<timestamp>.<payload>" under the endpoint's secret.
 */
export async function stripeSignature(
	payload: string,
	{
		secret = env.STRIPE_WEBHOOK_SECRET,
		timestamp = Math.floor(Date.now() / 1000),
	}: { secret?: string; timestamp?: number } = {},
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${timestamp}.${payload}`),
	);
	const hex = [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `t=${timestamp},v1=${hex}`;
}

let eventCount = 0;

/** The body of a snapshot event, as Stripe posts it to a webhook. */
export function stripeEvent(type: string, object: Record<string, unknown>) {
	eventCount += 1;
	return JSON.stringify({
		id: `evt_test_${eventCount}`,
		object: "event",
		api_version: "2026-10-28.endive",
		created: Math.floor(Date.now() / 1000),
		type,
		data: { object },
	});
}
