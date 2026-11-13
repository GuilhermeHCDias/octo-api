import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("answers 200 with the JSON body { status: 'ok' }", async () => {
		const response = await exports.default.fetch("http://example.com/health");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
