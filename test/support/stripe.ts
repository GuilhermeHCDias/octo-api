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
	// The lookup key of the subscription's price.
	plan: string | null;
	metadata: Record<string, string>;
};

const PRICES = [
	{ id: "price_monthly_123", lookup_key: "pro_monthly" },
	{ id: "price_year_456", lookup_key: "pro_year" },
];

// A Checkout URL carries a fragment, as Stripe's do.
export const CHECKOUT_URL =
	"https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0";

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

function stripeError(status: number, type: string, message: string): Response {
	return Response.json(
		{ error: { type, message } },
		// Tells the SDK not to retry, so a failing test does not wait on it.
		{ status, headers: { "stripe-should-retry": "false" } },
	);
}

/**
 * Stripe's API as the Worker uses it: prices by lookup key, Checkout
 * Sessions, customers and their subscriptions. The tests set its state, the
 * "current state in Stripe", and read the sessions it was asked to create.
 */
export function fakeStripe() {
	const customers = new Map<string, { id: string; email: string | null }>();
	const subscriptions = new Map<string, FakeSubscription>();
	const requests: RecordedRequest[] = [];
	const sessions: URLSearchParams[] = [];
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

	return {
		host: "api.stripe.com",
		requests,
		/** The parameters of every Checkout Session the Worker created. */
		sessions,

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
				plan: "pro_monthly",
				metadata: {},
				...subscription,
			});
		},

		/** Makes every later request fail with a 500. */
		goDown(): void {
			outage = true;
		},

		handle(request: RecordedRequest): Response {
			requests.push(request);
			if (outage) {
				return stripeError(500, "api_error", "Stripe is down");
			}
			if (
				request.headers.get("authorization") !==
				`Bearer ${env.STRIPE_SECRET_KEY}`
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
				return Response.json({
					id: "cs_test_a1B2c3",
					object: "checkout.session",
					mode: params.get("mode"),
					url: CHECKOUT_URL,
				});
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
