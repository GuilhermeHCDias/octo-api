import type Stripe from "stripe";
import { LIVE_STATUSES } from "./accounts";

/**
 * The subscription the user's row mirrors: the live one, or the most
 * recently created when none is live. A customer who cancels and subscribes
 * again has two in Stripe, and the user has one row.
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
 * The user a customer belongs to: the one whose billing row stores the
 * customer id, or else the one whose id Checkout stamped on a subscription.
 */
async function findUserId(
	db: D1Database,
	customerId: string,
	subscriptions: Stripe.Subscription[],
): Promise<string | null> {
	const stored = await db
		.prepare("SELECT user_id FROM billing WHERE stripe_customer_id = ?")
		.bind(customerId)
		.first<string>("user_id");
	if (stored !== null) return stored;

	const stamp = subscriptions
		.map(({ metadata }) => metadata.user_id)
		.find((value) => value !== undefined);
	if (!stamp) return null;
	return db
		.prepare('SELECT id FROM "user" WHERE id = ?')
		.bind(stamp)
		.first<string>("id");
}

/**
 * Makes D1 mirror what Stripe has now for one customer. Everything is fetched
 * from Stripe at this moment, never taken from an event, so duplicated and
 * out-of-order deliveries all end in the same rows. Every read happens before
 * the one atomic write: a failure changes nothing.
 *
 * Deliveries also overlap. The subscription row keeps the time its sync began
 * to fetch, and a sync that began earlier never overwrites it: its answer is
 * the older one, and whatever changed since has an event of its own.
 *
 * The user's billing row is created here when a first payment arrives for a
 * user who has none.
 *
 * Returns false when the customer matches no user.
 */
export async function syncCustomer(
	db: D1Database,
	stripe: Stripe,
	customerId: string,
): Promise<boolean> {
	const fetchedAt = new Date().toISOString();
	const [customer, subscriptions] = await Promise.all([
		stripe.customers.retrieve(customerId),
		// `all` includes the canceled ones, which Stripe leaves out by default.
		stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: 100,
		}),
	]);

	const userId = await findUserId(db, customerId, subscriptions.data);
	if (userId === null) return false;

	const current = currentSubscription(subscriptions.data);
	// A subscription's period lives on its items; Octo's has one item.
	const item = current?.items.data[0];

	await db.batch([
		db
			.prepare(
				`INSERT INTO billing (user_id, stripe_customer_id, billing_email, created_at, updated_at)
				VALUES (?4, ?1, ?2, ?3, ?3)
				ON CONFLICT (user_id) DO UPDATE SET
					stripe_customer_id = excluded.stripe_customer_id,
					billing_email = excluded.billing_email,
					updated_at = excluded.updated_at
				WHERE NOT EXISTS (
					SELECT 1 FROM subscriptions WHERE user_id = ?4 AND updated_at > ?5
				)`,
			)
			.bind(
				// Stripe refuses a new Checkout for a deleted customer: forgetting
				// it lets the next Checkout create another.
				customer.deleted ? null : customerId,
				customer.deleted ? null : customer.email,
				new Date().toISOString(),
				userId,
				fetchedAt,
			),
		current && item
			? db
					.prepare(
						`INSERT INTO subscriptions
							(user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (user_id) DO UPDATE SET
							stripe_subscription_id = excluded.stripe_subscription_id,
							status = excluded.status,
							plan = excluded.plan,
							current_period_end = excluded.current_period_end,
							cancel_at_period_end = excluded.cancel_at_period_end,
							updated_at = excluded.updated_at
						WHERE excluded.updated_at >= subscriptions.updated_at`,
					)
					.bind(
						userId,
						current.id,
						current.status,
						item.price.lookup_key,
						new Date(item.current_period_end * 1000).toISOString(),
						// Under flexible billing, the default of the pinned API
						// version, the customer portal schedules a cancellation
						// through `cancel_at` and leaves the flag false.
						current.cancel_at_period_end || current.cancel_at !== null ? 1 : 0,
						fetchedAt,
					)
			: db
					.prepare(
						"DELETE FROM subscriptions WHERE user_id = ? AND updated_at <= ?",
					)
					.bind(userId, fetchedAt),
	]);
	return true;
}
