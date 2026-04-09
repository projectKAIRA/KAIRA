import Stripe from "stripe";
import { config } from "../../config/index.js";
import { PlanTier } from "../../types/tenant.js";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!config.stripe.secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
    _stripe = new Stripe(config.stripe.secretKey);
  }
  return _stripe;
}

// ─── Price → tier mapping ─────────────────────────────────────────────────────

export function priceIdToTier(priceId: string): PlanTier {
  const { starter, growth, pro } = config.stripe.prices;
  if (priceId === starter) return "starter";
  if (priceId === growth)  return "growth";
  if (priceId === pro)     return "pro";
  return "starter";
}

// ─── Plan metadata (display only) ────────────────────────────────────────────

export interface PlanMeta {
  name: string;
  priceId: string;
  tier: PlanTier;
  description: string;
  features: string[];
  highlight: boolean;
}

export function getPlans(): PlanMeta[] {
  return [
    {
      name:        "Starter",
      priceId:     config.stripe.prices.starter,
      tier:        "starter",
      description: "Perfect for small teams processing a steady stream of orders.",
      features:    ["500 documents / month", "1 inbox", "Slack or Teams alerts", "Email support"],
      highlight:   false,
    },
    {
      name:        "Growth",
      priceId:     config.stripe.prices.growth,
      tier:        "growth",
      description: "For growing operations that need higher volume and faster response.",
      features:    ["2,000 documents / month", "3 inboxes", "Priority Slack alerts", "Priority support"],
      highlight:   true,
    },
    {
      name:        "Pro",
      priceId:     config.stripe.prices.pro,
      tier:        "pro",
      description: "Unlimited processing for high-volume manufacturers.",
      features:    ["Unlimited documents", "Unlimited inboxes", "Dedicated onboarding", "SLA support"],
      highlight:   false,
    },
  ];
}

// ─── Checkout session ─────────────────────────────────────────────────────────

export async function createCheckoutSession(opts: {
  sessionId: string;
  priceId: string;
  companyName: string;
  baseUrl: string;
}): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();

  return stripe.checkout.sessions.create({
    mode: "subscription",
    client_reference_id: opts.sessionId,
    customer_creation: "always",
    subscription_data: {
      trial_period_days: 14,
      metadata: { kairaSessionId: opts.sessionId, companyName: opts.companyName },
    },
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: `${opts.baseUrl}/onboarding/complete?session=${encodeURIComponent(opts.sessionId)}&payment=success`,
    cancel_url:  `${opts.baseUrl}/onboarding/plans?session=${encodeURIComponent(opts.sessionId)}`,
    metadata: { kairaSessionId: opts.sessionId },
  });
}

export async function retrieveCheckoutSession(
  checkoutSessionId: string,
): Promise<Stripe.Checkout.Session> {
  return getStripe().checkout.sessions.retrieve(checkoutSessionId, {
    expand: ["subscription", "customer"],
  });
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  if (!config.stripe.webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }
  return getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );
}
