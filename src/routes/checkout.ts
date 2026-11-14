import { Hono } from "hono";
import { findAccount, LIVE_STATUSES } from "../accounts";
import { type AuthenticatedEnv, requireGitHubUser } from "../github";
import { stripeClient } from "../stripe";

// The plans Octo sells. Each is the lookup key of its price in Stripe, so no
// price id, sandbox or live, lives in the repository.
const PLANS = ["pro_monthly", "pro_year"];

const checkout = new Hono<AuthenticatedEnv>();

checkout.use(requireGitHubUser);

checkout.post("/", async (c) => {
	const body: unknown = await c.req.json().catch(() => null);
	const plan =
		typeof body === "object" && body !== null && "plan" in body
			? body.plan
			: undefined;
	if (typeof plan !== "string" || !PLANS.includes(plan)) {
		return c.json({ error: "Invalid plan" }, 400);
	}

	const account = await findAccount(c.env.DB, c.var.githubUser.id);
	if (!account) return c.json({ error: "Account not found" }, 404);
	if (
		account.subscription &&
		LIVE_STATUSES.includes(account.subscription.status)
	) {
		return c.json({ error: "Already subscribed" }, 409);
	}

	const stripe = stripeClient(c.env);
	const prices = await stripe.prices.list({
		lookup_keys: [plan],
		active: true,
		limit: 1,
	});
	const price = prices.data[0];
	if (!price) throw new Error(`Stripe has no active price for ${plan}`);

	// The GitHub user id on the subscription is how the webhook finds the
	// account of a first payment, whatever the order of the events. The session
	// lists no payment methods: the Stripe Dashboard decides them.
	const githubUserId = String(account.githubUserId);
	const session = await stripe.checkout.sessions.create({
		mode: "subscription",
		line_items: [{ price: price.id, quantity: 1 }],
		client_reference_id: githubUserId,
		subscription_data: { metadata: { github_user_id: githubUserId } },
		success_url: c.env.CHECKOUT_SUCCESS_URL,
		cancel_url: c.env.CHECKOUT_CANCEL_URL,
		// A returning customer stays one customer in Stripe. A first purchase
		// names none: Checkout creates it, and the API never does.
		...(account.stripeCustomerId && { customer: account.stripeCustomerId }),
	});
	if (!session.url) throw new Error("Stripe returned a session with no URL");

	// Best effort: on a first purchase the e-mail field arrives filled in and
	// stays editable, which `customer_email` would lock.
	if (account.stripeCustomerId || !account.githubEmail) {
		return c.json({ url: session.url });
	}
	const url = new URL(session.url);
	url.searchParams.set("prefilled_email", account.githubEmail);
	return c.json({ url: url.href });
});

export default checkout;
