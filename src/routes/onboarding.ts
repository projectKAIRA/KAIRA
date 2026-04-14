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
  fetchMicrosoftUserEmail,
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

  // ─── Connect — post-payment landing page ──────────────────────────────────
  // Stripe redirects here after a successful checkout. The session already
  // exists (created in POST /checkout) and has stripeCheckoutSessionId set.
  // We just show the provider-choice page — no payment handling needed here.

  router.get("/connect", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    // Require a valid session that came through checkout.
    if (!session || !session.stripeCheckoutSessionId) {
      res.redirect("/onboarding");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderConnect(sessionId, session.companyName));
  });

  // ─── Branch on provider choice (post-payment) ─────────────────────────────

  router.post("/start", (req: Request, res: Response) => {
    const sessionId = (req.body.session  as string | undefined) ?? "";
    const provider  = (req.body.provider as string | undefined) ?? "microsoft";

    const session = OAuthSessionStore.get(sessionId);
    if (!session || !session.stripeCheckoutSessionId) {
      res.redirect("/onboarding");
      return;
    }

    if (provider === "imap") {
      res.redirect(`/onboarding/imap?session=${encodeURIComponent(sessionId)}`);
      return;
    }

    if (!config.oauth.microsoft.clientId) {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(renderError(
        "Microsoft OAuth is not configured.",
        "Set OAUTH_MICROSOFT_CLIENT_ID and OAUTH_MICROSOFT_CLIENT_SECRET in your environment.",
      ));
      return;
    }

    res.redirect(buildMicrosoftAuthUrl(sessionId));
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
      step:          "notification",
      customerEmail: username,
      imap:          { host, port: 993, username, password, secure: true },
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
    const azureTenantId = claims.tid ?? "common";
    const expiresAt     = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    // preferred_username / email are absent from id_tokens for many account types.
    // Fall back to a Graph /me call so we always have the real email address.
    const emailFromClaims = claims.preferred_username ?? claims.email ?? "";
    const userEmail = emailFromClaims || await fetchMicrosoftUserEmail(tokens.access_token);
    console.log(`[Onboarding] Microsoft callback — emailFromClaims="${emailFromClaims}", userEmail="${userEmail}"`);

    OAuthSessionStore.update(state, {
      step:          "notification",
      customerEmail: userEmail,
      microsoft:     { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt, userEmail, azureTenantId },
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

    res.redirect(`/onboarding/complete?session=${encodeURIComponent(state)}`);
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

    res.redirect(`/onboarding/complete?session=${encodeURIComponent(sessionId)}`);
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
    res.redirect(`/onboarding/complete?session=${encodeURIComponent(sessionId)}`);
  });

  // ─── /plans — Stripe cancel URL lands here, send back to step 1 ──────────

  router.get("/plans", (_req: Request, res: Response) => {
    res.redirect("/onboarding");
  });

  // ─── Checkout — create session + Stripe checkout, then redirect to Stripe ──
  // This is now the FIRST real POST in the flow: company name + plan selection
  // come in here, session is created, and the user goes straight to Stripe.

  router.post("/checkout", async (req: Request, res: Response) => {
    const companyName = (req.body.companyName as string | undefined)?.trim() ?? "";
    const priceId     = (req.body.priceId     as string | undefined) ?? "";

    const validPrices = Object.values(config.stripe.prices);

    if (!companyName) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep1("Company name is required."));
      return;
    }

    if (!priceId || !validPrices.includes(priceId)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep1(undefined, companyName, "Please select a plan."));
      return;
    }

    if (!config.stripe.secretKey) {
      res.status(503).setHeader("Content-Type", "text/html; charset=utf-8").send(renderError(
        "Billing is not configured.",
        "Set STRIPE_SECRET_KEY in your environment.",
      ));
      return;
    }

    // ── Abuse check: block duplicate company names before payment ────────────
    const duplicate = await registry.checkForDuplicate(companyName);
    if (duplicate) {
      await registry.logSignupBlock({
        email:            "",
        companyName,
        reason:           duplicate.reason,
        matchedTenantId:   duplicate.tenant.id,
        matchedTenantName: duplicate.tenant.name,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep1(undefined, companyName, "An account already exists for this company. Please sign in or contact support@trykaira.ai if you need help."));
      return;
    }

    // Create the onboarding session now — before Stripe, so the session ID
    // can be passed as client_reference_id and embedded in the success URL.
    const session  = OAuthSessionStore.create(companyName);

    const checkout = await createCheckoutSession({
      sessionId:   session.id,
      priceId,
      companyName,
      baseUrl:     config.oauth.baseUrl,
    });

    OAuthSessionStore.update(session.id, {
      selectedPriceId:         priceId,
      stripeCheckoutSessionId: checkout.id,
    });

    res.redirect(checkout.url!);
  });

  // ─── Complete — create + activate tenant after email + notification setup ──
  // Payment happened before /connect, so we just create the tenant here.
  // Session must be in "billing" step (set after Slack/Teams/skip).

  router.get("/complete", async (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || session.step !== "billing" || !session.stripeCheckoutSessionId) {
      // Direct visit / page refresh after already completing — show success page.
      const companyName = session?.companyName ?? "your company";
      const { connectedLabel, connectedEmail } = session ? emailSummary(session) : { connectedLabel: "Email", connectedEmail: "" };
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderComplete(companyName, connectedLabel, connectedEmail));
      return;
    }

    // Retrieve Stripe checkout to get customer + subscription IDs.
    const checkout = await retrieveCheckoutSession(session.stripeCheckoutSessionId);
    const stripeCustomerId     = typeof checkout.customer     === "string" ? checkout.customer
                               : (checkout.customer as { id?: string } | null)?.id ?? null;
    const stripeSubscriptionId = typeof checkout.subscription === "string" ? checkout.subscription
                               : (checkout.subscription as { id?: string } | null)?.id ?? null;

    const tier  = session.selectedPriceId ? priceIdToTier(session.selectedPriceId) : "starter";
    const notif = session.notificationConfig;
    const { connectedLabel, connectedEmail } = emailSummary(session);
    const emailTo = session.customerEmail || connectedEmail;

    // ── Final abuse gate: check email + company name before creating tenant ──
    const duplicate = await registry.checkForDuplicate(session.companyName, emailTo);
    if (duplicate) {
      await registry.logSignupBlock({
        email:            emailTo,
        companyName:      session.companyName,
        reason:           duplicate.reason,
        matchedTenantId:   duplicate.tenant.id,
        matchedTenantName: duplicate.tenant.name,
      });

      // Cancel the Stripe subscription immediately — they shouldn't be charged.
      if (stripeSubscriptionId && config.stripe.secretKey) {
        try {
          const { getStripe } = await import("../services/billing/StripeService.js");
          await getStripe().subscriptions.cancel(stripeSubscriptionId);
          console.log(`[Onboarding] Cancelled Stripe subscription ${stripeSubscriptionId} for blocked duplicate signup.`);
        } catch (err) {
          console.error("[Onboarding] Failed to cancel Stripe subscription for blocked signup:", err);
        }
      }

      OAuthSessionStore.delete(sessionId);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderError(
        "An account already exists for this company.",
        "Please sign in or contact support@trykaira.ai if you need help. Any payment has been automatically refunded.",
        "/onboarding",
      ));
      return;
    }

    const tenant = await registry.create({
      ...buildEmailProviderInput(session, tier),
      ...(notif && { notification: { provider: notif.provider } }),
      ...(notif?.slack && { slack: notif.slack }),
      ...(notif?.teams && { teams: notif.teams }),
      stripeCustomerId,
      stripeSubscriptionId,
      contactEmail: emailTo,
    });

    await activateTenant(tenant.id, scheduler);
    OAuthSessionStore.update(sessionId, { tenantId: tenant.id, step: "complete" });

    // Fire confirmation email — best-effort, never blocks the response.
    console.log(`[Onboarding] Tenant activated. customerEmail="${session.customerEmail}", connectedEmail="${connectedEmail}", using="${emailTo}", tier="${tier}"`);
    if (emailTo) {
      const notifChannel = notif?.provider === "teams" ? "Microsoft Teams" : "Slack";
      sendWelcomeEmail({
        toEmail:             emailTo,
        companyName:         session.companyName,
        planTier:            tier,
        notificationChannel: notifChannel,
        tenantId:            tenant.id,
      }).then(() => {
        console.log(`[Onboarding] sendWelcomeEmail resolved for ${emailTo}`);
      }).catch((err: unknown) => {
        console.error(`[Onboarding] sendWelcomeEmail rejected for ${emailTo}:`, err);
      });
    } else {
      console.warn("[Onboarding] No email address found in session — skipping welcome email.");
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
  :root {
    --ink:          #0D0D14;
    --ink-soft:     #3D3A52;
    --ink-muted:    #7A778F;
    --purple:       #8B5CF6;
    --purple-mid:   #A78BFA;
    --purple-light: #C4B5FD;
    --purple-pale:  #EDE9FE;
    --purple-ghost: #F5F3FF;
    --white:        #FFFFFF;
    --border:       rgba(139,92,246,0.15);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html { scroll-behavior: smooth; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--white);
    color: var(--ink);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  body::after {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 50% at 15% 0%,   rgba(196,181,253,0.2)  0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 85% 10%,  rgba(167,139,250,0.12) 0%, transparent 55%),
      radial-gradient(ellipse 50% 60% at 50% 100%, rgba(237,233,254,0.28) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  /* ── LAYOUT ── */
  .shell      { width: 100%; max-width: 480px; padding: 2.5rem 1.25rem; position: relative; z-index: 1; }
  .shell-wide { width: 100%; max-width: 880px; padding: 2.5rem 1.25rem; position: relative; z-index: 1; }

  /* ── LOGO ── */
  .logo { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin-bottom: 2.25rem; text-decoration: none; }
  .logo-butterfly { width: 48px; height: 48px; }
  .logo-text { display: flex; flex-direction: column; align-items: center; line-height: 1; gap: 3px; }
  .logo-project { font-family: 'Dancing Script', cursive; font-size: 13px; font-weight: 500; color: var(--purple-mid); letter-spacing: 0.5px; }
  .logo-kaira   { font-family: 'DM Sans', sans-serif; font-size: 15px; font-weight: 600; color: var(--ink); letter-spacing: 4px; text-transform: uppercase; }

  /* ── CARD ── */
  .card {
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 2rem;
    box-shadow: 0 4px 24px rgba(139,92,246,0.07);
  }
  .card-title { font-size: 1.2rem; font-weight: 600; color: var(--ink); margin-bottom: 0.35rem; }
  .card-sub   { font-size: 0.875rem; color: var(--ink-muted); margin-bottom: 1.75rem; line-height: 1.65; }

  /* ── FORM ── */
  label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--ink-soft); margin-bottom: 0.35rem; letter-spacing: 0.02em; }
  .field { margin-bottom: 1rem; }

  input[type="text"], input[type="url"], input[type="email"], input[type="password"] {
    width: 100%;
    background: var(--white);
    border: 1px solid rgba(139,92,246,0.22);
    border-radius: 10px;
    padding: 0.7rem 1rem;
    color: var(--ink);
    font-size: 0.9rem;
    font-family: 'DM Sans', sans-serif;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  input::placeholder { color: var(--ink-muted); }
  input:focus { border-color: var(--purple); box-shadow: 0 0 0 3px rgba(139,92,246,0.1); }

  /* ── BUTTONS ── */
  .btn {
    display: block; width: 100%; padding: 0.8rem 1.25rem;
    border-radius: 100px; border: none;
    font-size: 0.9rem; font-weight: 500; font-family: 'DM Sans', sans-serif;
    cursor: pointer; text-decoration: none; text-align: center;
    letter-spacing: 0.3px; transition: all 0.25s;
  }
  .btn:active { transform: scale(0.98); }

  .btn-ms, .btn-submit { background: var(--ink); color: var(--white); margin-top: 1rem; }
  .btn-ms:hover, .btn-submit:hover {
    background: var(--purple);
    box-shadow: 0 8px 28px rgba(139,92,246,0.3);
    transform: translateY(-1px);
  }

  .btn-imap {
    background: transparent; color: var(--ink-soft);
    border: 1px solid var(--border); margin-top: 0.75rem;
  }
  .btn-imap:hover { border-color: var(--purple); color: var(--purple); transform: translateY(-1px); }

  .btn-skip { background: var(--purple-ghost); color: var(--purple); border: 1px solid rgba(139,92,246,0.25); }
  .btn-skip:hover { background: var(--purple-pale); transform: translateY(-1px); }

  .btn-slack { background: #4A154B; color: var(--white); }
  .btn-slack:hover { opacity: 0.88; transform: translateY(-1px); }

  .btn-teams { background: #5865f2; color: var(--white); margin-top: 0.75rem; }
  .btn-teams:hover { opacity: 0.88; transform: translateY(-1px); }

  .btn-back { background: var(--ink); color: var(--white); margin-top: 1.5rem; }
  .btn-back:hover { background: var(--purple); transform: translateY(-1px); }

  /* ── DIVIDER ── */
  .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0; color: var(--ink-muted); font-size: 0.78rem; letter-spacing: 0.05em; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* ── PILL (connected badge) ── */
  .pill {
    display: inline-flex; align-items: center; gap: 0.4rem;
    background: var(--purple-ghost); border: 1px solid rgba(139,92,246,0.2);
    color: var(--purple); border-radius: 20px;
    padding: 0.3rem 0.8rem; font-size: 0.78rem; font-weight: 500;
    margin-bottom: 1.25rem;
  }

  /* ── ERROR ── */
  .error-msg { background: #FFF1F2; border: 1px solid #FECDD3; color: #BE123C; border-radius: 10px; padding: 0.65rem 1rem; font-size: 0.85rem; margin-bottom: 1rem; }

  /* ── HINT ── */
  .hint { font-size: 0.78rem; color: var(--ink-muted); margin-top: 1rem; line-height: 1.6; text-align: center; }
  .hint a { color: var(--purple); text-decoration: none; }
  .hint a:hover { text-decoration: underline; }

  /* ── STEP DOTS ── */
  .steps { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 2rem; }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(139,92,246,0.15); }
  .step-dot.active { background: var(--purple); }
  .step-dot.done   { background: var(--purple-light); }

  /* ── SUCCESS ── */
  .success-icon  { text-align: center; font-size: 3rem; margin-bottom: 1.25rem; }
  .success-title { font-size: 1.4rem; font-weight: 700; color: var(--ink); text-align: center; margin-bottom: 0.5rem; }
  .success-sub   { font-size: 0.875rem; color: var(--ink-muted); text-align: center; line-height: 1.7; margin-bottom: 1.75rem; }

  .info-row { display: flex; justify-content: space-between; align-items: center; padding: 0.65rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--ink-muted); }
  .info-value { color: var(--ink); font-weight: 500; }
  .tag-purple { background: var(--purple-pale); color: var(--purple); border-radius: 6px; padding: 0.2rem 0.55rem; font-size: 0.75rem; font-weight: 600; }

  /* ── PLANS ── */
  .plans-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; }
  @media (max-width: 640px) { .plans-grid { grid-template-columns: 1fr; } }

  .plan-card {
    background: var(--white); border: 1px solid var(--border); border-radius: 20px;
    padding: 1.75rem 1.5rem; display: flex; flex-direction: column; gap: 1rem;
    position: relative; box-shadow: 0 2px 16px rgba(139,92,246,0.05);
    transition: box-shadow 0.2s, transform 0.2s;
  }
  .plan-card:hover { box-shadow: 0 6px 28px rgba(139,92,246,0.12); transform: translateY(-2px); }
  .plan-card.highlight { border-color: var(--purple); box-shadow: 0 4px 24px rgba(139,92,246,0.15); }

  .plan-badge {
    position: absolute; top: -11px; left: 50%; transform: translateX(-50%);
    background: var(--purple); color: var(--white); font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; padding: 0.2rem 0.7rem;
    border-radius: 20px; white-space: nowrap;
  }

  .plan-name { font-size: 1.05rem; font-weight: 700; color: var(--ink); }
  .plan-desc { font-size: 0.8rem; color: var(--ink-muted); line-height: 1.55; }
  .plan-features { list-style: none; display: flex; flex-direction: column; gap: 0.45rem; flex: 1; }
  .plan-features li { font-size: 0.82rem; color: var(--ink-soft); display: flex; align-items: center; gap: 0.45rem; }
  .plan-features li::before { content: "✓"; color: var(--purple); font-weight: 700; flex-shrink: 0; }

  .btn-plan {
    display: block; width: 100%; padding: 0.7rem 1rem; border-radius: 100px;
    font-size: 0.875rem; font-weight: 500; font-family: 'DM Sans', sans-serif;
    cursor: pointer; text-align: center; letter-spacing: 0.3px; transition: all 0.25s;
    border: 1px solid var(--border); background: transparent; color: var(--ink-soft);
  }
  .plan-card.highlight .btn-plan { background: var(--ink); border-color: var(--ink); color: var(--white); }
  .btn-plan:hover { border-color: var(--purple); color: var(--purple); }
  .plan-card.highlight .btn-plan:hover {
    background: var(--purple); border-color: var(--purple); color: var(--white);
    box-shadow: 0 8px 24px rgba(139,92,246,0.3); transform: translateY(-1px);
  }

  .trial-notice { text-align: center; font-size: 0.78rem; color: var(--ink-muted); margin-top: 1.25rem; line-height: 1.6; }
`;

function html(body: string, wide = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA — Setup</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="${wide ? "shell-wide" : "shell"}">
    <a class="logo" href="/">
      <svg class="logo-butterfly" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 55 C40 40, 15 30, 10 15 C8 8, 18 5, 25 12 C32 19, 42 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C60 40, 85 30, 90 15 C92 8, 82 5, 75 12 C68 19, 58 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C38 65, 12 72, 8 88 C6 95, 18 97, 26 88 C34 79, 44 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C62 65, 88 72, 92 88 C94 95, 82 97, 74 88 C66 79, 56 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <circle cx="50" cy="55" r="3" fill="#8B5CF6" opacity="0.6"/>
        <line x1="50" y1="58" x2="50" y2="78" stroke="#8B5CF6" stroke-width="1.5" opacity="0.4" stroke-linecap="round"/>
      </svg>
      <div class="logo-text">
        <span class="logo-project">Project</span>
        <span class="logo-kaira">Kaira</span>
      </div>
    </a>
    ${body}
  </div>
</body>
</html>`;
}

function renderStep1(nameError?: string, prefillName = "", planError?: string): string {
  const plans = getPlans();

  // Each plan card has its own <form> so it can submit independently.
  // JS mirrors the shared company name input into each form's hidden field.
  const cards = plans.map((plan) => `
    <div class="plan-card${plan.highlight ? " highlight" : ""}">
      ${plan.highlight ? `<div class="plan-badge">Most popular</div>` : ""}
      <div class="plan-name">${escHtml(plan.name)}</div>
      <div class="plan-desc">${escHtml(plan.description)}</div>
      <ul class="plan-features">
        ${plan.features.map((f) => `<li>${escHtml(f)}</li>`).join("")}
      </ul>
      <form method="POST" action="/onboarding/checkout">
        <input type="hidden" name="companyName" class="company-mirror">
        <input type="hidden" name="priceId"     value="${escAttr(plan.priceId)}">
        <button type="submit" class="btn-plan">Start 14-day trial &rarr;</button>
      </form>
    </div>
  `).join("");

  return html(`
    <div class="steps">
      <div class="step-dot active"></div>
      <div class="step-dot"></div>
      <div class="step-dot"></div>
    </div>
    <div style="text-align:center;margin-bottom:1.5rem;">
      <div class="card-title">Choose your plan</div>
      <div class="card-sub" style="margin-bottom:0.75rem;">
        14-day free trial on any plan. No charge until the trial ends.
      </div>
      <div style="max-width:320px;margin:0 auto;">
        <div class="field">
          <label for="companyName">Company name</label>
          <input type="text" id="companyName" name="companyName"
            value="${escAttr(prefillName)}"
            placeholder="Acme Corp" autocomplete="organization">
          ${nameError ? `<div class="error-msg" style="margin-top:0.5rem;">${escHtml(nameError)}</div>` : ""}
        </div>
        ${planError ? `<div class="error-msg">${escHtml(planError)}</div>` : ""}
      </div>
    </div>
    <div class="plans-grid">${cards}</div>
    <p class="trial-notice">
      14-day free trial &bull; Cancel anytime &bull; Secure checkout via Stripe<br>
      By continuing you agree to our
      <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and
      <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
    </p>
    <script>
      const nameInput = document.getElementById('companyName');
      function syncName() {
        document.querySelectorAll('.company-mirror').forEach(m => m.value = nameInput.value);
      }
      nameInput.addEventListener('input', syncName);
      syncName();
      // Prevent plan form submission if company name is empty
      document.querySelectorAll('.plan-card form').forEach(form => {
        form.addEventListener('submit', (e) => {
          if (!nameInput.value.trim()) {
            e.preventDefault();
            nameInput.focus();
            nameInput.style.borderColor = 'var(--purple)';
            nameInput.style.boxShadow   = '0 0 0 3px rgba(139,92,246,0.15)';
          }
        });
      });
    </script>
  `, true);
}

function renderConnect(sessionId: string, companyName: string): string {
  return html(`
    <div class="steps">
      <div class="step-dot done"></div>
      <div class="step-dot active"></div>
      <div class="step-dot"></div>
    </div>
    <div class="card">
      <div class="pill">&#10003; Payment confirmed</div>
      <div class="card-title">Connect your inbox</div>
      <div class="card-sub">
        Now let's connect the email inbox where ${escHtml(companyName)} receives purchase orders.
      </div>
      <form method="POST" action="/onboarding/start">
        <input type="hidden" name="session" value="${escAttr(sessionId)}">
        <button type="submit" name="provider" value="microsoft" class="btn btn-ms">
          Connect Microsoft 365 &rarr;
        </button>
        <div class="divider">or</div>
        <button type="submit" name="provider" value="imap" class="btn btn-imap">
          Connect Gmail / Other Email &rarr;
        </button>
      </form>
      <p class="hint">
        We request read-only access to your inbox. No emails are stored — only extracted PO data.
      </p>
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
        ${connectedEmail ? `<br><span style="color:var(--ink-muted);">Inbox: ${escHtml(connectedEmail)}</span>` : ""}
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
       class="btn btn-skip">
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
        <span class="info-value tag-purple">Connected</span>
      </div>
      ${connectedEmail ? `
      <div class="info-row">
        <span class="info-label">Inbox</span>
        <span class="info-value">${escHtml(connectedEmail)}</span>
      </div>` : ""}
      <div class="info-row">
        <span class="info-label">Trial</span>
        <span class="info-value tag-purple">14 days active</span>
      </div>
      <div class="info-row">
        <span class="info-label">Monitoring</span>
        <span class="info-value tag-purple">Active</span>
      </div>
    </div>
  `);
}

function renderError(title: string, detail: string, backHref = "/onboarding"): string {
  return html(`
    <div class="card">
      <div class="card-title">${escHtml(title)}</div>
      <div class="card-sub" style="margin-top:0.5rem;">${escHtml(detail)}</div>
      <a class="btn btn-back" href="${escAttr(backHref)}">Try again</a>
    </div>
  `);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/"/g, "%22").replace(/'/g, "%27");
}
