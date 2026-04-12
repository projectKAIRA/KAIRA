/**
 * Self-serve onboarding flow — two email provider paths + Stripe billing.
 *
 * Step 1  GET  /onboarding                         — Company name + provider choice
 *         POST /onboarding/start                   — Branch on provider
 *
 * Microsoft path:
 *         GET  /onboarding/auth/microsoft/callback — Exchange code, store tokens
 *
 * IMAP path:
 *         GET  /onboarding/imap                    — Credentials form
 *         POST /onboarding/imap                    — Validate & store credentials
 *
 * Step 2  GET  /onboarding/step2                   — Connect Slack or Teams
 *         GET  /onboarding/auth/slack/start        — Redirect to Slack OAuth
 *         GET  /onboarding/auth/slack/callback     — Exchange code, store notification config
 *         POST /onboarding/teams                   — Store Teams webhook, advance to billing
 *         GET  /onboarding/skip-notification        — Skip notification step, advance to billing
 *
 * Step 3  GET  /onboarding/plans                   — Plan selection
 *         POST /onboarding/checkout                — Create Stripe Checkout session + redirect
 *
 * Done    GET  /onboarding/complete                — Create + activate tenant after Stripe redirect
 */

import express, { Request, Response, Router } from "express";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { CreateTenantInput } from "../types/tenant.js";
import { config } from "../config/index.js";
import {
  OnboardingSession,
  OAuthSessionStore,
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  decodeMicrosoftIdToken,
  buildSlackAuthUrl,
  exchangeSlackCode,
} from "../services/auth/OAuthService.js";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  priceIdToTier,
  getPlans,
} from "../services/billing/StripeService.js";
import { sendWelcomeEmail } from "../services/email/ConfirmationMailer.js";

const registry = new TenantRegistry();

export function createOnboardingRouter(scheduler: TenantScheduler): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  // ─── Step 1 — Landing page ─────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderStep1());
  });

  // ─── Step 1 — Branch on provider choice ───────────────────────────────────

  router.post("/start", (req: Request, res: Response) => {
    const companyName = (req.body.companyName as string | undefined)?.trim() ?? "";
    const provider    = (req.body.provider    as string | undefined) ?? "microsoft";

    if (!companyName) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep1("Company name is required."));
      return;
    }

    const session = OAuthSessionStore.create(companyName);

    if (provider === "imap") {
      res.redirect(`/onboarding/imap?session=${encodeURIComponent(session.id)}`);
      return;
    }

    if (!config.oauth.microsoft.clientId) {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(renderError(
        "Microsoft OAuth is not configured.",
        "Set OAUTH_MICROSOFT_CLIENT_ID and OAUTH_MICROSOFT_CLIENT_SECRET in your environment.",
      ));
      return;
    }

    res.redirect(buildMicrosoftAuthUrl(session.id));
  });

  // ─── IMAP — credentials form ───────────────────────────────────────────────

  router.get("/imap", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);
    if (!session) { res.redirect("/onboarding"); return; }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderImap(sessionId, session.companyName));
  });

  router.post("/imap", (req: Request, res: Response) => {
    const sessionId = (req.body.session   as string | undefined) ?? "";
    const username  = (req.body.username  as string | undefined)?.trim() ?? "";
    const password  = (req.body.password  as string | undefined) ?? "";
    const host      = (req.body.host      as string | undefined)?.trim() ?? "";

    const session = OAuthSessionStore.get(sessionId);
    if (!session) { res.redirect("/onboarding"); return; }

    const errors: string[] = [];
    if (!username) errors.push("Email address is required.");
    if (!password) errors.push("App password is required.");
    if (!host)     errors.push("Mail server is required.");

    if (errors.length > 0) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderImap(sessionId, session.companyName, { username, host }, errors[0]!));
      return;
    }

    OAuthSessionStore.update(sessionId, {
      step: "notification",
      imap: { host, port: 993, username, password, secure: true },
    });

    res.redirect(`/onboarding/step2?session=${encodeURIComponent(sessionId)}`);
  });

  // ─── Microsoft OAuth callback ──────────────────────────────────────────────

  router.get("/auth/microsoft/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Microsoft authorisation failed.", error_description ?? error));
      return;
    }

    const session = OAuthSessionStore.get(state);
    if (!session) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Session not found or expired.", "Please start the onboarding process again.", "/onboarding"));
      return;
    }

    const tokens = await exchangeMicrosoftCode(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Token exchange failed.", tokens.error_description ?? tokens.error ?? "Microsoft did not return tokens."));
      return;
    }

    const claims        = tokens.id_token ? decodeMicrosoftIdToken(tokens.id_token) : {};
    const userEmail     = claims.preferred_username ?? claims.email ?? "";
    const azureTenantId = claims.tid ?? "common";
    const expiresAt     = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    OAuthSessionStore.update(state, {
      step: "notification",
      microsoft: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt, userEmail, azureTenantId },
    });

    res.redirect(`/onboarding/step2?session=${encodeURIComponent(state)}`);
  });

  // ─── Step 2 — Notification channel ────────────────────────────────────────

  router.get("/step2", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || session.step !== "notification" || (!session.microsoft && !session.imap)) {
      res.redirect("/onboarding");
      return;
    }

    const { connectedLabel, connectedEmail } = emailSummary(session);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderStep2(sessionId, connectedLabel, connectedEmail, session.companyName));
  });

  // ─── Slack OAuth start ─────────────────────────────────────────────────────

  router.get("/auth/slack/start", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || (!session.microsoft && !session.imap)) {
      res.redirect("/onboarding");
      return;
    }

    if (!config.oauth.slack.clientId) {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(renderError(
        "Slack OAuth is not configured.",
        "Set OAUTH_SLACK_CLIENT_ID and OAUTH_SLACK_CLIENT_SECRET in your environment.",
      ));
      return;
    }

    res.redirect(buildSlackAuthUrl(sessionId));
  });

  // ─── Slack OAuth callback ──────────────────────────────────────────────────
  // Stores notification config in session and advances to plan selection.
  // Tenant is NOT created here — that happens after Stripe payment.

  router.get("/auth/slack/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Slack authorisation failed.", error));
      return;
    }

    const session = OAuthSessionStore.get(state);
    if (!session || (!session.microsoft && !session.imap)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Session not found or expired.", "Please start the onboarding process again.", "/onboarding"));
      return;
    }

    const slack = await exchangeSlackCode(code);
    if (!slack.ok || !slack.access_token) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Slack token exchange failed.", slack.error ?? "Slack did not return an access token."));
      return;
    }

    OAuthSessionStore.update(state, {
      step: "billing",
      notificationConfig: {
        provider: "slack",
        slack: {
          botToken:       slack.access_token,
          signingSecret:  config.oauth.slack.signingSecret || null,
          webhookRfq:     slack.incoming_webhook?.url ?? null,
          webhookInquiry: slack.incoming_webhook?.url ?? null,
          poChannelId:    slack.incoming_webhook?.channel_id ?? null,
          botName:        "KAIRA",
        },
      },
    });

    res.redirect(`/onboarding/plans?session=${encodeURIComponent(state)}`);
  });

  // ─── Teams — manual webhook URL ───────────────────────────────────────────

  router.post("/teams", (req: Request, res: Response) => {
    const sessionId  = (req.body.session     as string | undefined) ?? "";
    const webhookUrl = (req.body.webhookUrl  as string | undefined)?.trim() ?? "";

    const session = OAuthSessionStore.get(sessionId);
    if (!session || (!session.microsoft && !session.imap)) {
      res.redirect("/onboarding");
      return;
    }

    if (!webhookUrl.startsWith("https://")) {
      const { connectedLabel, connectedEmail } = emailSummary(session);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep2(sessionId, connectedLabel, connectedEmail, session.companyName, "Webhook URL must start with https://"));
      return;
    }

    OAuthSessionStore.update(sessionId, {
      step: "billing",
      notificationConfig: {
        provider: "teams",
        teams: { webhookUrl },
      },
    });

    res.redirect(`/onboarding/plans?session=${encodeURIComponent(sessionId)}`);
  });

  // ─── Skip notification channel ────────────────────────────────────────────

  router.get("/skip-notification", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || (!session.microsoft && !session.imap)) {
      res.redirect("/onboarding");
      return;
    }

    OAuthSessionStore.update(sessionId, { step: "billing" });
    res.redirect(`/onboarding/plans?session=${encodeURIComponent(sessionId)}`);
  });

  // ─── Step 3 — Plan selection ───────────────────────────────────────────────

  router.get("/plans", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || session.step !== "billing") {
      res.redirect("/onboarding");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPlans(sessionId, session.companyName));
  });

  // ─── Checkout — create Stripe session + redirect ───────────────────────────

  router.post("/checkout", async (req: Request, res: Response) => {
    const sessionId = (req.body.session as string | undefined) ?? "";
    const priceId   = (req.body.priceId as string | undefined) ?? "";

    const session = OAuthSessionStore.get(sessionId);
    if (!session || session.step !== "billing") {
      res.redirect("/onboarding");
      return;
    }

    const validPrices = Object.values(config.stripe.prices);
    if (!priceId || !validPrices.includes(priceId)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderPlans(sessionId, session.companyName, "Please select a plan."));
      return;
    }

    if (!config.stripe.secretKey) {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(renderError(
        "Billing is not configured.",
        "Set STRIPE_SECRET_KEY in your environment.",
      ));
      return;
    }

    const checkout = await createCheckoutSession({
      sessionId,
      priceId,
      companyName: session.companyName,
      baseUrl: config.oauth.baseUrl,
    });

    OAuthSessionStore.update(sessionId, {
      selectedPriceId:       priceId,
      stripeCheckoutSessionId: checkout.id,
    });

    res.redirect(checkout.url!);
  });

  // ─── Complete — create + activate tenant after Stripe redirects back ───────

  router.get("/complete", async (req: Request, res: Response) => {
    const sessionId = (req.query.session  as string | undefined) ?? "";
    const payment   = (req.query.payment  as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    // If no payment=success param, treat as a direct visit — just show the page
    // for already-created tenants (e.g. after a page refresh).
    if (payment !== "success" || !session) {
      const companyName = session?.companyName ?? "your company";
      const { connectedLabel, connectedEmail } = session ? emailSummary(session) : { connectedLabel: "Email", connectedEmail: "" };
      OAuthSessionStore.delete(sessionId);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderComplete(companyName, connectedLabel, connectedEmail));
      return;
    }

    if (!session.stripeCheckoutSessionId) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError("Session incomplete.", "Billing configuration is missing.", "/onboarding"));
      return;
    }

    // Retrieve the Stripe checkout session to get customer + subscription IDs.
    const checkout = await retrieveCheckoutSession(session.stripeCheckoutSessionId);
    const stripeCustomerId     = typeof checkout.customer     === "string" ? checkout.customer
                               : (checkout.customer as { id?: string } | null)?.id ?? null;
    const stripeSubscriptionId = typeof checkout.subscription === "string" ? checkout.subscription
                               : (checkout.subscription as { id?: string } | null)?.id ?? null;

    const tier  = session.selectedPriceId ? priceIdToTier(session.selectedPriceId) : "starter";
    const notif = session.notificationConfig;

    const tenant = await registry.create({
      ...buildEmailProviderInput(session, tier),
      ...(notif && { notification: { provider: notif.provider } }),
      ...(notif?.slack && { slack: notif.slack }),
      ...(notif?.teams && { teams: notif.teams }),
      stripeCustomerId,
      stripeSubscriptionId,
    });

    await activateTenant(tenant.id, scheduler);
    OAuthSessionStore.update(sessionId, { tenantId: tenant.id, step: "complete" });

    const { connectedLabel, connectedEmail } = emailSummary(session);

    // Fire confirmation email — best-effort, never blocks the response.
    if (connectedEmail) {
      const notifChannel = notif?.provider === "teams" ? "Microsoft Teams" : "Slack";
      sendWelcomeEmail({
        toEmail:             connectedEmail,
        companyName:         session.companyName,
        planTier:            tier,
        notificationChannel: notifChannel,
      }).catch((err: unknown) => {
        console.error("[Onboarding] Failed to send welcome email:", err);
      });
    }

    OAuthSessionStore.delete(sessionId);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderComplete(session.companyName, connectedLabel, connectedEmail));
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { PlanTier } from "../types/tenant.js";

/** Build tenant creation input from session + chosen plan tier. */
function buildEmailProviderInput(session: OnboardingSession, tier: PlanTier): CreateTenantInput {
  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + 14);

  const base: CreateTenantInput = {
    name:           session.companyName,
    isActive:       false,
    planTier:       tier,
    isTrialActive:  true,
    trialStartDate: now,
    trialEndDate:   trialEnd,
  };

  if (session.microsoft) {
    const ms = session.microsoft;
    return {
      ...base,
      providerType: "microsoft",
      graph: {
        authMode:           "oauth",
        tenantId:           ms.azureTenantId,
        userEmail:          ms.userEmail,
        accessToken:        ms.accessToken,
        refreshToken:       ms.refreshToken,
        tokenExpiresAt:     new Date(ms.expiresAt),
        inboxFolder:        "inbox",
        pollIntervalSeconds: 60,
      },
    };
  }

  if (session.imap) {
    const im = session.imap;
    return {
      ...base,
      providerType: "imap",
      imap: {
        host:               im.host,
        port:               im.port,
        username:           im.username,
        password:           im.password,
        secure:             im.secure,
        inboxFolder:        "INBOX",
        pollIntervalSeconds: 60,
      },
    };
  }

  return base;
}

function emailSummary(session: OnboardingSession): { connectedLabel: string; connectedEmail: string } {
  if (session.microsoft) {
    return { connectedLabel: "Microsoft 365", connectedEmail: session.microsoft.userEmail };
  }
  if (session.imap) {
    const label = session.imap.host === "imap.gmail.com" ? "Gmail" : "IMAP";
    return { connectedLabel: label, connectedEmail: session.imap.username };
  }
  return { connectedLabel: "Email", connectedEmail: "" };
}

async function activateTenant(tenantId: string, scheduler: TenantScheduler): Promise<void> {
  await registry.activate(tenantId);
  const updated = await registry.findById(tenantId);
  if (updated) {
    await scheduler.addTenant(updated);
    console.log(`[Onboarding] Activated tenant ${tenantId} — monitoring started.`);
  }
}

// ─── HTML templates ───────────────────────────────────────────────────────────

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0d0d0d;
    color: #e8e8e8;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .shell { width: 100%; max-width: 480px; padding: 2rem 1rem; }
  .shell-wide { width: 100%; max-width: 860px; padding: 2rem 1rem; }
  .logo { text-align: center; margin-bottom: 2.5rem; }
  .logo-name { font-size: 1.6rem; font-weight: 700; letter-spacing: 0.15em; color: #fff; }
  .logo-tagline { font-size: 0.78rem; letter-spacing: 0.08em; color: #666; text-transform: uppercase; margin-top: 0.25rem; }
  .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; }
  .card-title { font-size: 1.25rem; font-weight: 600; color: #fff; margin-bottom: 0.4rem; }
  .card-sub { font-size: 0.85rem; color: #888; margin-bottom: 1.75rem; line-height: 1.5; }
  label { display: block; font-size: 0.82rem; font-weight: 500; color: #aaa; margin-bottom: 0.4rem; letter-spacing: 0.02em; }
  .field { margin-bottom: 1rem; }
  input[type="text"], input[type="url"], input[type="email"], input[type="password"] {
    width: 100%;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 0.65rem 0.85rem;
    color: #fff;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: #5865f2; }
  .btn {
    display: block; width: 100%; padding: 0.75rem 1rem; border-radius: 8px; border: none;
    font-size: 0.95rem; font-weight: 600; cursor: pointer; text-decoration: none;
    text-align: center; transition: opacity 0.15s, transform 0.1s;
  }
  .btn:active { transform: scale(0.98); }
  .btn-ms     { background: #0078d4; color: #fff; margin-top: 1rem; }
  .btn-imap   { background: #1a1a1a; color: #e8e8e8; border: 1px solid #333; margin-top: 0.75rem; }
  .btn-slack  { background: #4a154b; color: #fff; }
  .btn-teams  { background: #5865f2; color: #fff; margin-top: 0.75rem; }
  .btn-submit { background: #22c55e; color: #000; margin-top: 1.25rem; }
  .btn:hover  { opacity: 0.9; }
  .divider {
    display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0;
    color: #444; font-size: 0.8rem; letter-spacing: 0.05em;
  }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #2a2a2a; }
  .pill {
    display: inline-flex; align-items: center; gap: 0.4rem;
    background: #0d2b12; border: 1px solid #1a5c2a; color: #4ade80;
    border-radius: 20px; padding: 0.3rem 0.75rem; font-size: 0.8rem; font-weight: 500;
    margin-bottom: 1.5rem;
  }
  .error-msg {
    background: #2a0e0e; border: 1px solid #5c1a1a; color: #f87171;
    border-radius: 8px; padding: 0.65rem 0.85rem; font-size: 0.85rem; margin-bottom: 1rem;
  }
  .hint { font-size: 0.78rem; color: #555; margin-top: 1rem; line-height: 1.5; text-align: center; }
  .hint a { color: #6b9eff; text-decoration: none; }
  .hint a:hover { text-decoration: underline; }
  .steps { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 2rem; }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; background: #2a2a2a; }
  .step-dot.active { background: #5865f2; }
  .step-dot.done   { background: #4ade80; }
  .success-icon { text-align: center; font-size: 3.5rem; margin-bottom: 1.25rem; }
  .success-title { font-size: 1.4rem; font-weight: 700; color: #fff; text-align: center; margin-bottom: 0.5rem; }
  .success-sub { font-size: 0.88rem; color: #888; text-align: center; line-height: 1.6; margin-bottom: 1.5rem; }
  .info-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.6rem 0; border-bottom: 1px solid #222; font-size: 0.85rem;
  }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: #666; }
  .info-value { color: #e8e8e8; font-weight: 500; }
  .tag-green { background: #0d2b12; color: #4ade80; border-radius: 4px; padding: 0.2rem 0.5rem; font-size: 0.75rem; font-weight: 600; }
  /* Plans grid */
  .plans-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  @media (max-width: 640px) { .plans-grid { grid-template-columns: 1fr; } }
  .plan-card {
    background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; position: relative;
  }
  .plan-card.highlight { border-color: #5865f2; }
  .plan-badge {
    position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
    background: #5865f2; color: #fff; font-size: 0.7rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; padding: 0.2rem 0.6rem; border-radius: 20px;
  }
  .plan-name { font-size: 1.1rem; font-weight: 700; color: #fff; }
  .plan-desc { font-size: 0.8rem; color: #777; line-height: 1.5; }
  .plan-features { list-style: none; display: flex; flex-direction: column; gap: 0.4rem; flex: 1; }
  .plan-features li { font-size: 0.82rem; color: #aaa; display: flex; align-items: center; gap: 0.4rem; }
  .plan-features li::before { content: "✓"; color: #4ade80; font-weight: 700; flex-shrink: 0; }
  .btn-plan {
    display: block; width: 100%; padding: 0.65rem 1rem; border-radius: 8px;
    background: #1a1a1a; border: 1px solid #333; color: #e8e8e8;
    font-size: 0.9rem; font-weight: 600; cursor: pointer; text-align: center;
    transition: background 0.15s, border-color 0.15s;
  }
  .plan-card.highlight .btn-plan { background: #5865f2; border-color: #5865f2; color: #fff; }
  .btn-plan:hover { opacity: 0.85; }
  .trial-notice {
    text-align: center; font-size: 0.8rem; color: #555; margin-top: 1.25rem; line-height: 1.5;
  }
`;

function html(body: string, wide = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA — Setup</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="${wide ? "shell-wide" : "shell"}">
    <div class="logo">
      <div class="logo-name">K.A.I.R.A</div>
      <div class="logo-tagline">Inbox Intelligence Platform</div>
    </div>
    ${body}
  </div>
</body>
</html>`;
}

function renderStep1(errorMsg?: string): string {
  return html(`
    <div class="steps">
      <div class="step-dot active"></div>
      <div class="step-dot"></div>
      <div class="step-dot"></div>
    </div>
    <div class="card">
      <div class="card-title">Let's get you set up</div>
      <div class="card-sub">Connect your inbox so KAIRA can start monitoring purchase orders automatically.</div>
      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}
      <form method="POST" action="/onboarding/start">
        <div class="field">
          <label for="companyName">Company name</label>
          <input type="text" id="companyName" name="companyName" placeholder="Acme Corp" autocomplete="organization" required>
        </div>
        <button type="submit" name="provider" value="microsoft" class="btn btn-ms">
          Connect Microsoft 365 &rarr;
        </button>
        <div class="divider">or</div>
        <button type="submit" name="provider" value="imap" class="btn btn-imap">
          Connect Gmail / Other Email &rarr;
        </button>
      </form>
      <p class="hint">We request read-only access to your inbox. No emails are stored — only extracted PO data.</p>
    </div>
  `);
}

function renderImap(sessionId: string, companyName: string, prefill: { username?: string; host?: string } = {}, errorMsg?: string): string {
  const username = escAttr(prefill.username ?? "");
  const host     = escAttr(prefill.host     ?? "imap.gmail.com");

  return html(`
    <div class="steps">
      <div class="step-dot active"></div>
      <div class="step-dot"></div>
      <div class="step-dot"></div>
    </div>
    <div class="card">
      <div class="card-title">Connect your inbox</div>
      <div class="card-sub">Enter your email credentials for ${escHtml(companyName)}.</div>
      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}
      <form method="POST" action="/onboarding/imap">
        <input type="hidden" name="session" value="${escAttr(sessionId)}">
        <div class="field">
          <label for="username">Email address</label>
          <input type="email" id="username" name="username" value="${username}" placeholder="orders@yourcompany.com" required>
        </div>
        <div class="field">
          <label for="password">App password</label>
          <input type="password" id="password" name="password" placeholder="xxxx xxxx xxxx xxxx" required>
        </div>
        <div class="field">
          <label for="host">Mail server (IMAP host)</label>
          <input type="text" id="host" name="host" value="${host}" placeholder="imap.gmail.com" required>
        </div>
        <button type="submit" class="btn btn-submit">Connect inbox &rarr;</button>
      </form>
      <p class="hint">
        Gmail requires an App Password — your regular password won't work.<br>
        Go to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> to generate one.
      </p>
    </div>
  `);
}

function renderStep2(sessionId: string, connectedLabel: string, connectedEmail: string, companyName: string, errorMsg?: string): string {
  const slackConfigured = !!config.oauth.slack.clientId;
  const slackButton = slackConfigured
    ? `<a class="btn btn-slack" href="/onboarding/auth/slack/start?session=${encodeURIComponent(sessionId)}">Add to Slack &rarr;</a>`
    : `<p style="color:#555;font-size:0.82rem;margin-top:0.5rem;">Slack OAuth not configured (set OAUTH_SLACK_CLIENT_ID).</p>`;

  return html(`
    <div class="steps">
      <div class="step-dot done"></div>
      <div class="step-dot active"></div>
      <div class="step-dot"></div>
    </div>
    <div class="card">
      <div class="pill">&#10003; ${escHtml(connectedLabel)} connected</div>
      <div class="card-title">Connect your notification channel</div>
      <div class="card-sub">
        Choose where ${escHtml(companyName)} should receive purchase order alerts.
        ${connectedEmail ? `<br><span style="color:#666;">Inbox: ${escHtml(connectedEmail)}</span>` : ""}
      </div>
      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}
      ${slackButton}
      <div class="divider">or use Microsoft Teams</div>
      <form method="POST" action="/onboarding/teams">
        <input type="hidden" name="session" value="${escAttr(sessionId)}">
        <div class="field">
          <label for="webhookUrl">Teams incoming webhook URL</label>
          <input type="url" id="webhookUrl" name="webhookUrl" placeholder="https://outlook.office.com/webhook/..." required>
        </div>
        <button type="submit" class="btn btn-teams">Connect Teams &rarr;</button>
      </form>
      <p class="hint">Teams webhook: open a channel &rarr; Connectors &rarr; Incoming Webhook &rarr; copy the URL.</p>
    </div>
    <div class="divider">or</div>
    <a href="/onboarding/skip-notification?session=${encodeURIComponent(sessionId)}"
       class="btn"
       style="background:#1e1e2e;color:#c4b5fd;border:1px solid #6d28d9;">
      Skip for now — connect Slack or Teams later &rarr;
    </a>
    <p class="hint" style="margin-top:0.6rem;">
      You can connect Slack or Teams from your dashboard after setup.
    </p>
  `);
}

function renderPlans(sessionId: string, companyName: string, errorMsg?: string): string {
  const plans = getPlans();

  const cards = plans.map((plan) => `
    <div class="plan-card${plan.highlight ? " highlight" : ""}">
      ${plan.highlight ? `<div class="plan-badge">Most popular</div>` : ""}
      <div class="plan-name">${escHtml(plan.name)}</div>
      <div class="plan-desc">${escHtml(plan.description)}</div>
      <ul class="plan-features">
        ${plan.features.map((f) => `<li>${escHtml(f)}</li>`).join("")}
      </ul>
      <form method="POST" action="/onboarding/checkout">
        <input type="hidden" name="session" value="${escAttr(sessionId)}">
        <input type="hidden" name="priceId" value="${escAttr(plan.priceId)}">
        <button type="submit" class="btn-plan">Start 14-day trial &rarr;</button>
      </form>
    </div>
  `).join("");

  return html(`
    <div class="steps">
      <div class="step-dot done"></div>
      <div class="step-dot done"></div>
      <div class="step-dot active"></div>
    </div>
    <div style="text-align:center;margin-bottom:1.5rem;">
      <div class="card-title">Choose your plan</div>
      <div class="card-sub" style="margin-bottom:0;">
        ${escHtml(companyName)} gets a 14-day free trial on any plan. No charge until the trial ends.
      </div>
    </div>
    ${errorMsg ? `<div class="error-msg" style="margin-bottom:1rem;">${escHtml(errorMsg)}</div>` : ""}
    <div class="plans-grid">${cards}</div>
    <p class="trial-notice">14-day free trial &bull; Cancel anytime &bull; Secure checkout via Stripe</p>
  `, true);
}

function renderComplete(companyName: string, emailProviderLabel: string, connectedEmail: string): string {
  return html(`
    <div class="card">
      <div class="success-icon">&#9989;</div>
      <div class="success-title">You're all set!</div>
      <div class="success-sub">
        ${escHtml(companyName)}'s inbox is now being monitored.<br>
        Purchase orders will appear in your connected channel within the next polling cycle.<br>
        Your 14-day free trial is now active.
      </div>
      <div class="info-row">
        <span class="info-label">${escHtml(emailProviderLabel)}</span>
        <span class="info-value tag-green">Connected</span>
      </div>
      ${connectedEmail ? `
      <div class="info-row">
        <span class="info-label">Inbox</span>
        <span class="info-value">${escHtml(connectedEmail)}</span>
      </div>` : ""}
      <div class="info-row">
        <span class="info-label">Trial</span>
        <span class="info-value tag-green">14 days active</span>
      </div>
      <div class="info-row">
        <span class="info-label">Monitoring</span>
        <span class="info-value tag-green">Active</span>
      </div>
    </div>
  `);
}

function renderError(title: string, detail: string, backHref = "/onboarding"): string {
  return html(`
    <div class="card">
      <div class="card-title" style="color:#f87171;">${escHtml(title)}</div>
      <div class="card-sub" style="margin-top:0.5rem;">${escHtml(detail)}</div>
      <a class="btn btn-ms" href="${escAttr(backHref)}" style="margin-top:1.5rem;">Try again</a>
    </div>
  `);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/"/g, "%22").replace(/'/g, "%27");
}
