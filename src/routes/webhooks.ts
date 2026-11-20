import { Hono } from "hono";
import Stripe from "stripe";
import { stripeClient } from "../stripe";
import { syncCustomer } from "../sync";

// The events the webhook destination sends. Each one triggers the same sync
// of its customer; any other type is acknowledged and ignored.
const SYNCED_EVENTS = [
	"checkout.session.completed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.paid",
	"invoice.payment_failed",
];

const webhooks = new Hono<{ Bindings: CloudflareBindings }>();

webhooks.post("/stripe", async (c) => {
	const stripe = stripeClient(c.env);

	// The signature covers the raw body, byte for byte: read it as text.
	const signature = c.req.header("Stripe-Signature");
	const body = await c.req.text();
	let event: Stripe.Event;
	try {
		if (!signature) throw new Error("No Stripe-Signature header");
		event = await stripe.webhooks.constructEventAsync(
			body,
			signature,
			c.env.STRIPE_WEBHOOK_SECRET,
			undefined,
			Stripe.createSubtleCryptoProvider(),
		);
	} catch {
		return c.json({ error: "Invalid signature" }, 400);
	}

	if (!SYNCED_EVENTS.includes(event.type)) return c.json({ received: true });

	// Only the customer id comes from the event: its snapshot may be stale.
	const { customer } = event.data.object as {
		customer?: string | { id: string } | null;
	};
	const customerId = typeof customer === "string" ? customer : customer?.id;
	if (!customerId) return c.json({ received: true });

	// A failure of Stripe here throws: the 500 makes Stripe deliver it again.
	const matched = await syncCustomer(c.env.DB, stripe, customerId);
	if (!matched) {
		console.warn(`Stripe customer ${customerId} matches no user`);
	}
	return c.json({ received: true });
});

export default webhooks;
