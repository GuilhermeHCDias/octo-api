// Compiled by `pnpm typecheck`, never run: it stops compiling when a secret the
// Wrangler config must declare leaves the generated CloudflareBindings type.
import { expectTypeOf } from "vitest";

expectTypeOf<CloudflareBindings["STRIPE_SECRET_KEY"]>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["STRIPE_WEBHOOK_SECRET"]
>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["GITHUB_CLIENT_ID"]>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["GITHUB_CLIENT_SECRET"]
>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["CHECKOUT_SUCCESS_URL"]
>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["CHECKOUT_CANCEL_URL"]
>().toEqualTypeOf<string>();
expectTypeOf<
	CloudflareBindings["BETTER_AUTH_SECRET"]
>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["BETTER_AUTH_URL"]>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["APP_SIGN_IN_URL"]>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["APPLE_CLIENT_ID"]>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["APPLE_TEAM_ID"]>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["APPLE_KEY_ID"]>().toEqualTypeOf<string>();
expectTypeOf<CloudflareBindings["APPLE_PRIVATE_KEY"]>().toEqualTypeOf<string>();
