import { Hono } from "hono";
import { accountBody, findAccount } from "../accounts";
import {
	type AuthenticatedEnv,
	primaryVerifiedEmail,
	requireGitHubUser,
} from "../github";

const account = new Hono<AuthenticatedEnv>();

account.use(requireGitHubUser);

// Called by the app at every login: creates the account, or refreshes the
// identity data of the one that exists. Never touches Stripe's side of it.
account.put("/", async (c) => {
	const { id, login } = c.var.githubUser;
	const email = await primaryVerifiedEmail(c.var.githubToken);
	const now = new Date().toISOString();

	await c.env.DB.prepare(
		`INSERT INTO accounts (github_user_id, github_login, github_email, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?4)
		ON CONFLICT (github_user_id) DO UPDATE SET
			github_login = excluded.github_login,
			github_email = excluded.github_email,
			updated_at = excluded.updated_at`,
	)
		.bind(id, login, email, now)
		.run();

	const saved = await findAccount(c.env.DB, id);
	if (!saved)
		throw new Error(`Account ${id} is missing right after its upsert`);
	return c.json(accountBody(saved));
});

account.get("/", async (c) => {
	const found = await findAccount(c.env.DB, c.var.githubUser.id);
	if (!found) return c.json({ error: "Account not found" }, 404);
	return c.json(accountBody(found));
});

export default account;
