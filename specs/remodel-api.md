# Make the Octo account its own identity, with Better Auth
status: todo
created: 2026-11-19
type: feat
depends-on: none

## Goal
Today an Octo account *is* a GitHub identity: the API accepts only a GitHub token issued to
Octo's OAuth App and keys everything on `github_user_id`, so one Octo account cannot be used
with another GitHub account. Make the account an identity of its own, kept by
[Better Auth](https://better-auth.com) in D1, that a person reaches by signing in with GitHub
or with Apple in the browser, and make the paid status belong to that account. Done means the
native app can turn a browser sign-in into a session token, `/account` and `/checkout` answer
for that token, and no route asks GitHub who the caller is.

## Context
- What exists (`specs/api-stripe-wiring.md`, `specs/duplicated-payment.md`):
  - `src/github.ts`: `requireGitHubUser` confirms the Bearer token with GitHub's "check a
    token" on every call and sets `githubUser` and `githubToken`; `primaryVerifiedEmail` reads
    the user's e-mail. `src/routes/account.ts` and `src/routes/checkout.ts` sit behind it.
  - `migrations/0001_...sql` and `0002_...sql`: `accounts` (key `github_user_id`, with
    `github_login`, `github_email`, `stripe_customer_id`, `billing_email`,
    `checkout_session_id`) and `subscriptions` (key `github_user_id`).
  - `src/sync.ts` finds the account of a Stripe customer by `stripe_customer_id`, or else by
    the `github_user_id` that `POST /checkout` stamps on the subscription's metadata and on
    `client_reference_id`.
  - `github_user_id` appears 158 times in 14 files, most of them tests: the re-keying is the
    bulk of the change. `test/auth.test.ts`, `test/account.test.ts` and
    `test/support/github.ts` are written around the GitHub token check and change with it.
- Better Auth on Workers and D1 (docs read on 2026-11-19; the latest release is 1.7.26):
  - D1 is a first-class database since Better Auth 1.5: the binding is passed as
    `database: env.DB`, with no adapter. D1 has no interactive transactions, so Better Auth
    uses `batch()`. https://better-auth.com/blog/1-5
  - Cloudflare guide: https://better-auth.com/docs/guides/cloudflare. Better Auth needs
    `node:crypto` and `AsyncLocalStorage`, on by default from compatibility date `2026-08-04`
    (`wrangler.jsonc` has `2026-11-13`), and reads its secret from `process.env`
    (`BETTER_AUTH_SECRET`). The client address must come from `cf-connecting-ip`
    (`advanced.ipAddress.ipAddressHeaders`), or rate limiting shares one bucket per path.
    Workers KV cannot be its `secondaryStorage`.
  - Hono: https://better-auth.com/docs/integrations/hono and
    https://hono.dev/examples/better-auth-on-cloudflare. The handler is mounted on
    `/api/auth/*`; a middleware reads the session with `auth.api.getSession({ headers })`.
  - Schema: the core tables are `user`, `session`, `account` and `verification`; the user id is
    a string. The CLI cannot reach D1 ("can only be queried through a Cloudflare Worker");
    `getMigrations` from `better-auth/db/migration` runs inside the Worker and reports
    `toBeCreated` and `toBeAdded`. https://better-auth.com/docs/concepts/database
  - Account linking is on by default: a provider sign-in whose e-mail the provider verified
    and that matches an existing user joins that user.
    https://better-auth.com/docs/concepts/users-accounts
  - GitHub: the callback is `/api/auth/callback/github`; the e-mail and its `verified` flag
    come from `GET /user/emails`. https://better-auth.com/docs/authentication/github
  - Apple: https://better-auth.com/docs/authentication/apple. The web flow needs a Services ID
    (the client id) and a client secret that is a JWT signed with the team's key, which Apple
    refuses when it expires more than six months ahead; `https://appleid.apple.com` goes in
    `trustedOrigins`; Apple sends the e-mail only on the first authorization.
- How a browser sign-in reaches a native app. Read in Better Auth's source (`main` at
  `4d9456d`) on 2026-11-19, since the docs cover only Expo and Electron:
  - The OAuth `state` is bound to a cookie of the browser that starts the flow
    (`packages/better-auth/src/state.ts`), so the flow must start and end in the same browser.
  - One-time-token plugin (`plugins/one-time-token`): a single-use token, 3 minutes by
    default, generated for an existing session; `POST /one-time-token/verify` with `{token}`
    answers that session and sets its cookie. https://better-auth.com/docs/plugins/one-time-token
  - Bearer plugin (`plugins/bearer`): a response that sets the session cookie also carries the
    token in the `set-auth-token` header, and `Authorization: Bearer <token>` is read as the
    session. https://better-auth.com/docs/plugins/bearer
  - What a session is (`db/internal-adapter.ts`, `cookies/index.ts`, `api/routes/session.ts`):
    a random token of 32 characters, stored as it is in `session.token`, because the row is
    how a session is found, expired and ended. The client never gets it bare: the cookie, and
    so `set-auth-token`, carry it signed with `BETTER_AUTH_SECRET`. The bearer plugin by
    default also accepts the bare token and signs it itself; `requireSignature: true` makes it
    accept only the signed one. The one-time-token plugin stores its code in plain text by
    default and hashed with `storeToken: "hashed"`. Better Auth has no option to hash
    `session.token`, and its security page recommends none: it names the database session,
    the 7 days of expiry, the revocation and the signed cookie.
    https://better-auth.com/docs/reference/security
  - Native Sign in with Apple is not an alternative: Apple gives its entitlement to no
    Developer ID profile, only to Mac App Store builds
    (https://developer.apple.com/forums/thread/671319), so Apple goes through the browser.
- The data in D1 after the change. Better Auth's four tables, as its source declares them
  (`packages/core/src/db/get-tables.ts`, read on 2026-11-19), with its own names in camelCase:
  - `user`, the Octo account: `id` (text), `name`, `email` (required, unique),
    `emailVerified`, `image`, `createdAt`, `updatedAt`.
  - `account`, one row per provider a user signed in with: `id`, `userId` (references `user`,
    cascade), `providerId` (`github` or `apple`), `accountId` (the person's id at the
    provider), `accessToken`, `refreshToken`, `idToken`, their two expiry dates, `scope`,
    `password`, `createdAt`, `updatedAt`. Better Auth stores the provider's tokens here in
    plain text by default; `account.encryptOAuthTokens` encrypts them, and a
    `databaseHooks.account` hook can replace what is written.
  - `session`, one row per sign-in: `id`, `userId` (references `user`, cascade), `token`
    (unique, in plain text, with no option to hash it), `expiresAt`, `ipAddress`, `userAgent`,
    `createdAt`, `updatedAt`.
  - `verification`, short-lived rows: `id`, `identifier`, `value`, `expiresAt`, `createdAt`,
    `updatedAt`. It holds the OAuth `state` of a sign-in in progress and the single-use code
    of C3, whose row carries the session's token until the code is used or expires. Better
    Auth deletes its expired rows by itself.
  - On SQLite the types are `text`, `integer` for booleans and `date` for dates
    (`packages/better-auth/src/db/get-migration.ts`). The bearer and one-time-token plugins
    add no table. A fifth table, `rateLimit`, exists only when the rate limiter is told to
    store in the database; its default is the memory of each isolate.
  - Octo's own two tables, in the snake_case they have today: `billing` and `subscriptions`
    (C1).
- Patterns to follow: one Hono instance per resource under `src/routes/`, handlers inline,
  errors as `{"error": ...}`; a schema change is a new file under `migrations/`, never an edit
  of an applied one; secrets are named under `secrets.required` in `wrangler.jsonc` and given
  placeholders in `vitest.config.ts`; `test/schema.test.ts`, `test/secrets.test.ts` and
  `test/readme.test.ts` guard the schema, the settings and the README.
- Tests fake only the network (`test/support/network.ts`), under the real app, the real
  libraries and local D1. Better Auth runs for real too: new fakes answer what it asks GitHub
  (`github.com/login/oauth/access_token`, `api.github.com/user` and `/user/emails`) and Apple
  (`appleid.apple.com/auth/token` and `/auth/keys`, with ID tokens signed by a key made for the
  tests). A test plays the browser by carrying the cookies from one redirect to the next.
- The test and run commands live in `.octo/project.md`.

## Acceptance criteria
- [ ] C1. The repository shall hold a new D1 migration, the two earlier ones untouched, that
  drops the old `accounts` and `subscriptions`, creates Better Auth's `user`, `session`,
  `account` and `verification`, and creates `billing` (key `user_id` referencing `user`, with
  `stripe_customer_id` unique, `billing_email`, `checkout_session_id`, `created_at`,
  `updated_at`) and `subscriptions` (key `user_id` referencing `billing`, the other columns as
  today); on a fresh clone `pnpm test` and `pnpm dev` shall run against it with no manual step,
  and Better Auth shall report no table and no column missing.
- [ ] C2. When a browser opens `GET /sign-in/github` or `GET /sign-in/apple` with a
  `challenge`, the base64url SHA-256 of a random verifier the app keeps, the system shall
  redirect it to that provider's authorization page, naming the API's
  `/api/auth/callback/<provider>` as the return address; a missing or malformed `challenge`
  shall answer 400 `{"error":"Invalid challenge"}`, and any other name after `/sign-in/` shall
  answer 404 `{"error":"Not Found"}`.
- [ ] C3. When the provider returns that browser to the callback with an authorization, the
  system shall create the user at their first sign-in, or find the one that provider account
  belongs to, open a session and redirect the browser to `APP_SIGN_IN_URL` with a single-use
  `code` and nothing else of the session; when the authorization is refused or fails, it shall
  open no session and redirect to `APP_SIGN_IN_URL` with an `error` and no `code`.
- [ ] C4. When a client sends `POST /sign-in/token` with `{"code": ..., "verifier": ...}`, the
  code for the first time and within 3 minutes and the verifier the one whose SHA-256 is the
  `challenge` of the sign-in that produced the code, the system shall answer 200
  `{"token": ...}` with the session's signed token; a code already used, older than that or
  never issued, or a verifier that does not match, shall answer 401 `{"error":"Invalid code"}`
  and no token; `POST /api/auth/one-time-token/verify` shall answer 404, so that no code is
  traded without its verifier; and D1 shall at no moment hold the code in a readable form.
- [ ] C5. When a provider reports a verified e-mail that an existing user has, the system
  shall sign that user in and add the provider's account to it, creating no second user; when
  GitHub reports the matching e-mail as unverified, it shall link nothing and end as the
  failure of C3.
- [ ] C6. `/account` and `/checkout` shall answer for `Authorization: Bearer <token>` with the
  signed token of C4, and answer 401 `{"error":"Unauthorized"}` to anything else, without a
  call to GitHub: no header, an unknown or expired token, a GitHub token, the bare value of
  `session.token` as D1 holds it, and the token of a session that `POST /api/auth/sign-out`
  ended.
- [ ] C7. `GET /account` shall answer 200 to every signed-in user with `user_id`, `email`,
  `name`, `access` and `subscription`, the last two as today and `"access":false` with
  `"subscription":null` for a user who never opened a Checkout; `PUT /account` shall no longer
  exist and answer 404 `{"error":"Not Found"}`.
- [ ] C8. `POST /checkout` and the webhook's sync shall behave as `specs/api-stripe-wiring.md`
  and `specs/duplicated-payment.md` describe, with the user where the GitHub user was: the
  user's id goes in `client_reference_id` and in the subscription's metadata as `user_id`, the
  sync finds the account by its stored customer or else by that stamp, the prefilled e-mail is
  the user's, and a user with no `billing` row checks out as an account with no customer and
  no previous Checkout, never a 404.
- [ ] C9. `wrangler.jsonc` shall require, and `vitest.config.ts` give test values to,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_SIGN_IN_URL`, `APPLE_CLIENT_ID`,
  `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`, beside the six of today; the README
  shall describe the account as Octo's own, the sign-in from the browser to the token
  (C2 to C4, with the challenge and the verifier), the sign-out, the new `/account`,
  every setting, with `BETTER_AUTH_SECRET` as a random value of at least 32 bytes and the
  command that makes one, and the setup outside the repository: the callback URL of GitHub's
  OAuth App,
  Apple's App ID, Services ID, return URL and key, and, as recommended and not required, a
  Cloudflare rate limiting rule by client address on `/sign-in/` and `/api/auth/`, which needs
  the Worker on a domain of the account.
- [ ] C10. After any sign-in, first or repeated, with GitHub or with Apple, the `account` row
  shall hold no token of the provider: `accessToken`, `refreshToken` and `idToken` are null.

## Out of scope
- Everything in the Octo app: opening the browser, receiving `APP_SIGN_IN_URL`, storing the
  session token, and its use of the `gh` CLI, which this change makes independent of the Octo
  account.
- E-mail and password. It stays off, as Better Auth has it by default: the user left it for a
  run of its own, together with the sending of e-mail it needs.
- Other providers (Google and the like), and linking a second provider by hand to a signed-in
  account, which a person who hides their e-mail from Apple would need to join two accounts.
- Moving the accounts that exist: the migration drops them. Deleting a user.
- Better Auth's Stripe plugin. The Stripe wiring of the two earlier specs stays; only the key
  it hangs on changes.

## Decisions & assumptions
- Better Auth, with its native D1 support and no ORM → C1. Why: the user's choice of
  framework; D1 is first-class since 1.5, so neither Drizzle nor the community package
  `better-auth-cloudflare` is needed, and the repository keeps its plain SQL migrations. The
  tables are written in a migration of the repository because Better Auth's CLI cannot reach
  D1, and a test asks Better Auth itself whether anything is missing.
- Nothing paid comes with Better Auth → all. Why: the user does not want to pay for it. Only
  the open-source framework is used, as a dependency that runs in Octo's own Worker and D1
  (https://better-auth.com/pricing: "free and open source"). Better Auth Infrastructure, the
  separate hosted product (dashboard, abuse protection, transactional messaging), is not used,
  and neither is any plugin that depends on it or on another paid service.
- The API stops seeing GitHub tokens, of the `gh` CLI or of any other source: GitHub becomes a
  sign-in provider like the others → C6. Why: this is what frees an Octo account from one
  GitHub account, the reason for the run.
- Providers: GitHub and Apple, no e-mail and password → C2. Why: the user's picks. GitHub
  reuses Octo's OAuth App and its two secrets.
- The session reaches the app through the browser and a single-use code: the app opens the
  system browser on `/sign-in/<provider>`, the sign-in happens there, the API sends the
  browser to `APP_SIGN_IN_URL` with a code, and the app trades the code for the token
  → C2, C3, C4. Why: the user's pick after the investigation. One flow serves every provider,
  it is made of documented parts (the one-time-token and bearer plugins) plus three small
  routes of the API (the start, the end in the browser and the trade), and the session token
  never travels in a URL.
  - The code is tied to the app that began the sign-in, as PKCE does (RFC 7636, which RFC 8252
    requires of native apps) → C2, C4. Why: assumption, from the user's review of the whole
    path on 2026-11-20, and their choice of the safest way in the earlier runs. A URL scheme
    such as `octo://` can be claimed by another app on the Mac, and a link can hand the app a
    code of somebody else's sign-in; with the challenge, a code is worth nothing to who does
    not hold the verifier, and the app never trades a code of a sign-in it did not begin. The
    trade is therefore a route of the API, which checks the verifier and then asks Better
    Auth for the session, and Better Auth's own endpoint for the trade is closed.
  - Rejected: the Expo plugin's server side, which appends the whole session cookie to the
    app's URL and whose source carries a FIXME on that proxy; the device flow, which needs a
    page with an interface this API does not have; trading a provider token for a session
    with no browser, which Apple allows only to Mac App Store builds.
  - Only the API's own route issues a code: a client cannot ask Better Auth for one.
- Implement proves C2 to C4 first, against the real library, before it re-keys anything. If
  the hand-over cannot be made to work, it stops and reports instead of building the rest.
  Why: the user's condition, "if it does not work, the remodel is not possible".
- `APP_SIGN_IN_URL` is a setting, like the Checkout URLs, and the only place the API redirects
  a finished sign-in to → C3, C9. Why: assumption; the app's URL scheme is the app's to
  choose (for example `octo://sign-in`), and a fixed target leaves no open redirect.
- The same verified e-mail is the same Octo account → C5. Why: the user's pick, and Better
  Auth's default: one person, one account, one subscription. An unverified e-mail never
  links, or anyone could take an account by claiming its address at GitHub.
- A GitHub user with no e-mail address GitHub can report cannot sign in → C3. Why: Better Auth
  requires an e-mail for a user. It reverses the earlier rule that a missing e-mail does not
  block a login; `user:email` is in the scopes Better Auth asks by default.
- The API signs Apple's client secret itself, from `APPLE_PRIVATE_KEY`, `APPLE_TEAM_ID` and
  `APPLE_KEY_ID` → C2, C3, C9. Why: the user's pick; nothing expires, so the sign-in with
  Apple does not stop six months later because nobody replaced a secret. The tests' fake of
  Apple accepts a token request only when its client secret is signed by the tests' key.
- Start from zero: the migration drops the rows that exist → C1. Why: the user's pick; the
  API has run only against Stripe's sandbox.
- The billing data lives in `billing`, apart from Better Auth's `user`, and its row is created
  when first needed → C1, C7, C8. Why: assumption; Better Auth owns `user`, and Octo's old
  name `accounts` would be confused with Better Auth's `account`, which is a provider link.
  A user exists from the sign-in, so an account no longer needs creating: `PUT /account` goes,
  and no route answers `Account not found`.
- Better Auth's tables keep its own names and columns, in camelCase, beside Octo's snake_case
  → C1. Why: assumption; renaming them is configuration that every plugin and every page of
  the docs would then have to be read through, for a cosmetic gain.
- The provider's tokens are not kept → C10. Why: assumption, from the rule the API has today,
  "stores it nowhere". After the sign-in Octo asks the provider nothing, so a token in D1
  would be only something to leak. If Better Auth cannot be made to write them empty,
  Implement turns `account.encryptOAuthTokens` on instead and reports it.
- Reading D1 is not enough to act as a user: the API accepts only the signed token, and the
  code is stored hashed → C4, C6. Why: assumption, from the user's doubt on 2026-11-20 about
  the token in plain text. The row must exist, since it is what makes a session expire and
  end at the sign-out, and Better Auth cannot hash it; but with the bearer plugin's
  `requireSignature` the bare value of D1 is refused, so a leak of the database gives no
  session without `BETTER_AUTH_SECRET`, which lives in the Worker's secrets and never in D1.
  The code is hashed (`storeToken: "hashed"`) because a readable one could be traded for a
  signed token within its 3 minutes. The token the app gets from `POST /sign-in/token` is the
  signed one. The signature is only as strong as the secret: whoever holds one token can test
  guesses of it offline, so the README asks for a random one of at least 32 bytes → C9.
  - Rejected: sessions with no row (Better Auth's stateless mode). It is what Better Auth does
    with no database at all, a session cannot be ended before it expires, and the docs do not
    cover it with the bearer and one-time-token plugins.
  - What stays is the trust boundary of any server, not a flaw of this design: whoever has
    both D1 and the secret, or can write to D1, acts as any user, as whoever can write to D1
    today can mark any account as paid. D1 is reached only through the Worker's binding or
    Cloudflare's API with the account's credentials, so the protection is the Cloudflare
    account's. After a leak, replacing `BETTER_AUTH_SECRET` voids every token at once, and
    deleting the rows of `session` ends every session.
- The session keeps the client's address and user agent, Better Auth's default, which its rate
  limiter needs.
- Better Auth's rate limiter keeps its default storage, the memory of each isolate, so there
  is no `rateLimit` table → C1. Why: weighed with the user on 2026-11-20. The limiter counts
  requests by client address and path on Better Auth's own endpoints (100 in 10 seconds, 3 in
  10 seconds on the sign-in paths) and answers 429; its job is to stop guessing. This run has
  nothing to guess: no password, and the code and the session token are long random values.
  The table would cost a read and a write in D1 on every request to `/api/auth/*`, and would
  still not cover `/sign-in/<provider>`, which calls Better Auth from the server, where the
  limiter does not count (https://better-auth.com/docs/concepts/rate-limit). The run that adds
  e-mail and password must give the limiter a shared storage: there a password can be guessed,
  and counters that each isolate keeps and loses do not hold an attacker.
- The README recommends a rate limiting rule of Cloudflare itself, and nothing depends on it
  → C9. Why: the user's pick. What is left to stop in this run is a flood of requests, and
  that rule refuses it before the Worker, at no cost in D1; the free plan gives one rule, by
  client address, in windows of 10 seconds
  (https://developers.cloudflare.com/waf/rate-limiting-rules/).
- Assumption: expired `session` rows are not swept: one row per sign-in stays in D1.
- `GET /account` drops `github_user_id` and `github_login` for `user_id`, `email` and `name`
  → C7. Why: assumption; the app must change for the new token anyway, and the account no
  longer has one GitHub identity to show.
- Assumption: sessions keep Better Auth's defaults, 7 days, renewed when used after a day
  → C6. An app left closed for a week asks for a new sign-in. There is no refresh token: the
  one token stays the same while the session lives, and every request reads its row, so the
  sign-out ends it at once, which is what a short-lived token with a refresh one imitates.
- Assumption: Better Auth's CPU cost fits the Worker's plan. Its known heavy step is scrypt,
  which hashes passwords, and this run has none; the run that adds e-mail and password must
  check it against the 10 ms of the free plan.
- Assumption: Apple's return URL must be HTTPS on a registered domain, so the sign-in with
  Apple cannot be tried on `localhost`; the tests cover it with the fake, and the manual check
  needs a deployed Worker.

## Verification
- With the real values in the local secrets, GitHub's OAuth App pointing its callback to
  `http://localhost:8787/api/auth/callback/github`, and `pnpm dev` running: make a random
  verifier, open `http://localhost:8787/sign-in/github?challenge=<its base64url SHA-256>` in a
  browser and authorize. The browser ends on `APP_SIGN_IN_URL` with a `code`. Send the code
  and the verifier to `POST /sign-in/token` and take the token; the same code sent again, or
  with another verifier, answers 401. `GET /account` with the token answers 200 with
  `"access":false`, `POST /checkout` answers
  a Stripe URL, and after paying with the test card `4242 4242 4242 4242` `GET /account`
  answers `"access":true`. Sign in again with a different GitHub account whose e-mail is
  another: it gets an account of its own, with `"access":false`. After
  `POST /api/auth/sign-out`, the first token answers 401.
