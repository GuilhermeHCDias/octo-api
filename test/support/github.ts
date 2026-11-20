import { env } from "cloudflare:workers";
import type { FakeService, RecordedRequest } from "./network";

export type GitHubEmail = {
	email: string;
	primary: boolean;
	verified: boolean;
};

/** A person at GitHub, as the two endpoints Better Auth reads describe them. */
export type GitHubPerson = {
	id: number;
	login: string;
	// The display name; null when the profile has none.
	name?: string | null;
	// The public e-mail address of the profile; null when it shows none.
	publicEmail?: string | null;
	// null: the token cannot read the addresses, GitHub answers 404.
	emails: GitHubEmail[] | null;
};

type Authorization = {
	person: GitHubPerson;
	redirectUri: string;
	codeChallenge: string | null;
};

async function sha256Base64Url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * GitHub as a sign-in provider: the authorization page a browser visits, the
 * exchange of its code for a token, and the two reads of the REST API that
 * tell who the person is. It answers as GitHub does, including the 200 that
 * carries an error and the rejection of a request with no User-Agent.
 */
export function fakeGitHub() {
	const authorizations = new Map<string, Authorization>();
	const tokens = new Map<string, GitHubPerson>();
	const requests: RecordedRequest[] = [];
	let outage = false;
	let count = 0;

	async function exchangeCode(request: RecordedRequest): Promise<Response> {
		const form = new URLSearchParams(request.body);
		if (
			form.get("client_id") !== env.GITHUB_CLIENT_ID ||
			form.get("client_secret") !== env.GITHUB_CLIENT_SECRET
		) {
			return Response.json({ error: "incorrect_client_credentials" });
		}
		const code = form.get("code") ?? "";
		const authorization = authorizations.get(code);
		// As GitHub: a code is spent by its first exchange.
		authorizations.delete(code);
		if (
			!authorization ||
			form.get("redirect_uri") !== authorization.redirectUri ||
			(authorization.codeChallenge !== null &&
				(await sha256Base64Url(form.get("code_verifier") ?? "")) !==
					authorization.codeChallenge)
		) {
			return Response.json({ error: "bad_verification_code" });
		}
		count += 1;
		const token = `gho_issued_${count}`;
		tokens.set(token, authorization.person);
		return Response.json({
			access_token: token,
			token_type: "bearer",
			scope: "read:user,user:email",
		});
	}

	function personOf(request: RecordedRequest): GitHubPerson | undefined {
		const token = request.headers.get("authorization")?.slice("Bearer ".length);
		return token ? tokens.get(token) : undefined;
	}

	return {
		hosts: ["github.com", "api.github.com"],
		requests,

		/**
		 * What GitHub does when `person` approves the authorization page at
		 * `authorizationUrl`: the address it sends the browser back to, with a
		 * code and the state.
		 */
		authorize(authorizationUrl: string | URL, person: GitHubPerson): string {
			const page = new URL(authorizationUrl);
			if (
				page.origin + page.pathname !==
					"https://github.com/login/oauth/authorize" ||
				page.searchParams.get("client_id") !== env.GITHUB_CLIENT_ID
			) {
				throw new Error(
					`Not the authorization page of Octo's OAuth App: ${page}`,
				);
			}
			count += 1;
			const code = `github_code_${count}`;
			const redirectUri = page.searchParams.get("redirect_uri") ?? "";
			authorizations.set(code, {
				person,
				redirectUri,
				codeChallenge: page.searchParams.get("code_challenge"),
			});
			const back = new URL(redirectUri);
			back.searchParams.set("code", code);
			back.searchParams.set("state", page.searchParams.get("state") ?? "");
			return back.href;
		},

		/** Where GitHub sends the browser of a person who cancels the page. */
		refuse(authorizationUrl: string | URL): string {
			const page = new URL(authorizationUrl);
			const back = new URL(page.searchParams.get("redirect_uri") ?? "");
			back.searchParams.set("error", "access_denied");
			back.searchParams.set(
				"error_description",
				"The user has denied your application access.",
			);
			back.searchParams.set("state", page.searchParams.get("state") ?? "");
			return back.href;
		},

		/** Makes every later request fail with a 503. */
		goDown(): void {
			outage = true;
		},

		handle(request: RecordedRequest): Response | Promise<Response> {
			requests.push(request);
			if (outage) {
				return Response.json({ message: "Unavailable" }, { status: 503 });
			}
			const route = `${request.method} ${request.url.host}${request.url.pathname}`;
			if (route === "POST github.com/login/oauth/access_token") {
				return exchangeCode(request);
			}
			if (!request.headers.get("user-agent")) {
				return new Response(
					"Request forbidden by administrative rules. Please make sure your request has a User-Agent header.",
					{ status: 403 },
				);
			}
			if (route === "GET api.github.com/user") {
				const person = personOf(request);
				if (!person) {
					return Response.json({ message: "Bad credentials" }, { status: 401 });
				}
				return Response.json({
					id: person.id,
					login: person.login,
					name: person.name ?? null,
					email: person.publicEmail ?? null,
					avatar_url: `https://avatars.githubusercontent.com/u/${person.id}`,
				});
			}
			if (route === "GET api.github.com/user/emails") {
				const person = personOf(request);
				if (!person) {
					return Response.json({ message: "Bad credentials" }, { status: 401 });
				}
				if (!person.emails) {
					return Response.json({ message: "Not Found" }, { status: 404 });
				}
				return Response.json(person.emails);
			}
			return Response.json({ message: "Not Found" }, { status: 404 });
		},
	} satisfies FakeService & Record<string, unknown>;
}
