import { env } from "cloudflare:workers";

export type AccountRow = {
	github_user_id: number;
	github_login: string;
	github_email: string | null;
	stripe_customer_id: string | null;
	billing_email: string | null;
	created_at: string;
	updated_at: string;
	checkout_session_id: string | null;
};

export type SubscriptionRow = {
	github_user_id: number;
	stripe_subscription_id: string;
	status: string;
	plan: string | null;
	current_period_end: string;
	cancel_at_period_end: number;
	updated_at: string;
};

const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** Empties both tables: the tests of a file share one database. */
export async function emptyDatabase(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM subscriptions"),
		env.DB.prepare("DELETE FROM accounts"),
	]);
}

export async function insertAccount(
	account: Pick<AccountRow, "github_user_id" | "github_login"> &
		Partial<AccountRow>,
): Promise<void> {
	const row: AccountRow = {
		github_email: null,
		stripe_customer_id: null,
		billing_email: null,
		created_at: LONG_AGO,
		updated_at: LONG_AGO,
		checkout_session_id: null,
		...account,
	};
	await env.DB.prepare(
		"INSERT INTO accounts (github_user_id, github_login, github_email, stripe_customer_id, billing_email, created_at, updated_at, checkout_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			row.github_user_id,
			row.github_login,
			row.github_email,
			row.stripe_customer_id,
			row.billing_email,
			row.created_at,
			row.updated_at,
			row.checkout_session_id,
		)
		.run();
}

export async function insertSubscription(
	subscription: Pick<SubscriptionRow, "github_user_id" | "status"> &
		Partial<SubscriptionRow>,
): Promise<void> {
	const row: SubscriptionRow = {
		stripe_subscription_id: `sub_of_${subscription.github_user_id}`,
		plan: "pro_monthly",
		current_period_end: "2026-12-14T12:00:00.000Z",
		cancel_at_period_end: 0,
		updated_at: LONG_AGO,
		...subscription,
	};
	await env.DB.prepare(
		"INSERT INTO subscriptions (github_user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			row.github_user_id,
			row.stripe_subscription_id,
			row.status,
			row.plan,
			row.current_period_end,
			row.cancel_at_period_end,
			row.updated_at,
		)
		.run();
}

export async function allAccounts(): Promise<AccountRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM accounts ORDER BY github_user_id",
	).all<AccountRow>();
	return results;
}

export async function allSubscriptions(): Promise<SubscriptionRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM subscriptions ORDER BY github_user_id",
	).all<SubscriptionRow>();
	return results;
}

/** Every row of both tables, to assert that a request wrote nothing. */
export async function databaseContents() {
	return {
		accounts: await allAccounts(),
		subscriptions: await allSubscriptions(),
	};
}
