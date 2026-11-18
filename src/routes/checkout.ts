import { Hono } from "hono";
import Stripe from "stripe";
import { type Account, findAccount, LIVE_STATUSES } from "../accounts";
import { type AuthenticatedEnv, requireGitHubUser } from "../github";
import { stripeClient } from "../stripe";
import { syncCustomer } from "../sync";

// The plans Octo sells. Each is the lookup key of its price in Stripe, so no
// price id, sandbox or live, lives in the repository.
const PLANS = ["pro_monthly", "pro_year"];

function hasLiveSubscription({ subscription }: Account): boolean {
	return subscription !== null && LIVE_STATUSES.includes(subscription.status);
}

/**
 * Closes the Checkout Session the account opened before, so that it can no
 * longer be paid: an open one is expired. Returns the customer of a session
 * that was paid instead, and null for one that expired unpaid. Any failure
 * throws: the caller opens no new session unless this one is known closed.
 */
async function settleSession(
	stripe: Stripe,
	sessionId: string,
): Promise<string | null> {
	let session = await stripe.checkout.sessions.retrieve(sessionId);
	if (session.status === "open") {
		try {
			await stripe.checkout.sessions.expire(sessionId);
			return null;
		} catch (error) {
			// Stripe refuses to expire a session that is no longer open: it was
			// paid, or expired, after the read. Reading it again tells which.
			if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) {
				throw error;
			}
			session = await stripe.checkout.sessions.retrieve(sessionId);
		}
	}
	if (session.status === "expired") return null;
	if (session.status !== "complete") {
		throw new Error(
			`Checkout Session ${sessionId} is ${session.status} and cannot be settled`,
		);
	}

	const customerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer?.id;
	if (!customerId) {
		throw new Error(
			`Checkout Session ${sessionId} is complete with no customer`,
		);
	}
	return customerId;
}

/**
 * Makes D1 mirror Stripe for the customer, then reads the account again. A
 * customer that matches no account throws: nothing was mirrored, so the row
 * cannot say whether the account pays.
 */
async function syncedAccount(
	db: D1Database,
	stripe: Stripe,
	customerId: string,
	githubUserId: number,
): Promise<Account> {
	const matched = await syncCustomer(db, stripe, customerId);
	if (!matched) {
		throw new Error(
			`Stripe customer ${customerId} of account ${githubUserId} matches no account`,
		);
	}
	const account = await findAccount(db, githubUserId);
	if (!account) {
		throw new Error(`Account ${githubUserId} is missing right after its sync`);
	}
	return account;
}

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

	let account = await findAccount(c.env.DB, c.var.githubUser.id);
	if (!account) return c.json({ error: "Account not found" }, 404);
	// A live row refuses with no call to Stripe. A stale one can only delay a
	// new Checkout until the webhook arrives, never allow a second payment.
	if (hasLiveSubscription(account)) {
		return c.json({ error: "Already subscribed" }, 409);
	}

	const stripe = stripeClient(c.env);

	// One payable Checkout per account: the previous session is closed before
	// another opens. A paid one means a subscription the webhook may not have
	// delivered yet, so Stripe is asked, not D1, whether the account pays.
	const previousSessionId = account.checkoutSessionId;
	const payingCustomerId = previousSessionId
		? await settleSession(stripe, previousSessionId)
		: null;
	if (payingCustomerId) {
		account = await syncedAccount(
			c.env.DB,
			stripe,
			payingCustomerId,
			account.githubUserId,
		);
		if (hasLiveSubscription(account)) {
			return c.json({ error: "Already subscribed" }, 409);
		}
	}
	// The same question for the customer the account stores, unless the sync
	// above has just answered it.
	if (
		account.stripeCustomerId &&
		account.stripeCustomerId !== payingCustomerId
	) {
		account = await syncedAccount(
			c.env.DB,
			stripe,
			account.stripeCustomerId,
			account.githubUserId,
		);
		if (hasLiveSubscription(account)) {
			return c.json({ error: "Already subscribed" }, 409);
		}
	}

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

	// The account's row is where the one Checkout is claimed. The claim holds
	// only if the row still names the session settled above: an overlapping
	// request that stored its own session first keeps it, and this one loses.
	const claim = await c.env.DB.prepare(
		`UPDATE accounts SET checkout_session_id = ?1
		WHERE github_user_id = ?2 AND checkout_session_id IS ?3`,
	)
		.bind(session.id, account.githubUserId, previousSessionId)
		.run();
	let checkoutUrl = session.url;
	if (claim.meta.changes === 0) {
		// The loser closes its own session, which nobody has seen, and answers
		// the winner's: a double click leads both answers to the one Checkout.
		await stripe.checkout.sessions.expire(session.id);
		const winnerId = await c.env.DB.prepare(
			"SELECT checkout_session_id FROM accounts WHERE github_user_id = ?",
		)
			.bind(account.githubUserId)
			.first<string>("checkout_session_id");
		const winner = winnerId
			? await stripe.checkout.sessions.retrieve(winnerId)
			: null;
		if (winner?.status !== "open" || !winner.url) {
			throw new Error(
				`Account ${account.githubUserId} lost its Checkout to a session that is not open`,
			);
		}
		checkoutUrl = winner.url;
	}

	// Best effort: on a first purchase the e-mail field arrives filled in and
	// stays editable, which `customer_email` would lock.
	if (account.stripeCustomerId || !account.githubEmail) {
		return c.json({ url: checkoutUrl });
	}
	const url = new URL(checkoutUrl);
	url.searchParams.set("prefilled_email", account.githubEmail);
	return c.json({ url: url.href });
});

export default checkout;
