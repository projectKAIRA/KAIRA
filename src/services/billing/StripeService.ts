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
      description: "Up to 100 documents/month",
      features:    ["Outlook & Gmail monitoring", "PDF, Word, Excel, image support", "Slack or Teams routing", "PO, RFQ & inquiry classification", "Claim Order workflow", "Direct founder support"],
      highlight:   false,
    },
    {
      name:        "Growth",
      priceId:     config.stripe.prices.growth,
      tier:        "growth",
      description: "Up to 500 documents/month",
      features:    ["Everything in Starter", "Google Sheets integration (on request)", "Priority support", "Onboarding call included", "Custom channel naming", "Usage dashboard"],
      highlight:   true,
    },
    {
      name:        "Pro",
      priceId:     config.stripe.prices.pro,
      tier:        "pro",
      description: "Unlimited documents",
      features:    ["Everything in Growth", "ERP integration (on request)", "Multiple inbox monitoring", "Custom workflows", "Same day support", "Early access to new features"],
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
    subscription_data: {
      trial_period_days: 14,
      metadata: { kairaSessionId: opts.sessionId, companyName: opts.companyName },
    },
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: `${opts.baseUrl}/onboarding/connect?session=${encodeURIComponent(opts.sessionId)}&payment=success`,
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

// ─── Billing portal ──────────────────────────────────────────────────────────

/**
 * Create a Stripe Billing Portal session for an existing customer.
 * The portal lets customers upgrade, downgrade, or cancel their subscription
 * without any custom UI on our side.
 *
 * Requires the portal to be configured in the Stripe dashboard:
 *   Dashboard → Billing → Customer portal → Activate
 */
export async function createBillingPortalSession(opts: {
  stripeCustomerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  return getStripe().billingPortal.sessions.create({
    customer:   opts.stripeCustomerId,
    return_url: opts.returnUrl,
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
