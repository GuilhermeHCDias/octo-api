import { Hono } from "hono";
import health from "./routes/health";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.route("/health", health);

app.notFound((c) => c.json({ error: "Not Found" }, 404));

// The client never sees the error's message or stack: they go to the logs.
app.onError((error, c) => {
	console.error(error);
	return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
