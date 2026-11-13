# Scaffold the Octo API project
status: todo
created: 2026-11-13
type: feat
depends-on: none

## Goal
Turn the empty repository into a working boilerplate for the Octo API: a TypeScript Hono app
running on Cloudflare Workers, configured for D1 and R2, with Biome as formatter and linter and
an automated test suite. Done means a developer can clone, install, run the API locally, and
get green lint, type-check and tests, so the next specs (Stripe integration, account storage)
only add features, never tooling.

## Context
- The repository holds a single empty commit: no code, no README, no instruction files. Every
  file of the scaffold is new.
- The API will later integrate with Stripe and store account data in D1 and files in R2. This
  spec builds only the configuration and the skeleton they will land on.
- Docs that decide the conventions (follow them over habit; they changed recently):
  - Hono on Cloudflare Workers: https://hono.dev/docs/getting-started/cloudflare-workers.
    Entry point `src/index.ts` exporting the app as default; bindings reach handlers through
    `c.env`; generate the bindings type with `wrangler types --env-interface CloudflareBindings`
    (the flag avoids a clash with Hono's own `Env`) and pass it as
    `new Hono<{ Bindings: CloudflareBindings }>()`.
  - Hono best practices: https://hono.dev/docs/guides/best-practices. No Rails-like
    controllers: handlers are written inline with their routes, and the app grows by one Hono
    instance per resource file mounted with `app.route()`.
  - Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/.
    `wrangler.jsonc` is the recommended format for new projects; `name`, `main` and
    `compatibility_date` are required; D1 and R2 bindings may omit `database_id` and
    `bucket_name`, and Wrangler provisions the resources on the first deploy and writes the ids
    back; local secrets live in `.dev.vars`, never in `vars`.
  - TypeScript on Workers: https://developers.cloudflare.com/workers/languages/typescript/.
    Types come from `wrangler types` (not `@cloudflare/workers-types`); the generated file is
    committed and never edited by hand.
  - Testing: https://developers.cloudflare.com/workers/testing/vitest-integration/. Both Hono
    and Cloudflare recommend Vitest with `@cloudflare/vitest-plugin` (Vitest 4.1 or later),
    which runs the tests inside the Workers runtime with the bindings of `wrangler.jsonc`.
  - Biome: https://biomejs.dev/guides/getting-started/. Biome v2, version pinned exactly,
    configured in `biome.json`; `biome check` covers format and lint in one command.
  - Secrets: https://developers.cloudflare.com/workers/configuration/secrets/. The
    `secrets.required` list in the Wrangler config declares the secret names the Worker needs:
    it is the source of truth for type generation, makes `wrangler deploy` fail when one is not
    set, and only warns in local dev when one is missing from `.dev.vars`.
  - pnpm build settings: https://pnpm.io/settings/build. Current pnpm fails the install with
    `ERR_PNPM_IGNORED_BUILDS` when a dependency has a build script nobody reviewed; the reviewed
    ones are listed under `allowBuilds` in `pnpm-workspace.yaml`. Wrangler's toolchain brings
    such dependencies (esbuild, workerd and the like).
- The test and run commands live in `.octo/project.md`.

## Acceptance criteria
- [ ] C1. When `pnpm install` and then `pnpm dev` run on a fresh clone with no `.dev.vars`
  file, the system shall start the Worker locally without any prompt and answer
  `GET /health` with status 200 and the JSON body `{"status":"ok"}`.
- [ ] C2. When a request matches no route, the system shall answer 404 with the JSON body
  `{"error":"Not Found"}`; when a handler throws, it shall answer 500 with the JSON body
  `{"error":"Internal Server Error"}`, never exposing the error's message or stack.
- [ ] C3. The Wrangler config shall declare a D1 binding `DB` and an R2 binding `BUCKET`, and a
  test running inside the Workers runtime shall prove both work: a `SELECT 1` through `DB`
  returns its row, and an object written through `BUCKET` reads back with the same content.
- [ ] C4. The Wrangler config shall declare `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  as required secrets, both shall appear in the generated `CloudflareBindings` type, a committed
  `.dev.vars.example` shall list them with placeholder values, `.dev.vars` shall be ignored by
  git, and the `stripe` package shall not be a dependency.
- [ ] C5. `pnpm check` shall exit 0 on the scaffold and non-zero when a file breaks Biome's
  formatting or a recommended lint rule, and `pnpm check:fix` shall rewrite the files with the
  safe fixes applied.
- [ ] C6. `pnpm typecheck` shall exit 0 on the scaffold under TypeScript `strict`, and non-zero
  when the committed bindings types are out of date with the Wrangler config.
- [ ] C7. `pnpm test` shall run the Vitest suite once (no watch mode) inside the Workers
  runtime and exit 0 on a fresh clone with no `.dev.vars` file, covering C1's `/health`
  response, C2's two error responses and C3's bindings.
- [ ] C8. When a pull request is opened or updated, or a commit lands on `main`, a GitHub
  Actions workflow shall install with the frozen lockfile and run `pnpm check`,
  `pnpm typecheck` and `pnpm test`, failing when any of them fails and needing no repository
  secret.
- [ ] C9. A `README.md` shall name the stack, the prerequisites (Node and pnpm versions), how
  to set up `.dev.vars` from the example, and what each package script does.

## Out of scope
- Any Stripe code: the SDK, a client, webhooks, checkout. Only the two secret names exist.
- Any D1 schema, migration, migrations folder or ORM, and any route that reads or writes D1 or
  R2. The account tables arrive with the spec that defines their fields.
- Deploying: creating the Cloudflare resources, a deploy workflow, API tokens, custom domains,
  and staging or production environments. The `deploy` script exists but nothing runs it.
- Authentication, CORS, rate limiting, request validation, OpenAPI, RPC client types and
  structured logging.

## Decisions & assumptions
- pnpm is the package manager, pinned through `packageManager` in `package.json`, with the
  lockfile committed and the builds Wrangler's toolchain needs approved under `allowBuilds`
  → C1, C8. Why: the user picked pnpm; the pin keeps every machine and the CI on one version,
  and without the approvals a fresh install fails or stops to ask.
- Only the bindings for D1 and R2, with `database_id` and `bucket_name` left out → C3. Why: the
  user picked bindings only; leaving the ids out lets Wrangler provision the resources on the
  first deploy, so the scaffold needs no Cloudflare account, and local dev and tests use the
  local simulation.
- Binding names `DB` and `BUCKET`, Worker name `octo-api` → C3. Why: assumption; they are the
  names Cloudflare's and Hono's docs use, and one database and one bucket are all the brief
  names.
- Stripe enters only as the two secret names, declared with `secrets.required` → C4. Why: the
  user picked secrets only; declaring them in the config types them without depending on an
  untracked `.dev.vars`, so the generated types are the same on every machine and in CI.
  Deploying will fail until both are set, which is the intended guard.
- Nothing in the scaffold reads the secrets, and the tests supply their own values where the
  runtime needs them → C1, C7. Why: a fresh clone and the CI have no `.dev.vars`.
- `.dev.vars` for local secrets, never `.env` → C4. Why: Cloudflare says to use one or the
  other, and `.dev.vars` is Wrangler's own.
- Vitest with `@cloudflare/vitest-plugin`, reading `wrangler.jsonc` → C3, C7. Why: both Hono
  and Cloudflare recommend it, and it tests against the real bindings instead of hand-made
  mocks.
- The bindings type is generated as `CloudflareBindings`, committed, excluded from Biome, and
  checked for staleness inside `pnpm typecheck` → C4, C6. Why: Cloudflare recommends
  committing it and checking it in CI; a stale type hides a missing binding until runtime.
- Routes live one Hono instance per file under `src/routes/`, mounted with `app.route()` in
  `src/index.ts`; `/health` is the first. Tests live under `test/` with their own tsconfig
  → C1, C2. Why: Hono's best practices and Cloudflare's test setup; the layout is what later
  specs copy.
- Scripts: `dev`, `deploy`, `test`, `check`, `check:fix`, `typecheck` and `cf-typegen` (the
  name Hono's template gives to type generation) → C5, C6, C7, C9.
- Biome keeps its defaults: recommended rules and its own formatting style, honoring
  `.gitignore` → C5. Why: assumption; no style was asked for, and defaults need no upkeep.
- One default Wrangler environment, plain `wrangler dev` (no Vite plugin), observability
  enabled, no `nodejs_compat` flag, `compatibility_date` set to the day of implementation,
  latest stable versions of every dependency, and the active Node LTS pinned in `engines` and
  used by the CI → C1, C8. Why: assumptions; each is the docs' default for a new Worker, and a
  flag or an environment is added by the spec that first needs it.
- The CI only verifies → C8. Why: the user picked lint, types and tests; deploying needs
  Cloudflare credentials the repository does not have yet.

## Verification
- On a fresh clone with no `.dev.vars`: `pnpm install` finishes without a prompt, `pnpm check`,
  `pnpm typecheck` and `pnpm test` all exit 0, and with `pnpm dev` running,
  `curl -i http://localhost:8787/health` returns 200 with `{"status":"ok"}` while
  `curl -i http://localhost:8787/nope` returns 404 with `{"error":"Not Found"}`.
