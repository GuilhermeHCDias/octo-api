/** Statuses that give access: `past_due` keeps it while Stripe retries. */
const ACCESS_STATUSES = ["active", "trialing", "past_due"];

/** Statuses of a subscription that still exists and may charge again. */
export const LIVE_STATUSES = [...ACCESS_STATUSES, "unpaid", "paused"];

export type Account = {
	githubUserId: number;
	githubLogin: string;
	githubEmail: string | null;
	stripeCustomerId: string | null;
	subscription: {
		status: string;
		plan: string | null;
		currentPeriodEnd: string;
		cancelAtPeriodEnd: boolean;
	} | null;
};

type AccountRow = {
	github_user_id: number;
	github_login: string;
	github_email: string | null;
	stripe_customer_id: string | null;
	status: string | null;
	plan: string | null;
	current_period_end: string | null;
	cancel_at_period_end: number | null;
};

/** The account of a GitHub user with its subscription, or null. Only reads. */
export async function findAccount(
	db: D1Database,
	githubUserId: number,
): Promise<Account | null> {
	const row = await db
		.prepare(
			`SELECT a.github_user_id, a.github_login, a.github_email, a.stripe_customer_id,
				s.status, s.plan, s.current_period_end, s.cancel_at_period_end
			FROM accounts a LEFT JOIN subscriptions s USING (github_user_id)
			WHERE a.github_user_id = ?`,
		)
		.bind(githubUserId)
		.first<AccountRow>();
	if (!row) return null;

	return {
		githubUserId: row.github_user_id,
		githubLogin: row.github_login,
		githubEmail: row.github_email,
		stripeCustomerId: row.stripe_customer_id,
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
		github_user_id: account.githubUserId,
		github_login: account.githubLogin,
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
