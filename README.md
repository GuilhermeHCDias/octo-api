# Octo API

The API behind Octo. It is where an Octo account pays and where its payment status is read: an
account is the user's GitHub identity, Stripe takes the payment on a hosted Checkout, Stripe's
webhooks keep the account's subscription current in D1, and the API answers whether the account
has access.

## Routes

| Route                   | What it does                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`           | Answers `{"status":"ok"}`.                                                                                                                                                                                                                                                                                                   |
| `PUT /account`          | Creates the caller's account, or refreshes its GitHub login and e-mail. The app calls it at every login.                                                                                                                                                                                                                     |
| `GET /account`          | The caller's account: `github_user_id`, `github_login`, `access` and `subscription`. Reads D1 only; 404 when there is no account.                                                                                                                                                                                            |
| `POST /checkout`        | Body `{"plan":"pro_monthly"}` or `{"plan":"pro_year"}`. Creates a Stripe Checkout Session and answers `{"url":"..."}`. Opening a Checkout expires the account's previous one, so only the last one can be paid. 409 when the account already has a live subscription, even from a payment the webhook has not delivered yet. |
| `POST /webhooks/stripe` | Stripe's webhook: verifies the signature, then makes D1 mirror the customer's current subscription.                                                                                                                                                                                                                          |

`/account` and `/checkout` need `Authorization: Bearer <token>`, where the token is a GitHub
token issued to Octo's OAuth App. The API confirms it with GitHub on every call, stores it
nowhere and answers 401 `{"error":"Unauthorized"}` to anything else. `access` is true while the
subscription is `active`, `trialing` or `past_due`.

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
The tests need no Stripe or GitHub account either: they never reach the network.

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

| Name                    | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | The Stripe secret key (`sk_test_...` in a sandbox).                     |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook destination (`whsec_...`).            |
| `GITHUB_CLIENT_ID`      | The client id of Octo's GitHub OAuth App.                               |
| `GITHUB_CLIENT_SECRET`  | A client secret of that OAuth App.                                      |
| `CHECKOUT_SUCCESS_URL`  | Where Stripe sends the customer after a payment.                        |
| `CHECKOUT_CANCEL_URL`   | Where Stripe sends the customer who leaves the Checkout without paying. |

For local development, create a file named `.dev.vars` at the root of the repository with one
`NAME=value` per line:

```sh
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
CHECKOUT_SUCCESS_URL=https://example.com/paid
CHECKOUT_CANCEL_URL=https://example.com/canceled
```

The file is ignored by git: never commit it, and never put a secret under `vars` in
`wrangler.jsonc`. Without it `pnpm dev` still starts and warns about the missing names, but
only `/health` works. The tests do not read `.dev.vars`; they run with the placeholder values
set in `vitest.config.ts`.

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
  `GITHUB_CLIENT_SECRET`. The Octo app asks the user to authorize it with the `user:email`
  scope and nothing else: the token only identifies the user and lets the API read their
  primary verified e-mail address. The API accepts no token issued to any other app.

### Deploying

Set each of the six names with `pnpm exec wrangler secret put <NAME>`, and apply the migrations
to the remote D1 with `pnpm exec wrangler d1 migrations apply DB --remote` before the first
deploy and after every new migration.

## Scripts

| Script               | What it does                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`           | Applies the migrations to the local D1, then runs the Worker with `wrangler dev` on port 8787.   |
| `pnpm migrate:local` | Applies the unapplied migrations in `migrations/` to the local D1. `pnpm dev` runs it.           |
| `pnpm test`          | Runs the Vitest suite once, inside the Workers runtime.                                          |
| `pnpm check`         | Checks formatting and lint with Biome; warnings fail it too. Changes nothing.                    |
| `pnpm check:fix`     | Same check, rewriting the files with Biome's formatting and safe fixes.                          |
| `pnpm typecheck`     | Fails when `worker-configuration.d.ts` is out of date, then type-checks `src/` and `test/`.      |
| `pnpm cf-typegen`    | Regenerates `worker-configuration.d.ts` from `wrangler.jsonc`. Run it after changing the config. |
| `pnpm deploy`        | Deploys the Worker with `wrangler deploy`. Needs a Cloudflare account and the six secrets set.   |

## Project layout

```text
src/index.ts                 The app: mounts the routes, handles 404 and errors
src/routes/                  One Hono instance per resource, mounted with app.route()
src/github.ts                The Bearer-token check with GitHub, and the user's e-mail
src/accounts.ts              Reading an account and its subscription from D1
src/stripe.ts                The Stripe client
src/sync.ts                  Makes D1 mirror a Stripe customer's current subscription
migrations/                  D1 migrations: the tables `accounts` and `subscriptions`
test/                        Vitest suite, with its own tsconfig
test/support/                Fakes of GitHub's and Stripe's APIs, and D1 helpers
wrangler.jsonc               Worker configuration: bindings and required secrets
worker-configuration.d.ts    Generated by `pnpm cf-typegen`. Committed, never edited by hand
```

A new resource is a new file under `src/routes/` exporting a `Hono` instance, with its handlers
written inline, and one `app.route()` line in `src/index.ts`. Bindings reach the handlers
through `c.env`, typed by `CloudflareBindings`.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`: it installs
with the frozen lockfile and runs `pnpm check`, `pnpm typecheck` and `pnpm test`. It needs no
repository secret.
