import { env } from "cloudflare:workers";
import type { FakeService, RecordedRequest } from "./network";

export type GitHubEmail = {
	email: string;
	primary: boolean;
	verified: boolean;
};

type IssuedToken = {
	user: { id: number; login: string };
	// null: the token was issued without the `user:email` scope.
	emails: GitHubEmail[] | null;
};

/**
 * GitHub's REST API as the Worker uses it: "check a token" of Octo's OAuth
 * App and the list of the user's e-mail addresses. It answers as GitHub does,
 * including the rejection of a request with no User-Agent.
 */
export function fakeGitHub() {
	const tokens = new Map<string, IssuedToken>();
	const requests: RecordedRequest[] = [];
	let outage = false;

	const appCredentials = `Basic ${btoa(
		`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`,
	)}`;

	function checkToken(request: RecordedRequest): Response {
		if (request.headers.get("authorization") !== appCredentials) {
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		}
		const { access_token } = JSON.parse(request.body) as {
			access_token: string;
		};
		const issued = tokens.get(access_token);
		if (!issued) {
			return Response.json({ message: "Not Found" }, { status: 404 });
		}
		return Response.json({
			id: 1,
			token: access_token,
			scopes: issued.emails ? ["user:email"] : [],
			user: issued.user,
		});
	}

	function listEmails(request: RecordedRequest): Response {
		const token = request.headers.get("authorization")?.slice("Bearer ".length);
		const issued = token ? tokens.get(token) : undefined;
		if (!issued) {
			return Response.json({ message: "Bad credentials" }, { status: 401 });
		}
		if (!issued.emails) {
			return Response.json({ message: "Not Found" }, { status: 404 });
		}
		return Response.json(issued.emails);
	}

	return {
		host: "api.github.com",
		requests,

		/** Makes `token` one that GitHub issued to Octo's OAuth App for `user`. */
		issueToken(
			token: string,
			user: { id: number; login: string },
			emails: GitHubEmail[] | null = [],
		): void {
			tokens.set(token, { user, emails });
		},

		/** Makes every later request fail with a 503. */
		goDown(): void {
			outage = true;
		},

		handle(request: RecordedRequest): Response {
			requests.push(request);
			if (outage) {
				return Response.json({ message: "Unavailable" }, { status: 503 });
			}
			if (!request.headers.get("user-agent")) {
				return new Response(
					"Request forbidden by administrative rules. Please make sure your request has a User-Agent header.",
					{ status: 403 },
				);
			}
			const route = `${request.method} ${request.url.pathname}`;
			if (route === `POST /applications/${env.GITHUB_CLIENT_ID}/token`) {
				return checkToken(request);
			}
			if (route === "GET /user/emails") return listEmails(request);
			return Response.json({ message: "Not Found" }, { status: 404 });
		},
	} satisfies FakeService & Record<string, unknown>;
}
