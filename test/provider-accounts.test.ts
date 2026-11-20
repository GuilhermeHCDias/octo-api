import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApplePerson, fakeApple } from "./support/apple";
import {
	allProviderAccounts,
	allSessions,
	allUsers,
	databaseContents,
	emptyDatabase,
} from "./support/database";
import { fakeGitHub, type GitHubPerson } from "./support/github";
import { installFakeNetwork } from "./support/network";
import {
	API,
	appleSignIn,
	challengeOf,
	gitHubSignIn,
	newVerifier,
} from "./support/sign-in";

const OCTOCAT: GitHubPerson = {
	id: 583231,
	login: "octocat",
	name: "The Octocat",
	emails: [{ email: "cat@example.com", primary: true, verified: true }],
};

// The same person at Apple: the same e-mail address.
const CAT_AT_APPLE: ApplePerson = {
	sub: "001234.5678abcd.0912",
	email: "cat@example.com",
	name: { firstName: "The", lastName: "Octocat" },
};

let github: ReturnType<typeof fakeGitHub>;
let apple: ReturnType<typeof fakeApple>;
let challenge: string;

beforeEach(async () => {
	await emptyDatabase();
	github = fakeGitHub();
	apple = fakeApple();
	installFakeNetwork(github, apple);
	challenge = await challengeOf(newVerifier());
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a sign-in whose provider reports a verified e-mail an existing user has", () => {
	it("signs that user in and adds Apple's account to a user who came from GitHub", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);
		const [user] = await allUsers();

		const end = await appleSignIn(apple, CAT_AT_APPLE, challenge);

		expect(end.searchParams.get("code")).toMatch(/\S+/);
		expect(await allUsers()).toEqual([
			expect.objectContaining({ id: user?.id, email: "cat@example.com" }),
		]);
		expect(
			(await allProviderAccounts()).map(
				({ providerId, accountId, userId }) => ({
					providerId,
					accountId,
					userId,
				}),
			),
		).toEqual([
			{ providerId: "github", accountId: "583231", userId: user?.id },
			{
				providerId: "apple",
				accountId: "001234.5678abcd.0912",
				userId: user?.id,
			},
		]);
		expect((await allSessions()).map(({ userId }) => userId)).toEqual([
			user?.id,
			user?.id,
		]);
	});

	it("signs that user in and adds GitHub's account to a user who came from Apple", async () => {
		await appleSignIn(apple, CAT_AT_APPLE, challenge);
		const [user] = await allUsers();

		const end = await gitHubSignIn(github, OCTOCAT, challenge);

		expect(end.searchParams.get("code")).toMatch(/\S+/);
		expect(await allUsers()).toEqual([
			expect.objectContaining({ id: user?.id }),
		]);
		expect(
			(await allProviderAccounts()).map(({ providerId, userId }) => ({
				providerId,
				userId,
			})),
		).toEqual([
			{ providerId: "apple", userId: user?.id },
			{ providerId: "github", userId: user?.id },
		]);
	});

	it("matches the address whatever its capitals", async () => {
		await appleSignIn(apple, CAT_AT_APPLE, challenge);

		await gitHubSignIn(
			github,
			{
				...OCTOCAT,
				emails: [{ email: "Cat@Example.com", primary: true, verified: true }],
			},
			challenge,
		);

		expect(await allUsers()).toHaveLength(1);
		expect(await allProviderAccounts()).toHaveLength(2);
	});
});

describe("a sign-in with GitHub whose matching e-mail GitHub reports as unverified", () => {
	beforeEach(() => {
		// Better Auth logs every failed sign-in.
		for (const level of ["error", "warn", "info", "log"] as const) {
			vi.spyOn(console, level).mockImplementation(() => {});
		}
	});

	it("links nothing, opens no session and ends at APP_SIGN_IN_URL with an error and no code", async () => {
		await appleSignIn(apple, CAT_AT_APPLE, challenge);
		const before = await databaseContents();

		const end = await gitHubSignIn(
			github,
			{
				...OCTOCAT,
				emails: [{ email: "cat@example.com", primary: true, verified: false }],
			},
			challenge,
		);

		expect(end.href.split("?")[0]).toBe("octo://sign-in");
		expect(end.searchParams.get("error")).toMatch(/^\w+$/);
		expect(end.searchParams.has("code")).toBe(false);
		const after = await databaseContents();
		expect(after.users).toEqual(before.users);
		expect(after.providerAccounts).toEqual(before.providerAccounts);
		expect(after.sessions).toEqual(before.sessions);
	});

	it("is not joined later by a verified sign-in either, while the user's own address stays unverified", async () => {
		// The first user was made with an address nobody proved to own.
		await gitHubSignIn(
			github,
			{
				...OCTOCAT,
				emails: [{ email: "cat@example.com", primary: true, verified: false }],
			},
			challenge,
		);
		const before = await databaseContents();
		expect(before.users).toEqual([
			expect.objectContaining({ email: "cat@example.com", emailVerified: 0 }),
		]);

		const end = await appleSignIn(apple, CAT_AT_APPLE, challenge);

		expect(end.searchParams.get("error")).toMatch(/^\w+$/);
		expect(end.searchParams.has("code")).toBe(false);
		const after = await databaseContents();
		expect(after.providerAccounts).toEqual(before.providerAccounts);
		expect(after.sessions).toEqual(before.sessions);
	});
});

describe("the provider's tokens", () => {
	const noTokens = {
		accessToken: null,
		refreshToken: null,
		idToken: null,
		accessTokenExpiresAt: null,
		refreshTokenExpiresAt: null,
	};

	// What every token the fake providers issue begins with.
	const ISSUED_TOKENS = [
		"gho_issued_",
		"apple_access_token_",
		"apple_refresh_token_",
		// The header of an ID token of the fake.
		"eyJhbGciOiJSUzI1NiIs",
	];

	it("are not in the account row after a first sign-in with GitHub, nor after a repeated one", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);

		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({ providerId: "github", ...noTokens }),
		]);

		await gitHubSignIn(github, OCTOCAT, challenge);

		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({ providerId: "github", ...noTokens }),
		]);
		// GitHub did issue a token each time: the API used it and kept none.
		expect(
			github.requests.filter(({ url }) => url.pathname === "/user"),
		).toHaveLength(2);
	});

	it("are not in the account row after a first sign-in with Apple, nor after a repeated one", async () => {
		await appleSignIn(apple, CAT_AT_APPLE, challenge);

		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({ providerId: "apple", ...noTokens }),
		]);

		await appleSignIn(apple, CAT_AT_APPLE, challenge, { first: false });

		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({ providerId: "apple", ...noTokens }),
		]);
	});

	it("are not in the row of an account added to an existing user", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);

		await appleSignIn(apple, CAT_AT_APPLE, challenge);

		expect(await allProviderAccounts()).toEqual([
			expect.objectContaining({ providerId: "github", ...noTokens }),
			expect.objectContaining({ providerId: "apple", ...noTokens }),
		]);
	});

	it("are nowhere in D1 after sign-ins with both providers", async () => {
		await gitHubSignIn(github, OCTOCAT, challenge);
		await gitHubSignIn(github, OCTOCAT, challenge);
		await appleSignIn(apple, CAT_AT_APPLE, challenge);
		await appleSignIn(apple, CAT_AT_APPLE, challenge, { first: false });

		const stored = JSON.stringify(await databaseContents());
		for (const token of ISSUED_TOKENS) {
			expect(stored).not.toContain(token);
		}
	});
});

describe("POST /api/auth/sign-in/social, Better Auth's own start of a sign-in", () => {
	it("answers 404 and starts nothing: a sign-in starts only with a challenge", async () => {
		const response = await exports.default.fetch(
			`${API}/api/auth/sign-in/social`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: "github", callbackURL: "/" }),
			},
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not Found" });
		expect(response.headers.getSetCookie()).toEqual([]);
		expect((await databaseContents()).verifications).toEqual([]);
	});
});
