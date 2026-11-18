# Stop an account from paying for two subscriptions
status: todo
created: 2026-11-18
type: fix
depends-on: none

## Goal
An account can open two Checkouts, pay both, and end up charged for two subscriptions, because
`POST /checkout` refuses a second Checkout only after the webhook has written the first payment
to D1. Make it impossible for one account to have more than one payable Checkout at a time, and
make the refusal hold from the moment of the payment, not from the arrival of the webhook. Done
means the second of two Checkouts opened by the same account can never be paid.

## Context
- The report was checked against the code and it holds.
  - `src/routes/checkout.ts:24-31` answers 409 `Already subscribed` from the account's
    `subscriptions` row alone. That row is written only by `syncCustomer` (`src/sync.ts`),
    which only the webhook calls (`src/routes/webhooks.ts`). Between the opening of a Checkout
    and the webhook of its payment, nothing stops another Checkout.
  - First purchase: the session names no customer (`src/routes/checkout.ts:55`), so each paid
    session makes its own Stripe customer and its own subscription. `findGitHubUserId`
    (`src/sync.ts:23-42`) falls back to the GitHub user id stamped on the subscription, so an
    event of either customer moves the account's `stripe_customer_id` and its `subscriptions`
    row to that customer. `specs/api-stripe-wiring.md` recorded this under *Implementation*
    as a known cost ("which only two Checkouts opened before either was paid can produce").
  - Returning customer: both sessions name the stored customer, so one customer gets two
    subscriptions. The row mirrors the newest live one (`currentSubscription`), and the other
    keeps charging with no trace in D1.
- Stripe facts that shape the fix (docs read on 2026-11-18):
  - Expire a session: https://docs.stripe.com/api/checkout/sessions/expire. Only a session
    whose status is `open` can be expired; Stripe answers an error for any other. After it, the
    customer cannot complete the session and its page says it expired. A session's status is
    `open`, `complete` ("payment processing may still be in progress") or `expired`.
  - List sessions: https://docs.stripe.com/api/checkout/sessions/list. Filters by `customer`,
    `status`, `subscription` and a few others; none by `client_reference_id` or metadata, so
    the sessions of a first purchase cannot be found in Stripe by the account.
  - Search: https://docs.stripe.com/search. "Don't use search for read-after-write flows":
    new data is searchable in under a minute normally, later during an outage. The list APIs
    have no such delay.
  - One subscription per customer: https://docs.stripe.com/payments/checkout/limit-subscriptions.
    A Dashboard setting (Checkout and Payment Links settings) that sends a customer who already
    has an `active`, `past_due`, `unpaid` or `paused` subscription to the customer portal. It
    finds the customer by the session's `customer`, or else by the e-mail address, and needs
    the portal's login link enabled.
- Patterns to follow: one Hono instance per resource under `src/routes/`, handlers inline,
  errors as `{"error": ...}`, a failure of Stripe outside the webhook falling to the logged 500
  of `src/index.ts`. Schema changes are a new file under `migrations/`, never an edit of
  `0001_create_accounts_and_subscriptions.sql`; `pnpm dev` and the tests apply them.
- Tests fake only the network (`test/support/`): the real Hono app, the real Stripe SDK and
  local D1. `test/support/stripe.ts` answers today only the prices, the creation of a session
  (always the id `cs_test_a1B2c3`), a customer and the list of its subscriptions; its
  `beforeNextAnswer` makes two requests overlap. `test/support/database.ts` lists the columns
  of both tables, and `test/schema.test.ts` and `test/readme.test.ts` guard the schema and the
  README.
- The test and run commands live in `.octo/project.md`.

## Acceptance criteria
- [ ] C1. The repository shall hold a new D1 migration that adds the nullable column
  `checkout_session_id` to `accounts`, leaving the first migration untouched, and on a fresh
  clone `pnpm test` and `pnpm dev` shall run against a local D1 that has it, with no manual
  step.
- [ ] C2. When `POST /checkout` creates a session, the system shall store that session's id in
  the account's `checkout_session_id` before it answers, change nothing else in D1, and answer
  as today (200, `{"url": ...}`, with `prefilled_email` under the same rule).
- [ ] C3. When the account's stored session is still `open` in Stripe, the system shall expire
  it before it answers with the new one, whatever the plans of the two; when the stored session
  is already `expired`, the system shall create the new one without trying to expire it.
- [ ] C4. When the account's stored session is `complete` in Stripe, found so when read or when
  Stripe refuses to expire it, the system shall first make D1 mirror Stripe for that session's
  customer, with the same writes as the webhook's sync, and then create no session and answer
  409 `{"error":"Already subscribed"}` if the account's subscription is live; if it is not
  live, the system shall go on to create the new session from the account as the sync left it.
- [ ] C5. When the account stores a Stripe customer and its `subscriptions` row is missing or
  not live, the system shall make D1 mirror Stripe for that customer before creating anything,
  and answer as in C4 by the result. An account whose row is already live keeps today's
  answer: 409 without a call to Stripe.
- [ ] C6. When two `POST /checkout` requests of the same account overlap, at most one of the
  sessions they create shall be left `open` in Stripe, the account shall store that one, and
  every request that answers 200 shall answer that session's URL.
- [ ] C7. When Stripe fails while the system reads or expires the stored session or syncs the
  customer, the system shall create no new session, leave `checkout_session_id` as it was and
  answer the logged 500 `{"error":"Internal Server Error"}`.
- [ ] C8. The README shall say, in the `POST /checkout` row, that opening a Checkout expires
  the account's previous one and that 409 also covers a payment the webhook has not delivered
  yet, and shall add to the Stripe setup the Dashboard setting that limits a customer to one
  subscription, as a second layer that needs the customer portal's login link enabled.

## Out of scope
- A way to force a sync after the payment (a sync route, or `{CHECKOUT_SESSION_ID}` in the
  success URL), and any polling by the app. The user left it out; it waits for a run of its
  own. C4 and C5 do bring D1 up to date, but only when a new Checkout is asked for.
- A guard in `syncCustomer` for an account with two Stripe customers. After this change the
  API can no longer produce a second customer, so the row has nothing to alternate between.
- Repairing duplicates that already exist in Stripe: cancelling and refunding them is done in
  the Dashboard.
- Creating the Stripe customer before the Checkout, changing `GET /account` or `PUT /account`,
  and anything in the Octo app.
- Payment methods that confirm later (Pix, boleto, bank debits). None is enabled; see the
  assumption below.

## Decisions & assumptions
- One payable Checkout per account: the API remembers the session it opened and settles it
  (expired, or paid and synced) before opening another → C2, C3, C4, C6. Why: the user asked
  for the safest way. It is the only option that closes the hole itself, two sessions both
  opened before any payment; Stripe has no rule of its own for that, so the account's row in
  D1 is where the claim is made.
- Rejected: looking for a live subscription with `stripe.subscriptions.search` → none. Why: it
  does not close the hole. Two sessions opened before either is paid both pass it, and Stripe's
  search sees new data only after up to a minute, the very window in question.
- Rejected: creating the customer before the first Checkout and asking Stripe by customer
  → none. Why: it undoes the earlier decision that Checkout creates the customer
  (`specs/api-stripe-wiring.md`), leaves customers in Stripe who never paid, and still needs
  the same claim in D1 for overlapping requests, so it adds change without adding safety.
- A second layer asks Stripe, not D1, whenever the account has a handle to it: the paid
  session's customer, or the stored customer → C4, C5. Why: safest; the refusal then holds
  with a late or misconfigured webhook, and through the list API, which has no indexing delay.
  It costs two calls to Stripe on those Checkouts, which are rare.
- A row that is already live still answers 409 with no call to Stripe → C5. Why: it is the
  refusing side, so a stale row can only delay a new Checkout until the webhook arrives, never
  allow a second payment; and today's behavior and tests stay.
- An open previous session is expired, never reused → C3. Why: assumption; the new request may
  ask for the other plan, and one rule (the last Checkout asked for is the only one that works)
  is simpler to reason about than two. The earlier tab shows Stripe's "expired" page.
- The loser of two overlapping requests answers the winner's URL, not an error → C6. Why:
  assumption; the usual cause is a double click, and both answers should lead to the one
  Checkout that works.
- Any failure while settling the previous session refuses the new one → C7. Why: safest; a new
  session is created only when the previous one is known to be closed.
- The session id lives in a column of `accounts`, `checkout_session_id`, not in a table → C1.
  Why: only the last session matters, and it belongs to the account, not to the subscription
  row that every sync overwrites. `PUT /account` and the sync leave it alone.
- The README recommends the Dashboard's one-subscription setting but nothing depends on it
  → C8. Why: it is Stripe's own refusal for a customer who already pays, found by the session's
  customer or by e-mail; on a first purchase the e-mail is editable, so it is a second layer
  and not the fix.
- Assumption: only cards, Apple Pay, Google Pay and Link are enabled, so a `complete` session
  means a paid one → C4. A method that confirms later would leave a `complete` session with an
  `incomplete` subscription, which C4 would not refuse; the run that adds Pix must revisit it.
- Assumption: sessions opened before this change are not tracked and expire on their own
  within 24 hours → C3. Why: the API runs only against Stripe's sandbox so far.

## Verification
- With real sandbox values in the local secrets, `pnpm dev` running and a token of an account
  with no subscription: call `POST /checkout` twice. The first URL shows Stripe's expired page
  and the second can be paid. Stop the Stripe CLI's forwarding, pay the second with the test
  card `4242 4242 4242 4242`, and call `POST /checkout` again: it answers 409, Stripe shows one
  customer with one subscription, and `GET /account` answers `"access":true` although no
  webhook was delivered.
