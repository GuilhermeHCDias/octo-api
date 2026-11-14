import type Stripe from "stripe";
import { LIVE_STATUSES } from "./accounts";

/**
 * The subscription the account's row mirrors: the live one, or the most
 * recently created when none is live. A customer who cancels and subscribes
 * again has two in Stripe, and the account has one row.
 */
function currentSubscription(
	subscriptions: Stripe.Subscription[],
): Stripe.Subscription | undefined {
	const newestFirst = subscriptions.toSorted((a, b) => b.created - a.created);
	return (
		newestFirst.find(({ status }) => LIVE_STATUSES.includes(status)) ??
		newestFirst[0]
	);
}

/**
 * The account a customer belongs to: the one that stores the customer id, or
 * else the one whose GitHub user id Checkout stamped on a subscription.
 */
async function findGitHubUserId(
	db: D1Database,
	customerId: string,
	subscriptions: Stripe.Subscription[],
): Promise<number | null> {
	const stored = await db
		.prepare("SELECT github_user_id FROM accounts WHERE stripe_customer_id = ?")
		.bind(customerId)
		.first<number>("github_user_id");
	if (stored !== null) return stored;

	const stamp = subscriptions
		.map(({ metadata }) => metadata.github_user_id)
		.find((value) => value !== undefined);
	if (!stamp || !/^\d+$/.test(stamp)) return null;
	return db
		.prepare("SELECT github_user_id FROM accounts WHERE github_user_id = ?")
		.bind(Number(stamp))
		.first<number>("github_user_id");
}

/**
 * Makes D1 mirror what Stripe has now for one customer. Everything is fetched
 * from Stripe at this moment, never taken from an event, so duplicated and
 * out-of-order deliveries all end in the same rows. Every read happens before
 * the one atomic write: a failure changes nothing.
 *
 * Returns false when the customer matches no account.
 */
export async function syncCustomer(
	db: D1Database,
	stripe: Stripe,
	customerId: string,
): Promise<boolean> {
	const [customer, subscriptions] = await Promise.all([
		stripe.customers.retrieve(customerId),
		// `all` includes the canceled ones, which Stripe leaves out by default.
		stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: 100,
		}),
	]);

	const githubUserId = await findGitHubUserId(
		db,
		customerId,
		subscriptions.data,
	);
	if (githubUserId === null) return false;

	const now = new Date().toISOString();
	const current = currentSubscription(subscriptions.data);
	// A subscription's period lives on its items; Octo's has one item.
	const item = current?.items.data[0];

	await db.batch([
		db
			.prepare(
				"UPDATE accounts SET stripe_customer_id = ?, billing_email = ?, updated_at = ? WHERE github_user_id = ?",
			)
			.bind(
				customerId,
				customer.deleted ? null : customer.email,
				now,
				githubUserId,
			),
		current && item
			? db
					.prepare(
						`INSERT OR REPLACE INTO subscriptions
							(github_user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						githubUserId,
						current.id,
						current.status,
						item.price.lookup_key,
						new Date(item.current_period_end * 1000).toISOString(),
						current.cancel_at_period_end ? 1 : 0,
						now,
					)
			: db
					.prepare("DELETE FROM subscriptions WHERE github_user_id = ?")
					.bind(githubUserId),
	]);
	return true;
}
