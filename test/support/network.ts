import { vi } from "vitest";

export type RecordedRequest = {
	method: string;
	url: URL;
	headers: Headers;
	body: string;
};

export type FakeService = {
	host: string;
	handle(request: RecordedRequest): Response;
};

/**
 * Replaces the global `fetch` for one test: a request to the host of a fake
 * service gets that service's answer, and any other request fails the test,
 * since the tests never reach the network. The Worker runs in the tests'
 * isolate, so its outbound requests come here. `vi.restoreAllMocks()` undoes
 * it.
 */
export function installFakeNetwork(...services: FakeService[]): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		const recorded: RecordedRequest = {
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			// Not `text()`: workerd warns when the body is form-encoded, as the
			// Stripe SDK's are.
			body: new TextDecoder().decode(await request.arrayBuffer()),
		};
		const service = services.find(({ host }) => host === recorded.url.host);
		if (!service) {
			throw new Error(
				`A test reached the network: ${recorded.method} ${recorded.url}`,
			);
		}
		return service.handle(recorded);
	});
}
