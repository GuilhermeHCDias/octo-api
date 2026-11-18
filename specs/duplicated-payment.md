# Stop an account from paying for two subscriptions
status: done
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
- [x] C1. The repository shall hold a new D1 migration that adds the nullable column
  `checkout_session_id` to `accounts`, leaving the first migration untouched, and on a fresh
  clone `pnpm test` and `pnpm dev` shall run against a local D1 that has it, with no manual
  step.
- [x] C2. When `POST /checkout` creates a session, the system shall store that session's id in
  the account's `checkout_session_id` before it answers, change nothing else in D1, and answer
  as today (200, `{"url": ...}`, with `prefilled_email` under the same rule).
- [x] C3. When the account's stored session is still `open` in Stripe, the system shall expire
  it before it answers with the new one, whatever the plans of the two; when the stored session
  is already `expired`, the system shall create the new one without trying to expire it.
- [x] C4. When the account's stored session is `complete` in Stripe, found so when read or when
  Stripe refuses to expire it, the system shall first make D1 mirror Stripe for that session's
  customer, with the same writes as the webhook's sync, and then create no session and answer
  409 `{"error":"Already subscribed"}` if the account's subscription is live; if it is not
  live, the system shall go on to create the new session from the account as the sync left it.
- [x] C5. When the account stores a Stripe customer and its `subscriptions` row is missing or
  not live, the system shall make D1 mirror Stripe for that customer before creating anything,
  and answer as in C4 by the result. An account whose row is already live keeps today's
  answer: 409 without a call to Stripe.
- [x] C6. When two `POST /checkout` requests of the same account overlap, at most one of the
  sessions they create shall be left `open` in Stripe, the account shall store that one, and
  every request that answers 200 shall answer that session's URL.
- [x] C7. When Stripe fails while the system reads or expires the stored session or syncs the
  customer, the system shall create no new session, leave `checkout_session_id` as it was and
  answer the logged 500 `{"error":"Internal Server Error"}`.
- [x] C8. The README shall say, in the `POST /checkout` row, that opening a Checkout expires
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

## Implementation
- - C1: proven by `test/schema.test.ts` ("has the accounts table with the fields of the spec" and "lets an account have no Checkout Session, and adds the column in a migration of its own"), seen red first; `pnpm migrate:local`, the first half of `pnpm dev`, applied `0002_add_checkout_session_id_to_accounts.sql` to a fresh local D1; 2026-11-18 verify passed (151 passed, 0 failed).
- - C2: proven by `test/checkout.test.ts` "stores the session's id on the account and changes nothing else in D1", seen red first; the answer's shape stays under the tests that already guarded it.
- - C3: proven by `test/checkout.test.ts` "expires the open %s Checkout before it answers with a new %s one" (three pairs of plans) and "creates the new session without trying to expire a previous one that already expired", seen red first.
- - C4: proven by the eight tests of `test/checkout.test.ts` "for an account whose previous Checkout was paid with no webhook delivered" (409 for each live status, the payment that lands between the read and the refused expire, and a new session for the synced customer when the subscription is no longer live), seen red first.
- - C5: proven by `test/checkout.test.ts` "mirrors the customer in D1, creates no session and answers 409 when Stripe has a live subscription and the account %s" and "mirrors the customer in D1 before it creates the session, when Stripe has no live subscription either", seen red first; the 409 with no call to Stripe stays under the existing "creates no session and answers 409 when the stored subscription is %s".
- - C6: proven by the two tests of `test/checkout.test.ts` "when two requests of the same account overlap", seen red first, and red again with the losing branch switched off.
- - C7: proven by the four cases of `test/checkout.test.ts` "when Stripe fails before the new session". Not seen red before the code: they passed on their first run, since the code of C3 to C5 already lets a failure throw. Seen red by mutation instead: with the failure swallowed, all four answered 200.
- - C8: proven by `test/readme.test.ts` "says that opening a Checkout expires the previous one, and that 409 covers a payment not yet delivered" and "adds the Dashboard's one-subscription limit to the Stripe setup, with the portal's login link it needs", seen red first.
- - Existing tests changed, none loosened: `test/checkout.test.ts` "changes nothing in D1" became the C2 test, since C2 changes that behavior; two full-row expectations of `test/account.test.ts` gained the new column, and one now proves `PUT /account` keeps a stored session id; the fixtures of "for an account with a Stripe customer" now put that customer, and the matching subscription, in the fake Stripe, since C5 asks Stripe about it.
- - Decision: the claim of C6 is a conditional `UPDATE`: `checkout_session_id` is set only while it still names the session the request settled. The loser expires its own session and answers the URL of the stored one; when that one is no longer open (a third request closed it), it answers the logged 500. Why: D1 makes the comparison atomic, and an error is safer than a URL that may not work. Cost if wrong: the client retries; and if Stripe fails while the loser expires its own session, that session, whose URL nobody received, stays open and untracked until Stripe expires it within 24 hours.
- - Decision: a refusal to expire is any invalid-request error of Stripe (400 or 404), and the session is then read again: `complete` goes to C4, `expired` goes on, anything else is the logged 500, as are a `complete` session with no customer and any other failure. Why: it does not depend on the wording of Stripe's message. Cost if wrong: one more read of the session.
- - Decision: the stored session is settled first, then the stored customer is synced, and C5's sync is skipped when C4's has just mirrored that same customer. A 409 after C4 keeps the paid session's id stored. Why: C4 allows only the sync's writes, and one sync answers both criteria. Cost if wrong: one read of that session on the next Checkout after the subscription ends.
- - Known cost of C7: a stored session that Stripe does not know (404, as after a change of Stripe account or from the sandbox key to the live one) answers 500 on every Checkout of that account until `checkout_session_id` is cleared in D1. A stored customer of another Stripe account already failed the same way before this change.
- - Deploy: the remote D1 needs the new migration (`pnpm exec wrangler d1 migrations apply DB --remote`) before the Worker is deployed, because every read of an account now selects `checkout_session_id`; without it `/account` and `/checkout` answer 500.
- - Verification's end-to-end check: not run in this phase. It needs the real sandbox secrets, `pnpm dev` and a GitHub token of an account, which are the user's; its steps are recorded as the manual checks. `pnpm check` and `pnpm typecheck` passed on 2026-11-18.
