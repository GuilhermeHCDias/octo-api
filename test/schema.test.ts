import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import firstMigration from "../migrations/0001_create_accounts_and_subscriptions.sql?raw";

async function columnsOf(table: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT name FROM pragma_table_info(?)",
	)
		.bind(table)
		.all<{ name: string }>();
	return results.map((column) => column.name);
}

describe("the local D1 the tests run against", () => {
	it("has the accounts table with the fields of the spec", async () => {
		expect(await columnsOf("accounts")).toEqual([
			"github_user_id",
			"github_login",
			"github_email",
			"stripe_customer_id",
			"billing_email",
			"created_at",
			"updated_at",
			"checkout_session_id",
		]);
	});

	it("lets an account have no Checkout Session, and adds the column in a migration of its own", async () => {
		const column = await env.DB.prepare(
			"SELECT type, \"notnull\" AS required FROM pragma_table_info('accounts') WHERE name = 'checkout_session_id'",
		).first<{ type: string; required: number }>();

		expect(column).toEqual({ type: "TEXT", required: 0 });
		expect(firstMigration).toContain("CREATE TABLE accounts");
		expect(firstMigration).not.toContain("checkout_session_id");
	});

	it("has the subscriptions table with the fields of the spec", async () => {
		expect(await columnsOf("subscriptions")).toEqual([
			"github_user_id",
			"stripe_subscription_id",
			"status",
			"plan",
			"current_period_end",
			"cancel_at_period_end",
			"updated_at",
		]);
	});

	it("keeps one account per GitHub user and one per Stripe customer", async () => {
		const insert = env.DB.prepare(
			"INSERT INTO accounts (github_user_id, github_login, stripe_customer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		const now = "2026-11-14T00:00:00.000Z";
		await insert.bind(9001, "first", "cus_schema", now, now).run();

		await expect(
			insert.bind(9001, "same-user", null, now, now).run(),
		).rejects.toThrow(/UNIQUE/);
		await expect(
			insert.bind(9002, "same-customer", "cus_schema", now, now).run(),
		).rejects.toThrow(/UNIQUE/);
	});

	it("keeps at most one subscription per account, and none without one", async () => {
		const now = "2026-11-14T00:00:00.000Z";
		await env.DB.prepare(
			"INSERT INTO accounts (github_user_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?)",
		)
			.bind(9003, "subscriber", now, now)
			.run();
		const insert = env.DB.prepare(
			"INSERT INTO subscriptions (github_user_id, stripe_subscription_id, status, plan, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		await insert
			.bind(9003, "sub_one", "active", "pro_monthly", now, 0, now)
			.run();

		await expect(
			insert.bind(9003, "sub_two", "active", "pro_year", now, 0, now).run(),
		).rejects.toThrow(/UNIQUE/);
		await expect(
			insert.bind(9999, "sub_orphan", "active", "pro_year", now, 0, now).run(),
		).rejects.toThrow(/FOREIGN KEY/);
	});
});
