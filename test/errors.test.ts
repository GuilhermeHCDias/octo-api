import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

// The scaffold has no route that fails, so this file registers one on its own
// copy of the app (each test file loads its own module graph), before any
// request builds the router.
const failure = new Error("database password is hunter2");
app.get("/__test/throws", () => {
	throw failure;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a request that matches no route", () => {
	it("answers 404 with the JSON body { error: 'Not Found' }", async () => {
		const response = await exports.default.fetch("http://example.com/nope");

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ error: "Not Found" });
	});
});

describe("a handler that throws", () => {
	it("answers 500 with the JSON body { error: 'Internal Server Error' }", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await app.request("/__test/throws", {}, env);

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ error: "Internal Server Error" });
	});

	it("keeps the error's message and stack out of the response", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await app.request("/__test/throws", {}, env);
		const body = await response.text();

		expect(body).not.toContain("hunter2");
		expect(body).not.toContain("errors.test");
	});

	it("logs the error so the failure can be diagnosed", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		await app.request("/__test/throws", {}, env);

		expect(logged).toHaveBeenCalledWith(failure);
	});
});
