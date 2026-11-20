import { env } from "cloudflare:workers";

// Better Auth's rows, with its own column names.
export type UserRow = {
	id: string;
	name: string;
	email: string;
	emailVerified: number;
	image: string | null;
	createdAt: string;
	updatedAt: string;
};

export type SessionRow = {
	id: string;
	expiresAt: string;
	token: string;
	createdAt: string;
	updatedAt: string;
	ipAddress: string | null;
	userAgent: string | null;
	userId: string;
};

/** A row of `account`: the link of a user to a provider. */
export type ProviderAccountRow = {
	id: string;
	accountId: string;
	providerId: string;
	userId: string;
	accessToken: string | null;
	refreshToken: string | null;
	idToken: string | null;
	accessTokenExpiresAt: string | null;
	refreshTokenExpiresAt: string | null;
	scope: string | null;
	password: string | null;
	createdAt: string;
	updatedAt: string;
};

export type VerificationRow = {
	id: string;
	identifier: string;
	value: string;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
};

export type BillingRow = {
	user_id: string;
	stripe_customer_id: string | null;
	billing_email: string | null;
	checkout_session_id: string | null;
	created_at: string;
	updated_at: string;
};

export type SubscriptionRow = {
	user_id: string;
	stripe_subscription_id: string;
	status: string;
	plan: string | null;
	current_period_end: string;
	cancel_at_period_end: number;
	updated_at: string;
};

const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** Empties every table: the tests of a file share one database. */
export async function emptyDatabase(): Promise<void> {
	await env.DB.batch(
		[
			"subscriptions",
			"billing",
			"session",
			"account",
			"verification",
			'"user"',
		].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
	);
}

/** A user who never signed in: for the tests that need only the row. */
export async function insertUser(
	user: Pick<UserRow, "id"> & Partial<UserRow>,
): Promise<void> {
	const row: UserRow = {
		name: user.id,
		email: `${user.id}@example.com`,
		emailVerified: 1,
		image: null,
		createdAt: LONG_AGO,
		updatedAt: LONG_AGO,
		...user,
	};
	await env.DB.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(
			row.id,
			row.name,
			row.email,
			row.emailVerified,
			row.image,
			row.createdAt,
			row.updatedAt,
		)
		.run();
}

export async function insertBilling(
	billing: Pick<BillingRow, "user_id"> & Partial<BillingRow>,
): Promise<void> {
	const row: BillingRow = {
		stripe_customer_id: null,
		billing_email: null,
		checkout_session_id: null,
		created_at: LONG_AGO,
		updated_at: LONG_AGO,
		...billing,
	};
	await env.DB.prepare(
		"INSERT INTO billing (user_id, stripe_customer_id, billing_email, checkout_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			row.user_id,
			row.stripe_customer_id,
			row.billing_email,
			row.checkout_session_id,
			row.created_at,
			row.updated_at,
		)
		.run();
}

export async function insertSubscription(
	subscription: Pick<SubscriptionRow, "user_id" | "status"> &
		Partial<SubscriptionRow>,
): Promise<void> {
	const row: SubscriptionRow = {
		stripe_subscription_id: `sub_of_${subscription.user_id}`,
		plan: "pro_monthly",
		current_period_end: "2026-12-14T12:00:00.000Z",
		cancel_at_period_end: 0,
		updated_at: LONG_AGO,
		...subscription,
	};
	await env.DB.prepare(
		"INSERT INTO subscriptions (user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			row.user_id,
			row.stripe_subscription_id,
			row.status,
			row.plan,
			row.current_period_end,
			row.cancel_at_period_end,
			row.updated_at,
		)
		.run();
}

async function rowsOf<Row>(table: string, order: string): Promise<Row[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM ${table} ORDER BY ${order}`,
	).all<Row>();
	return results;
}

export function allUsers(): Promise<UserRow[]> {
	return rowsOf('"user"', "createdAt, id");
}

export function allSessions(): Promise<SessionRow[]> {
	return rowsOf("session", "createdAt, id");
}

export function allProviderAccounts(): Promise<ProviderAccountRow[]> {
	return rowsOf("account", "createdAt, id");
}

export function allVerifications(): Promise<VerificationRow[]> {
	return rowsOf("verification", "createdAt, id");
}

export function allBilling(): Promise<BillingRow[]> {
	return rowsOf("billing", "user_id");
}

export function allSubscriptions(): Promise<SubscriptionRow[]> {
	return rowsOf("subscriptions", "user_id");
}

/** Every row of every table, to assert that a request wrote nothing. */
export async function databaseContents() {
	return {
		users: await allUsers(),
		sessions: await allSessions(),
		providerAccounts: await allProviderAccounts(),
		verifications: await allVerifications(),
		billing: await allBilling(),
		subscriptions: await allSubscriptions(),
	};
}
