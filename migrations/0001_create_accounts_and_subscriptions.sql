-- An account is a GitHub identity, created at the first login. Stripe data
-- arrives later, from the webhook: the customer on the first payment.
CREATE TABLE accounts (
	github_user_id INTEGER PRIMARY KEY,
	github_login TEXT NOT NULL,
	github_email TEXT,
	stripe_customer_id TEXT UNIQUE,
	billing_email TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- At most one row per account, overwritten whole on every sync with Stripe.
-- Dates are ISO 8601 UTC text; cancel_at_period_end is 0 or 1; plan is the
-- price's lookup key, null when the price has none.
CREATE TABLE subscriptions (
	github_user_id INTEGER PRIMARY KEY REFERENCES accounts (github_user_id),
	stripe_subscription_id TEXT NOT NULL,
	status TEXT NOT NULL,
	plan TEXT,
	current_period_end TEXT NOT NULL,
	cancel_at_period_end INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
