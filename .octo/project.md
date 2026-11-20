# Project

The Octo API: a Hono app on Cloudflare Workers (D1, R2), written in TypeScript, managed with
pnpm. `package.json` pins pnpm 12; the machine needs pnpm 11 or 12 installed (pnpm 10 cannot
switch to the pinned version) and Node 26.

## Test
`pnpm test`

Runs the Vitest suite once, inside the Workers runtime. Lint and format: `pnpm check`.
Type-check: `pnpm typecheck`.

## Run
`pnpm install && pnpm dev`
Open: http://localhost:8787/health

`pnpm dev` applies the D1 migrations in `migrations/` to the local database before it starts
the Worker. The routes beyond `/health` need the thirteen values the README lists, in `.dev.vars`; the
sign-in with GitHub works without the four of Apple.
