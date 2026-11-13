import { Hono } from "hono";

const health = new Hono<{ Bindings: CloudflareBindings }>();

health.get("/", (c) => c.json({ status: "ok" }));

export default health;
