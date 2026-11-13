// Compiled by `pnpm typecheck`, never run: it stops compiling when a secret the
// Wrangler config must declare leaves the generated CloudflareBindings type.
import { expectTypeOf } from "vitest";

expectTypeOf<CloudflareBindings["STRIPE_SECRET_KEY"]>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["STRIPE_WEBHOOK_SECRET"]
>().toEqualTypeOf<string>();
