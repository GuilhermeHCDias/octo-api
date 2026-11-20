import { exports } from "cloudflare:workers";

/**
 * A browser, as far as a sign-in needs one: it keeps the cookies the API sets
 * and sends them back, and it follows no redirect by itself, so that a test
 * sees every step. `alwaysSent` are headers that go with every request, such
 * as the ones Cloudflare adds in front of the Worker.
 */
export function openBrowser(alwaysSent: Record<string, string> = {}) {
	const cookies = new Map<string, string>();

	async function send(url: string, init: RequestInit): Promise<Response> {
		const headers = new Headers({ ...alwaysSent, ...init.headers });
		headers.set("User-Agent", "Mozilla/5.0 (Macintosh) Safari/605.1.15");
		if (cookies.size > 0) {
			headers.set(
				"Cookie",
				[...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
			);
		}
		const response = await exports.default.fetch(url, {
			...init,
			headers,
			redirect: "manual",
		});
		for (const line of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = line.split(";");
			const name = pair.slice(0, pair.indexOf("=")).trim();
			const value = pair.slice(pair.indexOf("=") + 1).trim();
			const expired = attributes.some((attribute) => {
				const [key = "", setting = ""] = attribute.trim().split("=");
				return (
					(key.toLowerCase() === "max-age" && Number(setting) <= 0) ||
					(key.toLowerCase() === "expires" && Date.parse(setting) <= Date.now())
				);
			});
			if (expired) cookies.delete(name);
			else cookies.set(name, value);
		}
		return response;
	}

	return {
		/** The cookies the browser holds now, by name. */
		cookies,

		get(url: string): Promise<Response> {
			return send(url, { method: "GET" });
		},

		/** Posts a form, as the page of `origin` makes the browser do. */
		post(
			url: string,
			form: URLSearchParams,
			origin: string,
		): Promise<Response> {
			return send(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: origin,
				},
				body: form.toString(),
			});
		},
	};
}

export type Browser = ReturnType<typeof openBrowser>;
