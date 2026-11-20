import { Hono } from "hono";
import account from "./routes/account";
import auth from "./routes/auth";
import checkout from "./routes/checkout";
import health from "./routes/health";
import signIn from "./routes/sign-in";
import webhooks from "./routes/webhooks";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Hono only sends Error instances to onError. Anything else a handler throws
// is wrapped here, so it gets the same 500. Keep this before the routes.
app.use(async (_c, next) => {
	try {
		await next();
	} catch (thrown) {
		if (thrown instanceof Error) throw thrown;
		throw new Error("A handler threw a value that is not an Error", {
			cause: thrown,
		});
	}
});

app.route("/health", health);
app.route("/account", account);
app.route("/checkout", checkout);
app.route("/webhooks", webhooks);
app.route("/sign-in", signIn);
app.route("/api/auth", auth);

app.notFound((c) => c.json({ error: "Not Found" }, 404));

// The client never sees the error's message or stack: they go to the logs.
app.onError((error, c) => {
	console.error(error);
	return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
