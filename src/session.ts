import { createMiddleware } from "hono/factory";
import { createAuth } from "./auth";

/** The Octo account of a request, as Better Auth's session names it. */
export type User = { id: string; email: string; name: string };

/** The environment of a route behind `requireUser`. */
export type AuthenticatedEnv = {
	Bindings: CloudflareBindings;
	Variables: { user: User };
};

/**
 * Answers 401 unless the request carries `Authorization: Bearer` with the
 * signed token of a live session, the one `POST /sign-in/token` gives; the
 * routes after it read the user from `c.var.user`. The session is read from
 * D1 on every call, so a sign-out ends it at once, and no provider is asked.
 *
 * Better Auth gets the Authorization header and nothing else of the request:
 * a cookie never signs a request in.
 */
export const requireUser = createMiddleware<AuthenticatedEnv>(
	async (c, next) => {
		const authorization = c.req.header("Authorization");
		const session = authorization
			? await createAuth(c.env).api.getSession({
					headers: new Headers({ Authorization: authorization }),
				})
			: null;
		if (!session) return c.json({ error: "Unauthorized" }, 401);

		const { id, email, name } = session.user;
		c.set("user", { id, email, name });
		await next();
	},
);
