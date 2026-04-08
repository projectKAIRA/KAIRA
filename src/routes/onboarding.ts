/**
 * Self-serve onboarding flow.
 *
 * Step 1  GET  /onboarding              — Company name form
 *         POST /onboarding/start        — Create session, redirect to Microsoft OAuth
 *         GET  /auth/microsoft/callback — Exchange MS code, store tokens, redirect to step 2
 *
 * Step 2  GET  /onboarding/step2        — Connect Slack or Teams
 *         GET  /auth/slack/start        — Redirect to Slack OAuth
 *         GET  /auth/slack/callback     — Exchange Slack code, create tenant, activate, complete
 *         POST /onboarding/teams        — Accept Teams webhook URL, create tenant, activate, complete
 *
 * Done    GET  /onboarding/complete     — Success page
 */

import express, { Request, Response, Router } from "express";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { config } from "../config/index.js";
import {
  OAuthSessionStore,
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  decodeMicrosoftIdToken,
  buildSlackAuthUrl,
  exchangeSlackCode,
} from "../services/auth/OAuthService.js";

const registry = new TenantRegistry();

export function createOnboardingRouter(scheduler: TenantScheduler): Router {
  const router = Router();

  // Parse URL-encoded form bodies only for this router.
  router.use(express.urlencoded({ extended: false }));

  // ─── Step 1 — Landing page ─────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderStep1());
  });

  // ─── Step 1 — Start: create session, redirect to Microsoft OAuth ───────────

  router.post("/start", (req: Request, res: Response) => {
    const companyName = (req.body.companyName as string | undefined)?.trim() ?? "";

    if (!companyName) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep1("Company name is required."));
      return;
    }

    if (!config.oauth.microsoft.clientId) {
      res.status(503).send(renderError(
        "Microsoft OAuth is not configured.",
        "Set OAUTH_MICROSOFT_CLIENT_ID and OAUTH_MICROSOFT_CLIENT_SECRET in your environment.",
      ));
      return;
    }

    const session  = OAuthSessionStore.create(companyName);
    const authUrl  = buildMicrosoftAuthUrl(session.id);

    res.redirect(authUrl);
  });

  // ─── Microsoft OAuth callback ──────────────────────────────────────────────

  router.get("/auth/microsoft/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      res.send(renderError(
        "Microsoft authorisation failed.",
        error_description ?? error,
      ));
      return;
    }

    const session = OAuthSessionStore.get(state);
    if (!session) {
      res.send(renderError(
        "Session not found or expired.",
        "Please start the onboarding process again.",
        "/onboarding",
      ));
      return;
    }

    // Exchange the authorisation code for tokens.
    const tokens = await exchangeMicrosoftCode(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      res.send(renderError(
        "Token exchange failed.",
        tokens.error_description ?? tokens.error ?? "Microsoft did not return tokens.",
      ));
      return;
    }

    const claims   = tokens.id_token ? decodeMicrosoftIdToken(tokens.id_token) : {};
    const userEmail = claims.preferred_username ?? claims.email ?? "";
    const azureTenantId = claims.tid ?? "common";
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    OAuthSessionStore.update(state, {
      step: "notification",
      microsoft: {
        accessToken:    tokens.access_token,
        refreshToken:   tokens.refresh_token,
        expiresAt,
        userEmail,
        azureTenantId,
      },
    });

    res.redirect(`/onboarding/step2?session=${encodeURIComponent(state)}`);
  });

  // ─── Step 2 — Notification channel ────────────────────────────────────────

  router.get("/step2", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || session.step !== "notification" || !session.microsoft) {
      res.redirect("/onboarding");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderStep2(sessionId, session.microsoft.userEmail, session.companyName));
  });

  // ─── Slack OAuth start ─────────────────────────────────────────────────────

  router.get("/auth/slack/start", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const session   = OAuthSessionStore.get(sessionId);

    if (!session || !session.microsoft) {
      res.redirect("/onboarding");
      return;
    }

    if (!config.oauth.slack.clientId) {
      res.status(503).send(renderError(
        "Slack OAuth is not configured.",
        "Set OAUTH_SLACK_CLIENT_ID and OAUTH_SLACK_CLIENT_SECRET in your environment.",
      ));
      return;
    }

    res.redirect(buildSlackAuthUrl(sessionId));
  });

  // ─── Slack OAuth callback ──────────────────────────────────────────────────

  router.get("/auth/slack/callback", async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.send(renderError("Slack authorisation failed.", error));
      return;
    }

    const session = OAuthSessionStore.get(state);
    if (!session || !session.microsoft) {
      res.send(renderError(
        "Session not found or expired.",
        "Please start the onboarding process again.",
        "/onboarding",
      ));
      return;
    }

    const slack = await exchangeSlackCode(code);

    if (!slack.ok || !slack.access_token) {
      res.send(renderError(
        "Slack token exchange failed.",
        slack.error ?? "Slack did not return an access token.",
      ));
      return;
    }

    const tenant = await registry.create({
      name:         session.companyName,
      isActive:     false,
      providerType: "microsoft",
      ...trialDefaults(),
      graph: {
        authMode:      "oauth",
        tenantId:      session.microsoft.azureTenantId,
        userEmail:     session.microsoft.userEmail,
        accessToken:   session.microsoft.accessToken,
        refreshToken:  session.microsoft.refreshToken,
        tokenExpiresAt: new Date(session.microsoft.expiresAt),
        inboxFolder:   "inbox",
        pollIntervalSeconds: 60,
      },
      notification: { provider: "slack" },
      slack: {
        botToken:       slack.access_token,
        signingSecret:  config.oauth.slack.signingSecret || null,
        webhookRfq:     slack.incoming_webhook?.url ?? null,
        webhookInquiry: slack.incoming_webhook?.url ?? null,
        poChannelId:    slack.incoming_webhook?.channel_id ?? null,
        botName:        "KAIRA",
      },
    });

    await activateTenant(tenant.id, scheduler);
    OAuthSessionStore.update(state, { tenantId: tenant.id, step: "complete" });

    res.redirect(`/onboarding/complete?session=${encodeURIComponent(state)}&provider=slack`);
  });

  // ─── Teams — manual webhook URL ───────────────────────────────────────────

  router.post("/teams", async (req: Request, res: Response) => {
    const sessionId  = (req.body.session  as string | undefined) ?? "";
    const webhookUrl = (req.body.webhookUrl as string | undefined)?.trim() ?? "";

    const session = OAuthSessionStore.get(sessionId);
    if (!session || !session.microsoft) {
      res.redirect("/onboarding");
      return;
    }

    if (!webhookUrl.startsWith("https://")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderStep2(
        sessionId,
        session.microsoft.userEmail,
        session.companyName,
        "Webhook URL must start with https://",
      ));
      return;
    }

    const tenant = await registry.create({
      name:         session.companyName,
      isActive:     false,
      providerType: "microsoft",
      ...trialDefaults(),
      graph: {
        authMode:      "oauth",
        tenantId:      session.microsoft.azureTenantId,
        userEmail:     session.microsoft.userEmail,
        accessToken:   session.microsoft.accessToken,
        refreshToken:  session.microsoft.refreshToken,
        tokenExpiresAt: new Date(session.microsoft.expiresAt),
        inboxFolder:   "inbox",
        pollIntervalSeconds: 60,
      },
      notification: { provider: "teams" },
      teams: { webhookUrl },
    });

    await activateTenant(tenant.id, scheduler);
    OAuthSessionStore.update(sessionId, { tenantId: tenant.id, step: "complete" });

    res.redirect(`/onboarding/complete?session=${encodeURIComponent(sessionId)}&provider=teams`);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────

  router.get("/complete", (req: Request, res: Response) => {
    const sessionId = (req.query.session as string | undefined) ?? "";
    const provider  = (req.query.provider as string | undefined) ?? "slack";
    const session   = OAuthSessionStore.get(sessionId);

    const companyName = session?.companyName ?? "your company";
    const userEmail   = session?.microsoft?.userEmail ?? "";

    // Clean up the session — it's no longer needed.
    OAuthSessionStore.delete(sessionId);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderComplete(companyName, userEmail, provider));
  });

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 14-day trial starting now. */
function trialDefaults() {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 14);
  return {
    planTier:      "trial" as const,
    isTrialActive: true,
    trialStartDate: now,
    trialEndDate:  end,
  };
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
  .shell {
    width: 100%;
    max-width: 480px;
    padding: 2rem 1rem;
  }
  .logo {
    text-align: center;
    margin-bottom: 2.5rem;
  }
  .logo-name {
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: #fff;
  }
  .logo-tagline {
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    color: #666;
    text-transform: uppercase;
    margin-top: 0.25rem;
  }
  .card {
    background: #161616;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    padding: 2rem;
  }
  .card-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: #fff;
    margin-bottom: 0.4rem;
  }
  .card-sub {
    font-size: 0.85rem;
    color: #888;
    margin-bottom: 1.75rem;
    line-height: 1.5;
  }
  label {
    display: block;
    font-size: 0.82rem;
    font-weight: 500;
    color: #aaa;
    margin-bottom: 0.4rem;
    letter-spacing: 0.02em;
  }
  input[type="text"], input[type="url"] {
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
  input[type="text"]:focus, input[type="url"]:focus {
    border-color: #5865f2;
  }
  .btn {
    display: block;
    width: 100%;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    border: none;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    text-align: center;
    transition: opacity 0.15s, transform 0.1s;
  }
  .btn:active { transform: scale(0.98); }
  .btn-ms {
    background: #0078d4;
    color: #fff;
    margin-top: 1.25rem;
  }
  .btn-ms:hover { opacity: 0.9; }
  .btn-slack {
    background: #4a154b;
    color: #fff;
  }
  .btn-slack:hover { opacity: 0.9; }
  .btn-teams {
    background: #5865f2;
    color: #fff;
    margin-top: 0.75rem;
  }
  .btn-teams:hover { opacity: 0.9; }
  .divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.5rem 0;
    color: #444;
    font-size: 0.8rem;
    letter-spacing: 0.05em;
  }
  .divider::before, .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: #2a2a2a;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: #0d2b12;
    border: 1px solid #1a5c2a;
    color: #4ade80;
    border-radius: 20px;
    padding: 0.3rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 1.5rem;
  }
  .error-msg {
    background: #2a0e0e;
    border: 1px solid #5c1a1a;
    color: #f87171;
    border-radius: 8px;
    padding: 0.65rem 0.85rem;
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }
  .hint {
    font-size: 0.78rem;
    color: #555;
    margin-top: 1rem;
    line-height: 1.5;
    text-align: center;
  }
  .steps {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    margin-bottom: 2rem;
  }
  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2a2a2a;
  }
  .step-dot.active { background: #5865f2; }
  .step-dot.done   { background: #4ade80; }
  .success-icon {
    text-align: center;
    font-size: 3.5rem;
    margin-bottom: 1.25rem;
  }
  .success-title {
    font-size: 1.4rem;
    font-weight: 700;
    color: #fff;
    text-align: center;
    margin-bottom: 0.5rem;
  }
  .success-sub {
    font-size: 0.88rem;
    color: #888;
    text-align: center;
    line-height: 1.6;
    margin-bottom: 1.5rem;
  }
  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 0;
    border-bottom: 1px solid #222;
    font-size: 0.85rem;
  }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: #666; }
  .info-value { color: #e8e8e8; font-weight: 500; }
  .tag-green {
    background: #0d2b12;
    color: #4ade80;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
  }
`;

function html(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA — Setup</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="shell">
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
    </div>
    <div class="card">
      <div class="card-title">Let's get you set up</div>
      <div class="card-sub">Connect your Microsoft 365 inbox so KAIRA can start monitoring purchase orders automatically.</div>
      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}
      <form method="POST" action="/onboarding/start">
        <label for="companyName">Company name</label>
        <input type="text" id="companyName" name="companyName" placeholder="Acme Corp" autocomplete="organization" required>
        <button type="submit" class="btn btn-ms">
          Connect Microsoft 365 &rarr;
        </button>
      </form>
      <p class="hint">We request read-only access to your inbox. No emails are stored — only extracted PO data.</p>
    </div>
  `);
}

function renderStep2(sessionId: string, userEmail: string, companyName: string, errorMsg?: string): string {
  const slackConfigured = !!config.oauth.slack.clientId;
  const slackButton = slackConfigured
    ? `<a class="btn btn-slack" href="/onboarding/auth/slack/start?session=${encodeURIComponent(sessionId)}">
        Add to Slack &rarr;
       </a>`
    : `<p style="color:#555;font-size:0.82rem;margin-top:0.5rem;">Slack OAuth not configured (set OAUTH_SLACK_CLIENT_ID).</p>`;

  return html(`
    <div class="steps">
      <div class="step-dot done"></div>
      <div class="step-dot active"></div>
    </div>
    <div class="card">
      <div class="pill">&#10003; Microsoft 365 connected</div>
      <div class="card-title">Connect your notification channel</div>
      <div class="card-sub">Choose where ${escHtml(companyName)} should receive purchase order alerts.
        ${userEmail ? `<br><span style="color:#666;">Inbox: ${escHtml(userEmail)}</span>` : ""}
      </div>
      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}

      ${slackButton}

      <div class="divider">or use Microsoft Teams</div>

      <form method="POST" action="/onboarding/teams">
        <input type="hidden" name="session" value="${escAttr(sessionId)}">
        <label for="webhookUrl">Teams incoming webhook URL</label>
        <input type="url" id="webhookUrl" name="webhookUrl" placeholder="https://outlook.office.com/webhook/..." required>
        <button type="submit" class="btn btn-teams">Connect Teams &rarr;</button>
      </form>

      <p class="hint">
        Teams webhook: open a channel &rarr; Connectors &rarr; Incoming Webhook &rarr; copy the URL.
      </p>
    </div>
  `);
}

function renderComplete(companyName: string, userEmail: string, provider: string): string {
  const providerLabel = provider === "teams" ? "Microsoft Teams" : "Slack";
  return html(`
    <div class="card">
      <div class="success-icon">&#9989;</div>
      <div class="success-title">KAIRA is live!</div>
      <div class="success-sub">
        ${escHtml(companyName)}'s inbox is now being monitored.<br>
        Purchase orders will appear in ${providerLabel} within the next polling cycle.
      </div>
      <div class="info-row">
        <span class="info-label">Microsoft 365</span>
        <span class="info-value tag-green">Connected</span>
      </div>
      ${userEmail ? `
      <div class="info-row">
        <span class="info-label">Inbox</span>
        <span class="info-value">${escHtml(userEmail)}</span>
      </div>` : ""}
      <div class="info-row">
        <span class="info-label">Notifications</span>
        <span class="info-value tag-green">${escHtml(providerLabel)}</span>
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
