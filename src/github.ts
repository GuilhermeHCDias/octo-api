import { createMiddleware } from "hono/factory";

export type GitHubUser = { id: number; login: string };

/** The environment of a route behind `requireGitHubUser`. */
export type AuthenticatedEnv = {
	Bindings: CloudflareBindings;
	Variables: { githubUser: GitHubUser; githubToken: string };
};

const GITHUB_API = "https://api.github.com";

// GitHub rejects a request that has no User-Agent.
const GITHUB_HEADERS = {
	Accept: "application/vnd.github+json",
	"User-Agent": "octo-api",
};

/**
 * Asks GitHub's "check a token" whether `token` was issued to Octo's OAuth
 * App, and for whom. Null when GitHub does not recognize it. Errors never
 * carry the token: they end up in the logs.
 */
async function checkToken(
	env: CloudflareBindings,
	token: string,
): Promise<GitHubUser | null> {
	const response = await fetch(
		`${GITHUB_API}/applications/${env.GITHUB_CLIENT_ID}/token`,
		{
			method: "POST",
			headers: {
				...GITHUB_HEADERS,
				Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ access_token: token }),
		},
	);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`GitHub answered ${response.status} to the token check`);
	}
	const { user } = await response.json<{ user: GitHubUser | null }>();
	return user ? { id: user.id, login: user.login } : null;
}

/**
 * The user's primary verified e-mail address, read with their own token.
 * Null when they have none, or when the token lacks the `user:email` scope
 * (GitHub then answers 403 or 404): a missing e-mail does not block a login.
 */
export async function primaryVerifiedEmail(
	token: string,
): Promise<string | null> {
	const response = await fetch(`${GITHUB_API}/user/emails?per_page=100`, {
		headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
	});
	if (response.status === 403 || response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`GitHub answered ${response.status} to the e-mail list`);
	}
	const emails =
		await response.json<
			{ email: string; primary: boolean; verified: boolean }[]
		>();
	return (
		emails.find(({ primary, verified }) => primary && verified)?.email ?? null
	);
}

/**
 * Answers 401 unless the request carries a Bearer token that GitHub confirms
 * was issued to Octo's OAuth App; the routes after it read the user from
 * `c.var.githubUser`. The token is checked on every call and stored nowhere.
 */
export const requireGitHubUser = createMiddleware<AuthenticatedEnv>(
	async (c, next) => {
		const token = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
		const user = token ? await checkToken(c.env, token) : null;
		if (!token || !user) return c.json({ error: "Unauthorized" }, 401);

		c.set("githubUser", user);
		c.set("githubToken", token);
		await next();
	},
);
