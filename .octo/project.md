# Project

The Octo API: a Hono app on Cloudflare Workers (D1, R2), written in TypeScript, managed with
pnpm.

## Test
`pnpm test`

Runs the Vitest suite once, inside the Workers runtime. Lint and format: `pnpm check`.
Type-check: `pnpm typecheck`.

## Run
`pnpm install && pnpm dev`
Open: http://localhost:8787/health
