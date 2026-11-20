# Octo API

The API behind Octo. It is where a person signs in to their Octo account, where that account
pays and where its payment status is read. The account is Octo's own: [Better Auth](https://better-auth.com)
keeps it in D1, and a person reaches it by signing in with GitHub or with Apple in the browser.
It belongs to no GitHub account: the same verified e-mail address at either provider is the same
Octo account. Stripe takes the payment on a hosted Checkout, Stripe's webhooks keep the account's
subscription current in D1, and the API answers whether the account has access.

## Routes

| Route                               | What it does                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                       | Answers `{"status":"ok"}`.                                                                                                                                                                                                                                                                                                   |
| `GET /sign-in/<provider>`           | Starts a sign-in in the browser, with `github` or `apple`. See [Signing in](#signing-in).                                                                                                                                                                                                                                    |
| `GET /api/auth/callback/<provider>` | Where the provider sends the browser back. Ends the sign-in and redirects to the app.                                                                                                                                                                                                                                        |
| `POST /sign-in/token`               | Trades the code a sign-in ended with, and its verifier, for the session token.                                                                                                                                                                                                                                               |
| `POST /api/auth/sign-out`           | Ends the session of the token it is sent.                                                                                                                                                                                                                                                                                    |
| `GET /account`                      | The caller's account: `user_id`, `email`, `name`, `access` and `subscription`. Reads D1 only. Every signed-in user has one: `"access":false` and `"subscription":null` until they pay.                                                                                                                                       |
| `POST /checkout`                    | Body `{"plan":"pro_monthly"}` or `{"plan":"pro_year"}`. Creates a Stripe Checkout Session and answers `{"url":"..."}`. Opening a Checkout expires the account's previous one, so only the last one can be paid. 409 when the account already has a live subscription, even from a payment the webhook has not delivered yet. |
| `POST /webhooks/stripe`             | Stripe's webhook: verifies the signature, then makes D1 mirror the customer's current subscription.                                                                                                                                                                                                                          |

`/account` and `/checkout` need `Authorization: Bearer <token>`, where the token is the one
`POST /sign-in/token` answered. The API reads its session from D1 on every call, asks no
provider anything and answers 401 `{"error":"Unauthorized"}` to anything else, a GitHub token
included. `access` is true while the subscription is `active`, `trialing` or `past_due`.

## Signing in

The app never sees a password or a provider's token. It opens the system browser, the person
signs in there, and the app ends up with a session token of the API. The steps:

1. The app makes a random **verifier** and keeps it. It opens the browser on
   `GET /sign-in/github` or `GET /sign-in/apple` with `?challenge=`, the **challenge**: the
   base64url, with no padding, of the SHA-256 of the verifier (PKCE's `S256`, RFC 7636). A
   missing or malformed challenge answers 400 `{"error":"Invalid challenge"}`; any other name
   after `/sign-in/` answers 404.
2. The API redirects the browser to the provider's authorization page. The provider sends the
   browser back to `/api/auth/callback/<provider>`, where the API creates the account at a first
   sign-in, or finds the one that provider account belongs to, and opens a session.
3. The API redirects the browser to `APP_SIGN_IN_URL` with a single-use `code` and nothing else
   of the session, or with an `error` and no code when the sign-in was refused or failed. The
   whole sign-in has to happen in one browser.
4. The app sends `POST /sign-in/token` with `{"code":"...","verifier":"..."}` and gets
   `{"token":"..."}`. A code works once, within 3 minutes, and only with the verifier of the
   sign-in that produced it: anything else answers 401 `{"error":"Invalid code"}`. A code that
   another app intercepts is therefore worth nothing to it.
5. The app sends the token as `Authorization: Bearer <token>`.

The token is the session's, signed with `BETTER_AUTH_SECRET`. D1 holds the session without the
signature and the code only hashed, so reading the database is not enough to act as a user. A
session lasts 7 days and is renewed when it is used after a day; there is no refresh token.
`POST /api/auth/sign-out` with the token ends the session at once. Replacing
`BETTER_AUTH_SECRET` voids every token, and deleting the rows of `session` ends every session.

Accounts are joined by e-mail: a sign-in whose provider reports a verified address that an
account already has signs that account in and adds the provider to it. An unverified address
never joins an account, and an account whose own address was never verified is joined by
nobody. A GitHub account with no e-mail address that GitHub can report cannot sign in. The API
keeps none of the provider's tokens.

## Stack

- [Hono](https://hono.dev) on [Cloudflare Workers](https://developers.cloudflare.com/workers/),
  written in TypeScript (`strict`).
- [D1](https://developers.cloudflare.com/d1/) (binding `DB`) and
  [R2](https://developers.cloudflare.com/r2/) (binding `BUCKET`), declared in `wrangler.jsonc`.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) for local development, type
  generation and deploys.
- [Stripe](https://docs.stripe.com) through its Node SDK, which pins the API version.
- [Vitest](https://vitest.dev) with `@cloudflare/vitest-plugin`: the tests run inside the Workers
  runtime, against local D1 and R2.
- [Biome](https://biomejs.dev) as formatter and linter.
- [pnpm](https://pnpm.io) as package manager.

## Prerequisites

- **Node.js 26** (the active LTS), as `engines.node` in `package.json` asks.
- **pnpm 12**. The exact version is pinned in `packageManager` in `package.json`; another
  pnpm 12, or a recent pnpm 11, switches to it by itself. pnpm 10 cannot make that switch and
  fails with `Failed to switch pnpm`: upgrade pnpm first.

No Cloudflare account is needed to develop or to run the tests: D1 and R2 are simulated locally.
The tests need no Stripe, GitHub or Apple account either: they never reach the network.

## Getting started

```sh
pnpm install
pnpm dev
```

The Worker listens on <http://localhost:8787>; `GET /health` answers `{"status":"ok"}`.
`pnpm dev` first applies the migrations in `migrations/` to the local D1, so the tables are
there with no other step; `pnpm test` applies them to the tests' own database.

### Secrets and settings

The Worker declares what it needs under `secrets.required` in `wrangler.jsonc`, names only:

| Name                    | What it is                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | The Stripe secret key (`sk_test_...` in a sandbox).                                                                                       |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook destination (`whsec_...`).                                                                              |
| `GITHUB_CLIENT_ID`      | The client id of Octo's GitHub OAuth App.                                                                                                 |
| `GITHUB_CLIENT_SECRET`  | A client secret of that OAuth App.                                                                                                        |
| `CHECKOUT_SUCCESS_URL`  | Where Stripe sends the customer after a payment.                                                                                          |
| `CHECKOUT_CANCEL_URL`   | Where Stripe sends the customer who leaves the Checkout without paying.                                                                   |
| `BETTER_AUTH_SECRET`    | What signs the session tokens: a random value of at least 32 bytes, made with `openssl rand -base64 32`. A token is only as strong as it. |
| `BETTER_AUTH_URL`       | The API's own public origin, such as `https://api.example.com`, or `http://localhost:8787` locally. The providers' callbacks hang on it.  |
| `APP_SIGN_IN_URL`       | Where a finished sign-in sends the browser, with `code` or `error`: the Octo app's URL, such as `octo://sign-in`. The only such place.    |
| `APPLE_CLIENT_ID`       | The identifier of Octo's Services ID at Apple.                                                                                            |
| `APPLE_TEAM_ID`         | The Team ID of the Apple Developer account.                                                                                               |
| `APPLE_KEY_ID`          | The Key ID of the Sign in with Apple key.                                                                                                 |
| `APPLE_PRIVATE_KEY`     | The content of that key's `.p8` file. The API signs Apple's client secret with it on each sign-in, so no secret of Apple's expires.       |

For local development, create a file named `.dev.vars` at the root of the repository with one
`NAME=value` per line:

```sh
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
CHECKOUT_SUCCESS_URL=https://example.com/paid
CHECKOUT_CANCEL_URL=https://example.com/canceled
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://localhost:8787
APP_SIGN_IN_URL=octo://sign-in
APPLE_CLIENT_ID=...
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

`APPLE_PRIVATE_KEY` goes on one line, between double quotes, with `\n` where the file breaks a
line. The sign-in with GitHub works without the four Apple values.

The file is ignored by git: never commit it, and never put a secret under `vars` in
`wrangler.jsonc`. Without it `pnpm dev` still starts and warns about the missing names, but
only `/health` works. The tests do not read `.dev.vars`; they run with the placeholder values
set in `vitest.config.ts`, which makes a private key for each run.

To try a sign-in by hand with no app, set `APP_SIGN_IN_URL` to a page of your own, such as
`http://localhost:8787/health`: the browser ends there with the `code` in the address bar.

To receive Stripe's events locally, let the [Stripe CLI](https://docs.stripe.com/stripe-cli)
forward them, and use the signing secret it prints as the local `STRIPE_WEBHOOK_SECRET`:

```sh
stripe listen \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed \
  --forward-to http://localhost:8787/webhooks/stripe
```

## Setup outside the repository

Nothing in the repository creates these; the API assumes they exist.

### Stripe

- **Two prices**, both recurring and on the same product: a monthly one with the lookup key
  `pro_monthly` and an annual one with the lookup key `pro_year`. The API finds a price by its
  lookup key, so no price id is configured anywhere, and the plan it stores is that key.
- **Payment methods**, enabled in the Stripe Dashboard (Settings, Payment methods): cards,
  Apple Pay, Google Pay and Link. The Checkout Session lists none, so it offers the ones the
  Dashboard has enabled.
- **A webhook destination** pointing to `https://<the Worker's host>/webhooks/stripe`, sending
  snapshot events of these six types:
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and
  `invoice.payment_failed`. Its signing secret is `STRIPE_WEBHOOK_SECRET`. Every one of these
  events makes the API fetch the customer's current state from Stripe, so duplicated and
  out-of-order deliveries are harmless; any other type is acknowledged and ignored.
- **The customer portal link**, also set up in the Dashboard: changing the card, cancelling and
  seeing invoices happen there, not through the API.
- **One subscription per customer**, a second layer under the API's own refusal: in the
  Dashboard (Settings, Checkout and Payment Links), limit customers to one subscription. Stripe
  then sends a customer who already has an `active`, `past_due`, `unpaid` or `paused`
  subscription to the customer portal instead of charging them again. It finds that customer by
  the session's customer, or else by the e-mail address, and it needs the customer portal's
  login link enabled. Nothing in the API depends on it:
  <https://docs.stripe.com/payments/checkout/limit-subscriptions>.

### GitHub

- **Octo's OAuth App.** Its client id and a client secret are `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET`. Its **authorization callback URL** is
  `https://<the Worker's host>/api/auth/callback/github`. An OAuth App has one callback URL, so
  local development needs an OAuth App of its own, pointing to
  `http://localhost:8787/api/auth/callback/github`. The API asks for the `read:user` and
  `user:email` scopes: the token only tells who the person is and their e-mail address, and the
  API keeps it nowhere.

### Apple

The sign-in with Apple goes through the browser, which needs these in the Apple Developer
account (Certificates, Identifiers & Profiles):

- **An App ID** with the Sign in with Apple capability, as the primary App ID.
- **A Services ID** grouped with that App ID, with Sign in with Apple configured. Its
  identifier is `APPLE_CLIENT_ID`. In its configuration, the Worker's host goes under the
  domains and `https://<the Worker's host>/api/auth/callback/apple` is the **return URL**.
  Apple accepts only HTTPS on a registered domain, so the sign-in with Apple cannot be tried
  on `localhost`.
- **A key** with Sign in with Apple enabled for that App ID. Its Key ID is `APPLE_KEY_ID`, the
  content of the `.p8` file Apple lets you download once is `APPLE_PRIVATE_KEY`, and the
  account's Team ID is `APPLE_TEAM_ID`.

Apple sends a person's name only at their first authorization, and the e-mail may be a private
relay address when the person hides theirs.

### Cloudflare

- **A rate limiting rule**, recommended and not required: nothing in the API depends on it. A
  sign-in has nothing to guess (no password, and the code and the token are long random
  values), so what is left to stop is a flood of requests. A rule under Security, WAF, Rate
  limiting rules refuses it before the Worker runs: match the paths that start with
  `/sign-in/` or with `/api/auth/`, count by the client's IP address, and block above a number
  of requests per 10 seconds that no person reaches, such as 20. The free plan gives one such
  rule. It needs the Worker on a domain of the Cloudflare account, since `workers.dev` has no
  rules: <https://developers.cloudflare.com/waf/rate-limiting-rules/>.

### Deploying

Set each of the thirteen names with `pnpm exec wrangler secret put <NAME>`; the key keeps its
line breaks when it is read from the file, as in
`pnpm exec wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8`. Apply the migrations
to the remote D1 with `pnpm exec wrangler d1 migrations apply DB --remote` before the first
deploy and after every new migration. The migration that brought Better Auth drops the accounts
and subscriptions that existed before it.

## Scripts

| Script               | What it does                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Applies the migrations to the local D1, then runs the Worker with `wrangler dev` on port 8787.      |
| `pnpm migrate:local` | Applies the unapplied migrations in `migrations/` to the local D1. `pnpm dev` runs it.              |
| `pnpm test`          | Runs the Vitest suite once, inside the Workers runtime.                                             |
| `pnpm check`         | Checks formatting and lint with Biome; warnings fail it too. Changes nothing.                       |
| `pnpm check:fix`     | Same check, rewriting the files with Biome's formatting and safe fixes.                             |
| `pnpm typecheck`     | Fails when `worker-configuration.d.ts` is out of date, then type-checks `src/` and `test/`.         |
| `pnpm cf-typegen`    | Regenerates `worker-configuration.d.ts` from `wrangler.jsonc`. Run it after changing the config.    |
| `pnpm deploy`        | Deploys the Worker with `wrangler deploy`. Needs a Cloudflare account and the thirteen secrets set. |

## Project layout

```text
src/index.ts                 The app: mounts the routes, handles 404 and errors
src/routes/                  One Hono instance per resource, mounted with app.route()
src/auth.ts                  Better Auth: the providers, the plugins and what it may store
src/apple.ts                 Signs the client secret Apple asks of a Services ID
src/session.ts               The Bearer-token check: the session's user, or a 401
src/accounts.ts              Reading a user's account and its subscription from D1
src/stripe.ts                The Stripe client
src/sync.ts                  Makes D1 mirror a Stripe customer's current subscription
migrations/                  D1 migrations: Better Auth's tables, `billing` and `subscriptions`
test/                        Vitest suite, with its own tsconfig
test/support/                Fakes of GitHub, Apple and Stripe, a browser, and D1 helpers
wrangler.jsonc               Worker configuration: bindings and required secrets
worker-configuration.d.ts    Generated by `pnpm cf-typegen`. Committed, never edited by hand
```

A new resource is a new file under `src/routes/` exporting a `Hono` instance, with its handlers
written inline, and one `app.route()` line in `src/index.ts`. Bindings reach the handlers
through `c.env`, typed by `CloudflareBindings`.

Better Auth's four tables (`user`, `session`, `account` and `verification`) keep its own names
and columns, in camelCase, and only Better Auth writes them. Its command line cannot reach D1,
so they are written by hand in a migration, and `test/schema.test.ts` asks Better Auth whether
any table, column or index is missing: after an upgrade of Better Auth or a new plugin, a
failure there means a new migration. Octo's own tables, `billing` and `subscriptions`, hang on
the user's id.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`: it installs
with the frozen lockfile and runs `pnpm check`, `pnpm typecheck` and `pnpm test`. It needs no
repository secret.
