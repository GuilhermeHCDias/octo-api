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
