/** Statuses that give access: `past_due` keeps it while Stripe retries. */
const ACCESS_STATUSES = ["active", "trialing", "past_due"];

/** Statuses of a subscription that still exists and may charge again. */
export const LIVE_STATUSES = [...ACCESS_STATUSES, "unpaid", "paused"];

/** A user with its side of Stripe: what `billing` and `subscriptions` hold. */
export type Account = {
	userId: string;
	email: string;
	name: string;
	stripeCustomerId: string | null;
	/** The last Checkout Session the API opened for the user. */
	checkoutSessionId: string | null;
	subscription: {
		status: string;
		plan: string | null;
		currentPeriodEnd: string;
		cancelAtPeriodEnd: boolean;
	} | null;
};

type AccountRow = {
	id: string;
	email: string;
	name: string;
	stripe_customer_id: string | null;
	checkout_session_id: string | null;
	status: string | null;
	plan: string | null;
	current_period_end: string | null;
	cancel_at_period_end: number | null;
};

/**
 * The account of a user, or null when there is no such user. A user who
 * never opened a Checkout has no billing row: the account then has no
 * customer, no previous Checkout and no subscription. Only reads.
 */
export async function findAccount(
	db: D1Database,
	userId: string,
): Promise<Account | null> {
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.name, b.stripe_customer_id, b.checkout_session_id,
				s.status, s.plan, s.current_period_end, s.cancel_at_period_end
			FROM "user" u
				LEFT JOIN billing b ON b.user_id = u.id
				LEFT JOIN subscriptions s ON s.user_id = u.id
			WHERE u.id = ?`,
		)
		.bind(userId)
		.first<AccountRow>();
	if (!row) return null;

	return {
		userId: row.id,
		email: row.email,
		name: row.name,
		stripeCustomerId: row.stripe_customer_id,
		checkoutSessionId: row.checkout_session_id,
		subscription:
			row.status === null || row.current_period_end === null
				? null
				: {
						status: row.status,
						plan: row.plan,
						currentPeriodEnd: row.current_period_end,
						cancelAtPeriodEnd: row.cancel_at_period_end === 1,
					},
	};
}

/** The body of `GET /account`: what the Octo app reads. */
export function accountBody(account: Account) {
	const { subscription } = account;
	return {
		user_id: account.userId,
		email: account.email,
		name: account.name,
		access:
			subscription !== null && ACCESS_STATUSES.includes(subscription.status),
		subscription: subscription && {
			status: subscription.status,
			plan: subscription.plan,
			current_period_end: subscription.currentPeriodEnd,
			cancel_at_period_end: subscription.cancelAtPeriodEnd,
		},
	};
}
