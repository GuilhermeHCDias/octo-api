-- The account stops being a GitHub identity. Better Auth keeps it from here
-- on, in four tables of its own; Octo's two are re-keyed on its user. The
-- rows that existed are dropped: the API had only run against Stripe's sandbox.
DROP TABLE subscriptions;
DROP TABLE accounts;

-- Better Auth's tables, with the names, columns and types it asks for on
-- SQLite: camelCase, dates as `date`, booleans as `integer`. Only Better Auth
-- writes them. test/schema.test.ts asks Better Auth whether anything is
-- missing: a new version or plugin that needs more gets a new migration.

-- The Octo account.
CREATE TABLE "user" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"name" TEXT NOT NULL,
	"email" TEXT NOT NULL UNIQUE,
	"emailVerified" INTEGER NOT NULL,
	"image" TEXT,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL
);

-- One row per sign-in. The API accepts the token only with its signature,
-- which is made with BETTER_AUTH_SECRET and stored nowhere.
CREATE TABLE "session" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"expiresAt" DATE NOT NULL,
	"token" TEXT NOT NULL UNIQUE,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL,
	"ipAddress" TEXT,
	"userAgent" TEXT,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

-- One row per provider (GitHub, Apple) a user signed in with. The API writes
-- the provider's tokens as null: after the sign-in it asks the provider nothing.
CREATE TABLE "account" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"providerId" TEXT NOT NULL,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"accessToken" TEXT,
	"refreshToken" TEXT,
	"idToken" TEXT,
	"accessTokenExpiresAt" DATE,
	"refreshTokenExpiresAt" DATE,
	"scope" TEXT,
	"password" TEXT,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL
);

-- Short-lived rows: the state of a sign-in in progress, and the single-use
-- code of a finished one, stored hashed.
CREATE TABLE "verification" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"identifier" TEXT NOT NULL,
	"value" TEXT NOT NULL,
	"expiresAt" DATE NOT NULL,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- A user's side of Stripe, created when first needed: by the first Checkout
-- or by the first sync of a payment. Dates are ISO 8601 UTC text.
-- checkout_session_id is the last Checkout Session the API opened for the
-- user, which only POST /checkout writes.
CREATE TABLE billing (
	user_id TEXT PRIMARY KEY REFERENCES "user" ("id"),
	stripe_customer_id TEXT UNIQUE,
	billing_email TEXT,
	checkout_session_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

-- At most one row per user, overwritten whole on every sync with Stripe.
-- cancel_at_period_end is 0 or 1; plan is the price's lookup key, null when
-- the price has none.
CREATE TABLE subscriptions (
	user_id TEXT PRIMARY KEY REFERENCES billing (user_id),
	stripe_subscription_id TEXT NOT NULL,
	status TEXT NOT NULL,
	plan TEXT,
	current_period_end TEXT NOT NULL,
	cancel_at_period_end INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
