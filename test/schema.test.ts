import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import firstMigration from "../migrations/0001_create_accounts_and_subscriptions.sql?raw";
import secondMigration from "../migrations/0002_add_checkout_session_id_to_accounts.sql?raw";
import { createAuth } from "../src/auth";

async function columnsOf(table: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT name FROM pragma_table_info(?)",
	)
		.bind(table)
		.all<{ name: string }>();
	return results.map((column) => column.name);
}

const NOW = "2026-11-20T00:00:00.000Z";

function insertUser(id: string, email: string) {
	return env.DB.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
	)
		.bind(id, id, email, NOW, NOW)
		.run();
}

function insertBilling(userId: string, stripeCustomerId: string | null) {
	return env.DB.prepare(
		"INSERT INTO billing (user_id, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
	)
		.bind(userId, stripeCustomerId, NOW, NOW)
		.run();
}

describe("the local D1 the tests run against", () => {
	it("no longer has the tables keyed on the GitHub user, dropped by a migration of its own", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
		).all<{ name: string }>();

		expect(results.map(({ name }) => name)).toEqual([
			"account",
			"billing",
			"session",
			"subscriptions",
			"user",
			"verification",
		]);
		expect(await columnsOf("subscriptions")).not.toContain("github_user_id");
		// The two earlier migrations stay as they were applied.
		expect(firstMigration).toContain("CREATE TABLE accounts");
		expect(firstMigration).toContain("github_user_id INTEGER PRIMARY KEY");
		expect(secondMigration).toContain(
			"ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;",
		);
	});

	it("has every table, column and index Better Auth asks for", async () => {
		const migrations = await getMigrations(createAuth(env).options);

		expect(migrations.toBeCreated).toEqual([]);
		expect(migrations.toBeAdded).toEqual([]);
		expect(migrations.toBeAddedIndexes).toEqual([]);
		expect(migrations.unsafeChanges).toEqual([]);
		expect(migrations.schemaProblems).toEqual([]);
	});

	it("has Better Auth's four tables with its own column names", async () => {
		expect(await columnsOf("user")).toEqual([
			"id",
			"name",
			"email",
			"emailVerified",
			"image",
			"createdAt",
			"updatedAt",
		]);
		expect(await columnsOf("session")).toEqual([
			"id",
			"expiresAt",
			"token",
			"createdAt",
			"updatedAt",
			"ipAddress",
			"userAgent",
			"userId",
		]);
		expect(await columnsOf("account")).toEqual([
			"id",
			"accountId",
			"providerId",
			"userId",
			"accessToken",
			"refreshToken",
			"idToken",
			"accessTokenExpiresAt",
			"refreshTokenExpiresAt",
			"scope",
			"password",
			"createdAt",
			"updatedAt",
		]);
		expect(await columnsOf("verification")).toEqual([
			"id",
			"identifier",
			"value",
			"expiresAt",
			"createdAt",
			"updatedAt",
		]);
	});

	it("has the billing table with the fields of the spec", async () => {
		expect(await columnsOf("billing")).toEqual([
			"user_id",
			"stripe_customer_id",
			"billing_email",
			"checkout_session_id",
			"created_at",
			"updated_at",
		]);
	});

	it("has the subscriptions table with the fields it had, keyed on the user", async () => {
		expect(await columnsOf("subscriptions")).toEqual([
			"user_id",
			"stripe_subscription_id",
			"status",
			"plan",
			"current_period_end",
			"cancel_at_period_end",
			"updated_at",
		]);
	});

	it("keeps one user per e-mail address", async () => {
		await insertUser("user_schema_1", "same@example.com");

		await expect(
			insertUser("user_schema_2", "same@example.com"),
		).rejects.toThrow(/UNIQUE/);
	});

	it("keeps one billing row per user and one per Stripe customer, and none without a user", async () => {
		await insertUser("user_schema_3", "three@example.com");
		await insertUser("user_schema_4", "four@example.com");
		await insertBilling("user_schema_3", "cus_schema");

		await expect(insertBilling("user_schema_3", null)).rejects.toThrow(
			/UNIQUE/,
		);
		await expect(insertBilling("user_schema_4", "cus_schema")).rejects.toThrow(
			/UNIQUE/,
		);
		await expect(insertBilling("user_nobody", null)).rejects.toThrow(
			/FOREIGN KEY/,
		);
	});

	it("keeps at most one subscription per user, and none without a billing row", async () => {
		await insertUser("user_schema_5", "five@example.com");
		await insertUser("user_schema_6", "six@example.com");
		await insertBilling("user_schema_5", null);
		const insert = env.DB.prepare(
			"INSERT INTO subscriptions (user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		await insert
			.bind("user_schema_5", "sub_one", "active", "pro_monthly", NOW, 0, NOW)
			.run();

		await expect(
			insert
				.bind("user_schema_5", "sub_two", "active", "pro_year", NOW, 0, NOW)
				.run(),
		).rejects.toThrow(/UNIQUE/);
		// A user who has no billing row yet.
		await expect(
			insert
				.bind("user_schema_6", "sub_orphan", "active", "pro_year", NOW, 0, NOW)
				.run(),
		).rejects.toThrow(/FOREIGN KEY/);
	});
});
