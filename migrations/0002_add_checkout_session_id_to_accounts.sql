-- The last Checkout Session the API opened for the account, null until the
-- first one. POST /checkout settles it (expired, or paid and synced) before
-- it opens another, so an account never has two payable sessions. Only that
-- route writes it: the login and the sync with Stripe leave it alone.
ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;
