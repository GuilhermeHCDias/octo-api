import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("the D1 binding DB", () => {
	it("returns the row of a SELECT 1", async () => {
		const row = await env.DB.prepare("SELECT 1 AS value").first();

		expect(row).toEqual({ value: 1 });
	});
});

describe("the R2 binding BUCKET", () => {
	it("reads back an object with the content it was written with", async () => {
		await env.BUCKET.put("greeting.txt", "hello from the scaffold");

		const object = await env.BUCKET.get("greeting.txt");

		expect(await object?.text()).toBe("hello from the scaffold");
	});
});
