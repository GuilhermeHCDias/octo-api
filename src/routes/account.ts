import { Hono } from "hono";
import { accountBody, findAccount } from "../accounts";
import { type AuthenticatedEnv, requireUser } from "../session";

const account = new Hono<AuthenticatedEnv>();

// The account exists from the sign-in, so there is nothing to create here:
// every signed-in user gets an answer, with no access until they pay.
account.get("/", requireUser, async (c) => {
	const found = await findAccount(c.env.DB, c.var.user.id);
	if (!found) {
		throw new Error(`User ${c.var.user.id} has a session and no row`);
	}
	return c.json(accountBody(found));
});

export default account;
