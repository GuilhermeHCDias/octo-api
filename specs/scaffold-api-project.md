# Scaffold the Octo API project
status: done
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
- [x] C1. When `pnpm install` and then `pnpm dev` run on a fresh clone with no `.dev.vars`
  file, the system shall start the Worker locally without any prompt and answer
  `GET /health` with status 200 and the JSON body `{"status":"ok"}`.
- [x] C2. When a request matches no route, the system shall answer 404 with the JSON body
  `{"error":"Not Found"}`; when a handler throws, it shall answer 500 with the JSON body
  `{"error":"Internal Server Error"}`, never exposing the error's message or stack.
- [x] C3. The Wrangler config shall declare a D1 binding `DB` and an R2 binding `BUCKET`, and a
  test running inside the Workers runtime shall prove both work: a `SELECT 1` through `DB`
  returns its row, and an object written through `BUCKET` reads back with the same content.
- [x] C4. The Wrangler config shall declare `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  as required secrets, both shall appear in the generated `CloudflareBindings` type, a committed
  `.dev.vars.example` shall list them with placeholder values, `.dev.vars` shall be ignored by
  git, and the `stripe` package shall not be a dependency.
- [x] C5. `pnpm check` shall exit 0 on the scaffold and non-zero when a file breaks Biome's
  formatting or a recommended lint rule, and `pnpm check:fix` shall rewrite the files with the
  safe fixes applied.
- [x] C6. `pnpm typecheck` shall exit 0 on the scaffold under TypeScript `strict`, and non-zero
  when the committed bindings types are out of date with the Wrangler config.
- [x] C7. `pnpm test` shall run the Vitest suite once (no watch mode) inside the Workers
  runtime and exit 0 on a fresh clone with no `.dev.vars` file, covering C1's `/health`
  response, C2's two error responses and C3's bindings.
- [x] C8. When a pull request is opened or updated, or a commit lands on `main`, a GitHub
  Actions workflow shall install with the frozen lockfile and run `pnpm check`,
  `pnpm typecheck` and `pnpm test`, failing when any of them fails and needing no repository
  secret.
- [x] C9. A `README.md` shall name the stack, the prerequisites (Node and pnpm versions), how
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

## Implementation
- - C1: proven by test/health.test.ts "GET /health > answers 200 with the JSON body { status: 'ok' }", through the Worker's default export, seen red first (404 before the route existed). `wrangler deploy --dry-run` bundles the Worker with both bindings and no prompt. `pnpm dev` itself was not launched here: it is the user's Try It, listed in the manual checks.
- - C2: proven by test/errors.test.ts, "a request that matches no route" (404) and "a handler that throws" (500, no message or stack in the body, error logged), seen red first: the 404 and 500 against Hono's text/plain defaults, the leak and log tests against a handler that answered with the stack.
- - C3: proven by test/bindings.test.ts, "the D1 binding DB > returns the row of a SELECT 1" and "the R2 binding BUCKET > reads back an object with the content it was written with", seen red first (`env.DB` and `env.BUCKET` undefined before `wrangler.jsonc` declared them).
- - C4: proven by test/bindings.types.ts, compiled by `pnpm typecheck` and seen red first (TS2339: both names missing from `CloudflareBindings` before `secrets.required` declared them), and by test/secrets.test.ts, seen red first (undefined before the test config supplied values). `git check-ignore .dev.vars` exits 0 (1 before the ignore rule) and 1 for `.dev.vars.example`; `stripe` is absent from package.json and the lockfile.
- - C5: proven by command, not by an automated test (it would test Biome itself). `pnpm check` exited 1 before the script existed and 0 on the scaffold; 1 on a probe file with broken formatting, which `pnpm check:fix` rewrote (then 0); 1 on a probe breaking `noDoubleEquals` and `noDebugger`. The probes were deleted.
- - C6: proven by command. `pnpm typecheck` exited 1 before the script existed and 0 on the scaffold; 1 with "Types at worker-configuration.d.ts are out of date" after renaming a binding in `wrangler.jsonc` without regenerating; 1 with TS7006 on a probe with an implicit `any`. The config was restored and the probe deleted.
- - C7: `pnpm test` is `vitest run` with `@cloudflare/vitest-plugin` reading `wrangler.jsonc`; 4 files, 8 tests passed after a clean `pnpm install --frozen-lockfile` with no `.dev.vars`, under Node 26.13.1 and Node 22.19.0. Wrangler prints "Missing required secrets" once per test file on such a clone: a warning only, as the spec expects.
- - C8: .github/workflows/ci.yml runs on `pull_request` and on pushes to `main`, with `contents: read` and no secret: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`, `pnpm test`. The file parses as YAML and the same four commands passed locally under Node 26.13.1, but the workflow has not run on GitHub yet: its first run is this run's pull request.
- - C9: README.md names the stack, the prerequisites (Node 26, pnpm 12), the `.dev.vars` setup from `.dev.vars.example`, and each of the seven package scripts; it passes `pnpm check`.
- - Verification: 2026-11-13, run with pnpm 12.18.0 after deleting `node_modules`, with no `.dev.vars` and stdin closed: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck` and `pnpm test` (8 passed, 0 failed) all exited 0, under Node 26.13.1 and again under Node 22.19.0. The two `curl` checks against `pnpm dev` were not run (Try It is the user's). The verify tool failed before any test ran, for the machine's setup: its pnpm 10.32.1 cannot switch to the pinned pnpm 12.18.0 ("Failed to switch pnpm ... ENOEXEC"); pnpm 11.28.9 and 12.10.0 made the switch.
- - Decision: `packageManager` pins pnpm 12.18.0, the latest stable, although the machine that built this runs pnpm 10.32.1, which cannot switch to it. Why: the spec asks for the latest stable and for `allowBuilds`, which pnpm 10 does not have. Cost if wrong: pin a pnpm 10 instead, move the approvals to `onlyBuiltDependencies` and regenerate the lockfile.
- - Decision: `engines.node` is `^26.0.0` and the CI installs `node@26`. Why: Node 26 is the active LTS since October 2026, and a caret keeps both on that major. Cost if wrong: pnpm only warns on another Node (the suite also passed on 22.19.0, and Wrangler accepts 22.12 or later), so relaxing it is a one-line change in package.json and one in the workflow.
- - Decision: wrangler 4.161.0 and @cloudflare/vitest-plugin 1.8.1, one release behind the registry's latest (4.162.0 and 1.8.2, both published hours before this run). Why: pnpm's default release-age policy holds back versions younger than a day, and the scaffold keeps that policy on. Cost if wrong: `pnpm update` a day later.
- - Decision: Biome skips `specs/` and `.octo/`, besides the generated `worker-configuration.d.ts`. Why: Biome 2.6 formats Markdown and would rewrite the spec and the project file, which Octo owns and edits. Cost if wrong: drop the two entries from `files.includes` in biome.json and run `pnpm check:fix`.
- - Decision: the error handler logs the error with `console.error` and answers 500 for every thrown error, Hono's `HTTPException` included. Why: C2 asks for 500 whenever a handler throws, and without the log a failure would leave no trace. Cost if wrong: the first spec that throws `HTTPException` (auth, validation) adds a branch returning `error.getResponse()`, with its test.
- - Decision: the tests get the two secrets as placeholder values from `miniflare.bindings` in vitest.config.ts, which override a local `.dev.vars` (checked with one in place). Why: a fresh clone and the CI have none, and a developer's real Stripe keys must never reach a test. Cost if wrong: remove the block and the tests read `.dev.vars` again.
- - Decision: test/errors.test.ts registers its throwing route on the app imported from src/index.ts, before any request. Why: it exercises the real app's error handler with no test-only route or factory in production code; Vitest gives each test file its own module graph, and the suite passed with files shuffled and run in sequence. Cost if wrong: move the app's construction to a factory the test calls.
- - Decision: the CI sets up pnpm and Node with `pnpm/setup` v3.2.0, pinned by commit, with `install: false` and an explicit `pnpm install --frozen-lockfile` step. Why: it is the action pnpm's CI guide now recommends, it reads the pnpm version from `packageManager`, and the explicit step makes the frozen lockfile visible. Cost if wrong: swap it for `pnpm/action-setup` plus `actions/setup-node`.
- - Machine setup: 2026-11-13, at the user's request, Homebrew's pnpm went from 10.32.1 to 12.18.0, the pinned version, with no change to the code. With it, `pnpm install --frozen-lockfile`, `pnpm check` and `pnpm typecheck` exited 0 and the verify tool passed (8 passed, 0 failed), under the machine's Node 22.19.0.
