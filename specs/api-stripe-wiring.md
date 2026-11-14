# Wire Stripe into the Octo API
status: done
created: 2026-11-14
type: feat
depends-on: none

## Goal
Make the Octo API the place where an Octo account pays and where its payment status is read.
An account is the user's GitHub identity, verified with GitHub and created at login; Stripe
takes the payment on a hosted Checkout; Stripe's webhooks keep the account's subscription
current in D1; and the API answers whether the account has access. The API does nothing else.
Done means a payment made in Stripe's sandbox shows up as the account's status in the API, and
a cancellation changes it, with no manual step.

## Context
- The scaffold is in place (`specs/scaffold-api-project.md`): a Hono app on Cloudflare Workers
  in `src/index.ts`, one Hono instance per resource under `src/routes/` mounted with
  `app.route()`, handlers written inline, bindings through `c.env` typed by
  `CloudflareBindings`. `src/index.ts` answers 404 as `{"error":"Not Found"}` and turns every
  thrown error into a logged 500 `{"error":"Internal Server Error"}`.
- `wrangler.jsonc` already declares the D1 binding `DB`, the R2 binding `BUCKET` and the
  required secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; nothing reads them yet.
  The `stripe` package is not a dependency, and there is no D1 schema, no migrations folder
  and no authentication.
- Tests run with Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`), against
  local D1. `vitest.config.ts` gives them placeholder secrets: the tests never read a local
  secrets file and never reach the network, so they fake Stripe's and GitHub's answers and
  sign their own webhook payloads with the placeholder webhook secret. After changing
  `wrangler.jsonc`, `pnpm cf-typegen` regenerates `worker-configuration.d.ts`, and
  `pnpm typecheck` fails when it is stale.
- The README's "Local secrets" section tells the reader to copy `.dev.vars.example`, a file
  the repository no longer has.
- Stripe facts that shape the design (docs read on 2026-11-14):
  - Webhooks: https://docs.stripe.com/webhooks. The signature in the `Stripe-Signature` header
    is checked against the raw request body, with a default tolerance of five minutes. Stripe
    retries a delivery that did not get a `2xx` for up to three days in live mode, may deliver
    the same event more than once, and does not guarantee the order of events.
  - Event formats: https://docs.stripe.com/events/how-events-work. A destination receives
    either snapshot events (the full object as it was, possibly stale when processed) or thin
    events (type and object id only). Stripe recommends fetching the latest object from the
    API before acting in both formats.
  - Subscriptions: https://docs.stripe.com/billing/subscriptions/webhooks. A subscription
    always belongs to a Stripe customer, and its activity reaches an integration only through
    events. Statuses: `trialing` and `active` are in good standing; `past_due` means a renewal
    failed and Stripe may retry; `canceled` and `unpaid` revoke access; `incomplete`,
    `incomplete_expired` and `paused` never had or no longer have a payment.
  - Checkout Sessions: https://docs.stripe.com/api/checkout/sessions/create. In subscription
    mode a session with no `customer` creates one. `customer_email`, and a customer that
    already has an e-mail, both lock the e-mail field. A session that lists no payment methods
    offers the ones enabled in the Stripe Dashboard.
  - Workers: the Stripe SDK verifies signatures there with the asynchronous
    `constructEventAsync` (Web Crypto), as in Hono's example
    https://hono.dev/examples/stripe-webhook, reading the body with `c.req.text()`.
- GitHub facts (docs read on 2026-11-14):
  - "Check a token": https://docs.github.com/en/rest/apps/oauth-applications.
    `POST /applications/{client_id}/token`, authenticated with the OAuth App's client id and
    client secret, answers 200 with the token's `user` (id and login) and `scopes` when the
    token was issued to that app, and 404 otherwise.
  - Scopes: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps.
    An OAuth App's access is limited by the scopes it requests at authorization. No scope gives
    read-only access to public information; `user:email` adds read access to the user's e-mail
    addresses, which `GET /user/emails` lists with their `primary` and `verified` flags.
  - GitHub's API rejects a request that has no `User-Agent` header.
- The test and run commands live in `.octo/project.md`.

## Acceptance criteria
- [x] C1. The repository shall hold D1 migrations that create the tables `accounts` and
  `subscriptions` with the fields listed under *Decisions & assumptions*, and on a fresh clone
  `pnpm test` and `pnpm dev` shall run against a local D1 that has both tables, with no manual
  step.
- [x] C2. When a request to `PUT /account`, `GET /account` or `POST /checkout` carries no
  `Authorization: Bearer` token, or one that GitHub's "check a token" does not recognize as
  issued to Octo's OAuth App, the system shall answer 401 with `{"error":"Unauthorized"}` and
  read or write nothing else; the token shall never be written to D1 or to a log.
- [x] C3. When `PUT /account` is called with a valid token, the system shall create the
  account with the GitHub user id, login and primary verified e-mail (null when GitHub returns
  none), or refresh the login and e-mail of the account that exists, without calling Stripe
  and without changing the account's Stripe data or subscription, and answer 200 with the body
  of `GET /account`.
- [x] C4. When `GET /account` is called with a valid token, the system shall answer 200 with
  `github_user_id`, `github_login`, `access` and `subscription` (null, or an object with
  `status`, `plan`, `current_period_end` in ISO 8601 UTC and `cancel_at_period_end`), read
  from D1 alone and changing nothing; `access` shall be true only when the subscription's
  status is `active`, `trialing` or `past_due`; when the user has no account it shall answer
  404 with `{"error":"Account not found"}`.
- [x] C5. When `POST /checkout` is called with a valid token and the body
  `{"plan":"pro_monthly"}` or `{"plan":"pro_year"}`, the system shall create a Stripe Checkout
  Session in subscription mode for the price with that lookup key, stamped with the GitHub
  user id on the session and on the subscription it creates, with the success and cancel URLs
  of the Worker's configuration and no list of payment methods, and answer 200 with
  `{"url":"<the Checkout URL>"}`. For an account with no Stripe customer the session names no
  customer and the URL carries `prefilled_email` with the account's GitHub e-mail when it has
  one; otherwise the session names the stored customer.
- [x] C6. `POST /checkout` shall create no session and answer 400 with
  `{"error":"Invalid plan"}` when the plan is missing or is neither of the two, 404 with
  `{"error":"Account not found"}` when the user has no account, and 409 with
  `{"error":"Already subscribed"}` when the account's subscription is live (status `active`,
  `trialing`, `past_due`, `unpaid` or `paused`).
- [x] C7. When `POST /webhooks/stripe` receives a request whose `Stripe-Signature` header is
  missing, does not match the raw body under `STRIPE_WEBHOOK_SECRET`, or is older than
  Stripe's five-minute tolerance, the system shall answer 400 and write nothing.
- [x] C8. When a signed event of one of the six subscribed types arrives, the system shall
  fetch the event's customer and that customer's subscriptions from Stripe, find the account
  by the stored customer id or else by the GitHub user id stamped on the subscription, store
  the customer id and the customer's e-mail on the account, overwrite the account's
  `subscriptions` row with the current subscription's id, status, plan, period end and
  scheduled cancellation, and answer 200; the same event delivered twice, or an older event
  delivered after a newer one, shall leave the rows equal to Stripe's current state.
- [x] C9. When a signed event of any other type arrives, or one whose customer matches no
  account, the system shall answer 200 and change nothing, logging the unmatched customer id;
  when Stripe fails during a sync, the system shall answer 500 and change nothing, so that
  Stripe delivers the event again.
- [x] C10. The README shall list every secret and setting the Worker needs and how to set
  them for local development, without pointing to a file the repository does not have, and
  shall describe the setup done outside the repository: the Stripe webhook destination with
  its six events, the two prices and their lookup keys, the payment methods enabled in the
  Stripe Dashboard, and the Octo OAuth App with the `user:email` scope.

## Out of scope
- Pix, in any form. It waits for a run of its own.
- A route for Stripe's customer portal. Changing the card, cancelling and seeing invoices go
  through the portal link Stripe hosts, set up in the Dashboard.
- Refunds, disputes and fraud warnings: handled in the Stripe Dashboard. Trials, coupons,
  taxes and plan changes made through the API.
- Everything in the Octo app: the OAuth authorization at login, storing the token, calling
  these routes and reacting to the status.
- Deploying and production setup: creating the webhook destination, setting the deployed
  secrets and applying the migrations to the remote D1. The README says how; nothing runs it.
- A log of received events, rate limiting, caching GitHub's answers, signing the status
  response, deleting an account, CORS, and e-mails to customers (Stripe sends its own).

## Decisions & assumptions
- Octo sells one recurring subscription with two prices, monthly and annual, which already
  exist in Stripe under the lookup keys `pro_monthly` and `pro_year`. The API finds a price by
  its lookup key, never by a price id, and the plan it stores is that lookup key → C5, C8.
  Why: the user's pick; lookup keys keep sandbox and live ids out of the repository.
- Payment starts on a Stripe-hosted Checkout Session the API creates, not on a Payment Link
  → C5. Why: the user's pick; a Payment Link is one fixed URL for everybody and would tie a
  payment to an account only through a typed e-mail, while a session carries the verified
  GitHub user id to the payment.
- The session lists no payment methods → C5. Why: the user wants card, Apple Pay, Google Pay
  and Link; the Dashboard enables them, and the wallets and Link come with cards on Checkout.
- Pix is left out. The user wants it on the annual plan only, and the Stripe account is
  domiciled in Brazil, where Stripe's recurring Pix (Pix Automático,
  https://docs.stripe.com/payments/pix/pix-automatico) is not available: a subscription
  Checkout cannot offer Pix there. Why: the user's pick; one-time Pix would need a third
  price, a second path through Checkout and the webhook, and an access date that comes from
  no subscription.
- Nobody signs up. An account is a D1 row keyed by the numeric GitHub user id → C3. Why:
  Octo's only login is the user's GitHub account, and the user does not want a sign-up,
  password or session that exists only for the API.
- The API requires proof of that identity: a GitHub token issued to Octo's own OAuth App
  (it exists already), sent as a Bearer token and confirmed with "check a token" on every
  call; the user id and login come from that answer → C2. Why: the user's pick after
  discussion; verified identity keeps an account's status private and its Checkout its own,
  and accepting only Octo's tokens refuses a token from any other app.
- The `gh` token never reaches the API → C2. Octo gets it from the user's `gh` CLI, it
  usually has access to repositories, and it keeps doing all of Octo's repository work on the
  Mac. Why: the user was uneasy about it leaving the Mac. The token sent to the API is a
  second one that only identifies the user: the Octo OAuth App is authorized by the user with
  the `user:email` scope and nothing else, and is never installed in an organization.
- The account is created when the user logs in to Octo, not when they pay, through
  `PUT /account`, which the app calls at every login → C3. Why: the user's strategy; the
  account exists before any Checkout, and Octo knows every user, not only the paying ones.
  It follows that the app asks for the OAuth authorization at login, from every user.
- The status route only reads, and it and the Checkout route need the account to exist
  → C4, C6. Why: the user's pick; the app will often just check the status, and a read that
  creates a record is a surprise.
- Two tables, the user's idea, with fields the user agreed to → C1.
  `accounts`: `github_user_id` (the key), `github_login`, `github_email` (may be null),
  `stripe_customer_id` (null until the first payment, unique), `billing_email` (may be null),
  `created_at`, `updated_at`.
  `subscriptions`, at most one row per account: `github_user_id` (the key, pointing to the
  account), `stripe_subscription_id`, `status`, `plan`, `current_period_end`,
  `cancel_at_period_end`, `updated_at`.
  Why: an account comes from GitHub and exists from the first login; a subscription comes from
  Stripe and is overwritten whole on every sync, which must never touch identity data.
- The account holds two e-mails → C3, C8. `github_email` is the primary verified address,
  read with the user's token at `PUT /account`; `billing_email` is the Stripe customer's,
  mirrored on every sync. Why: the user's pick; the first is verified and tied to the
  identity, the second is the one the customer chose for billing, and they may differ. An
  account whose token gives no primary verified address is still created, with a null e-mail
  (assumption: the app always asks for the scope, and a missing e-mail should not block a
  login).
- Checkout creates the Stripe customer on the first payment; the API never creates one
  → C5, C8. Why: the user's pick; the login does not depend on Stripe, and Stripe holds only
  paying customers. The GitHub user id stamped on the subscription lets the webhook find the
  account in whatever order the events arrive. A later Checkout of the same account reuses
  the stored customer, so one person stays one customer in Stripe, and sees the billing
  e-mail locked there.
- On a first purchase the e-mail field arrives filled in and editable as a best effort: the
  API adds `prefilled_email` to the URL it returns and never sends `customer_email` → C5.
  Why: the user's pick. Stripe documents that parameter for Payment Links only
  (https://docs.stripe.com/payment-links/customize); the manual check tells whether a session
  URL honors it, and if it does not, the field arrives empty and nothing else changes.
- The webhook destination sends snapshot events of six types: `checkout.session.completed`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed` → C8, C9. Why:
  the user's pick; they cover purchase, renewal, plan change, failed payment, and scheduled
  and effective cancellation. Refunds and disputes are handled in the Dashboard: cancelling
  the subscription there reaches the API as an event.
- D1 mirrors the current state: every one of those events triggers the same sync, which takes
  only the customer id from the event and fetches the rest from Stripe → C8. Why: the user's
  pick; Stripe delivers events duplicated and out of order, and a state fetched at processing
  time is right under both, so no table of processed events is needed.
- The current subscription of a customer is the live one (statuses of C6), or the most
  recently created one when none is live; when the customer has none, the account's
  `subscriptions` row is removed → C8. Why: assumption; a customer who cancels and subscribes
  again has two subscriptions in Stripe, and the account has one row.
- `past_due` keeps access; `canceled`, `unpaid`, `incomplete`, `incomplete_expired` and
  `paused` do not → C4. Why: the user did not object; Stripe is still retrying the charge
  while the subscription is `past_due`, and the Dashboard decides what it becomes when the
  retries run out. No trial is configured; `trialing` grants access should one be added.
- An account with a live subscription cannot open another Checkout → C6. Why: the user did
  not object; two paid subscriptions for one account is always a mistake.
- Route paths `PUT /account`, `GET /account`, `POST /checkout` and `POST /webhooks/stripe`,
  and the error bodies of C2, C4 and C6. Why: assumption; they follow the scaffold's one
  resource per file and its `{"error": ...}` shape. A failure of GitHub or of Stripe outside
  the webhook falls to the scaffold's logged 500.
- Four new required settings, declared like the two Stripe secrets (`secrets.required` in
  `wrangler.jsonc`), with placeholders for the tests in `vitest.config.ts`: `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, `CHECKOUT_SUCCESS_URL` and `CHECKOUT_CANCEL_URL` → C2, C5, C10. Why:
  the user did not object to the URLs coming from the Worker's configuration; declaring all
  four the same way types them, makes a deploy fail when one is missing, and commits no real
  value.
- The `stripe` package becomes a dependency, at its latest stable version, with the API
  version that SDK pins → C5, C7, C8. Why: assumption; it is what verifies signatures on
  Workers.

## Verification
- With real sandbox values in the local secrets, `pnpm dev` running, the Stripe CLI forwarding
  the six events to `http://localhost:8787/webhooks/stripe`, and a token issued by Octo's
  OAuth App with the `user:email` scope: `PUT /account` answers 200 with `"access":false`;
  `POST /checkout` with `{"plan":"pro_monthly"}` returns a URL whose page, paid with the test
  card `4242 4242 4242 4242`, makes `GET /account` answer `"access":true` with
  `"plan":"pro_monthly"` and `"status":"active"`; a second `POST /checkout` answers 409; and
  cancelling the subscription in the Stripe Dashboard makes `GET /account` answer
  `"access":false`. On the Checkout page, note whether the e-mail field arrived filled in
  with the GitHub e-mail and editable.

## Implementation
- - C1: proven by test/schema.test.ts ("the local D1 the tests run against", 4 tests), seen red first (`no such table: accounts`). The migration is `migrations/0001_create_accounts_and_subscriptions.sql`; `vitest.config.ts` reads it and `test/support/apply-migrations.ts` applies it before each test file; `pnpm dev` now runs `pnpm migrate:local` first, which was run by hand and left `accounts` and `subscriptions` in the local dev D1.
- - C2: proven by test/auth.test.ts (the five tests under each of `PUT /account`, `GET /account` and `POST /checkout`, plus "a valid token is never written to D1"), seen red first (404 instead of 401). The check lives in `requireGitHubUser` (src/github.ts).
- - C3: proven by test/account.test.ts ("PUT /account, for a user with no account" and "PUT /account, for a user whose account exists"), seen red first (404 from the missing route).
- - C4: proven by test/account.test.ts ("GET /account", including one test per subscription status for `access`), seen red first.
- - C5: proven by test/checkout.test.ts ("for an account with no Stripe customer", "... and no GitHub e-mail", "for an account with a Stripe customer"), seen red first. The tests read the parameters the real Stripe SDK sent to a fake of Stripe's API.
- - C6: proven by test/checkout.test.ts ("with an invalid plan", "for a user with no account", and the 409 test per live status), seen red first.
- - C7: proven by test/webhooks.test.ts ("with a signature that does not hold": missing, other secret, other body, 301 seconds old, not a signature; and a 240-second-old one accepted), seen red first. The tests sign their payloads themselves with Web Crypto, not with the SDK.
- - C8: proven by test/webhooks.test.ts ("for a customer stored on an account" and "for the customer of a first payment", each run over the six types, with the stale-snapshot, delivered-twice and out-of-order tests), seen red first; removing `status: "all"` from the sync was seen to fail three of them. The sync is `syncCustomer` (src/sync.ts).
- - C9: proven by test/webhooks.test.ts ("a signed event that is not for the API" and "... when Stripe fails"), seen red first. The unmatched customer id is logged with `console.warn`.
- - C10: proven by test/readme.test.ts, seen red first; it reads the required names from `wrangler.jsonc`, so a setting added there without a README entry fails it. 2026-11-14: `pnpm test` 124 passed, 0 failed; `pnpm check` and `pnpm typecheck` clean; `wrangler deploy --dry-run` bundles the Worker with the Stripe SDK.
- - Verification: the end-to-end check was not run. It needs `pnpm dev` (the user's, through Try It), real sandbox values, the Stripe CLI and a token issued by Octo's OAuth App; it is handed to the user as the manual checks.
- - Decision: `pnpm dev` is `pnpm migrate:local && wrangler dev`, and `migrate:local` sets `CI=true` so Wrangler skips its confirmation prompt. Why: C1 asks for no manual step, and Wrangler has no flag for it. Cost if wrong: the inline variable needs a POSIX shell; on Windows the script would need `cross-env`.
- - Decision: only GitHub's 404 to "check a token" (or a missing or non-Bearer header, answered without calling GitHub) is a 401; any other non-200 there is the scaffold's 500. Listing the e-mails, a 403 or 404 (a token without `user:email`) gives a null e-mail, and any other failure is a 500 that creates nothing. Why: C2 names the unrecognized token only, and a GitHub outage must neither look like a logout nor erase a stored e-mail. Cost if wrong: one status check in src/github.ts.
- - Decision: the GitHub user id is stamped on the session as `client_reference_id` and on the subscription as `metadata.github_user_id`, which is what the webhook reads. Dates are stored as ISO 8601 UTC text, `cancel_at_period_end` as 0 or 1 mirroring Stripe's flag of that name (a cancellation scheduled for a custom date through `cancel_at` is not reflected), and `plan` may be null, for a subscription whose price has no lookup key. Why: the spec names the fields, not their encoding, and a null plan keeps a sync from failing forever on a subscription created by hand. Cost if wrong: a new migration.
- - Decision: C8 is read literally when an event's customer is not stored anywhere but its subscription is stamped with an account that already stores another customer: the account takes the new customer and its subscription. Why: the spec gives no rule for a second customer of one account, which only two Checkouts opened before either was paid can produce. Cost if wrong: an event of the abandoned customer can overwrite the row of the live one until the next event of the live one; the fix is a guard in `syncCustomer`.
- - Decision: a rejected signature answers 400 `{"error":"Invalid signature"}`, a subscribed event with no customer answers 200 and changes nothing, and every accepted event answers `{"received":true}`. Tests fake only the network: `test/support/` replaces the global `fetch` with fakes of GitHub's and Stripe's APIs, under the real Hono app, the real Stripe SDK and local D1. `pnpm check:fix` also re-indented two lines of `wrangler.jsonc` that were failing `pnpm check` on `main`.
