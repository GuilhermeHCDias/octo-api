import Stripe from "stripe";

/**
 * A Stripe client for one request. Workers have no Node HTTP stack: the SDK
 * goes through `fetch`.
 */
export function stripeClient(env: CloudflareBindings): Stripe {
	return new Stripe(env.STRIPE_SECRET_KEY, {
		httpClient: Stripe.createFetchHttpClient(),
	});
}
