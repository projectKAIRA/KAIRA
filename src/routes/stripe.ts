/**
 * Stripe webhook endpoint — /stripe/webhook
 *
 * Must be mounted BEFORE express.json() so the raw request body
 * is available for Stripe signature verification.
 *
 * Events handled:
 *   checkout.session.completed     — backfill stripeSubscriptionId if needed
 *   customer.subscription.updated  — sync planTier / isTrialActive
 *   customer.subscription.deleted  — deactivate tenant
 *   invoice.payment_failed         — log warning
 */

import express, { Request, Response, Router } from "express";
import Stripe from "stripe";
import { constructWebhookEvent } from "../services/billing/StripeService.js";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { getPrismaClient } from "../lib/prisma.js";

const registry = new TenantRegistry();

export function createStripeRouter(): Router {
  const router = Router();

  // Use raw body parser for this route — Stripe requires the exact bytes.
  router.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const signature = req.headers["stripe-signature"] as string | undefined;
      if (!signature) {
        res.status(400).send("Missing stripe-signature header.");
        return;
      }

      let event: Stripe.Event;
      try {
        event = constructWebhookEvent(req.body as Buffer, signature);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Stripe] Webhook signature verification failed: ${msg}`);
        res.status(400).send(`Webhook error: ${msg}`);
        return;
      }

      // Acknowledge immediately — processing is best-effort.
      res.sendStatus(200);

      try {
        await handleEvent(event);
      } catch (err) {
        console.error(`[Stripe] Error handling event ${event.type}:`, err);
      }
    },
  );

  return router;
}

// ─── Event dispatch ───────────────────────────────────────────────────────────

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

    case "customer.subscription.updated":
      await onSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;

    case "customer.subscription.deleted":
      await onSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;

    case "invoice.payment_failed":
      onPaymentFailed(event.data.object as Stripe.Invoice);
      break;

    default:
      // Ignore unhandled events.
      break;
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * checkout.session.completed
 *
 * Fired when the customer completes Stripe Checkout. The KAIRA session ID is
 * stored as client_reference_id. We use it to find the tenant and backfill
 * stripeCustomerId / stripeSubscriptionId in case the redirect beat the webhook.
 */
async function onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const stripeCustomerId     = typeof session.customer     === "string" ? session.customer     : session.customer?.id ?? null;
  const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  if (!stripeCustomerId) {
    console.warn("[Stripe] checkout.session.completed missing customer ID — skipping.");
    return;
  }

  // Find the tenant by stripeCustomerId (set during /onboarding/complete redirect).
  const db = getPrismaClient();
  const row = await db.tenant.findFirst({ where: { stripeCustomerId } });
  if (!row) {
    // Tenant may not exist yet if the webhook beat the redirect — that's OK.
    // The redirect handler also stores both IDs directly from the checkout session.
    console.log(`[Stripe] checkout.session.completed: no tenant for customer ${stripeCustomerId} yet (redirect will create it).`);
    return;
  }

  if (!row.stripeSubscriptionId && stripeSubscriptionId) {
    await registry.update(row.id, { stripeSubscriptionId });
    console.log(`[Stripe] Backfilled subscriptionId ${stripeSubscriptionId} for tenant ${row.id}.`);
  }
}

/**
 * customer.subscription.updated
 *
 * Fired when a subscription changes status (e.g. trial → active, active → past_due).
 */
async function onSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const tenant = await findTenantBySubscription(sub.id);
  if (!tenant) return;

  const isTrialing = sub.status === "trialing";
  const isActive   = sub.status === "active" || isTrialing;

  await registry.update(tenant.id, {
    isTrialActive: isTrialing,
    isActive,
    // Once the trial ends and subscription becomes active, clear trialLimitReached.
    ...(sub.status === "active" && { trialLimitReached: false } as object),
  });

  console.log(`[Stripe] Subscription ${sub.id} status → ${sub.status} for tenant ${tenant.id}.`);
}

/**
 * customer.subscription.deleted
 *
 * Fired when a subscription is cancelled or expires.
 */
async function onSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const tenant = await findTenantBySubscription(sub.id);
  if (!tenant) return;

  await registry.update(tenant.id, { isActive: false, isTrialActive: false });
  console.log(`[Stripe] Subscription ${sub.id} deleted — deactivated tenant ${tenant.id}.`);
}

/**
 * invoice.payment_failed
 */
function onPaymentFailed(invoice: Stripe.Invoice): void {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? "unknown";
  console.warn(`[Stripe] Payment failed for customer ${customerId} — invoice ${invoice.id}.`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findTenantBySubscription(subscriptionId: string) {
  const db  = getPrismaClient();
  const row = await db.tenant.findFirst({ where: { stripeSubscriptionId: subscriptionId } });
  return row ?? null;
}
