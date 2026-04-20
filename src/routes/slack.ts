/**
 * Slack OAuth connect flow for existing tenants.
 *
 * Allows a tenant to connect (or reconnect) their Slack workspace from the
 * dashboard after onboarding has already completed.
 *
 * Mounted at /auth/slack in app.ts.
 *
 *   GET /auth/slack?tenantId=<uuid>         — redirect to Slack OAuth
 *   GET /auth/slack/callback?code=…&state=… — exchange code, save to tenant, back to dashboard
 *
 * The tenant ID is carried through the OAuth state parameter.
 * The redirect URI registered in the Slack app must be:
 *   https://trykaira.ai/auth/slack/callback
 */

import { Router, Request, Response } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { config } from "../config/index.js";
import {
  buildSlackAuthUrl,
  exchangeSlackCode,
} from "../services/auth/OAuthService.js";

export function createSlackRouter(scheduler: TenantScheduler): Router {
  const router   = Router();
  const registry = new TenantRegistry();

  // Redirect URI used for this flow — must match the Slack app config.
  const REDIRECT_URI = `${config.oauth.baseUrl}/auth/slack/callback`;

  // ─── GET /auth/slack ───────────────────────────────────────────────────────
  // Initiate Slack OAuth. Requires ?tenantId=<uuid> so we know which tenant
  // to update in the callback. The tenant ID is passed as the OAuth state param.

  router.get("/", async (req: Request, res: Response) => {
    const tenantId = (req.query.tenantId as string | undefined)?.trim() ?? "";

    if (!tenantId) {
      res.status(400).send("Missing required query parameter: tenantId");
      return;
    }

    const tenant = await registry.findById(tenantId);
    if (!tenant) {
      res.status(404).send("Tenant not found.");
      return;
    }

    if (!config.oauth.slack.clientId) {
      res.status(503).send("Slack OAuth is not configured (OAUTH_SLACK_CLIENT_ID missing).");
      return;
    }

    const authUrl = buildSlackAuthUrl(tenantId, REDIRECT_URI);
    res.redirect(authUrl);
  });

  // ─── GET /auth/slack/callback ──────────────────────────────────────────────
  // Slack redirects here after the user authorises the app.
  // Exchange the code, update the tenant's Slack credentials, reload scheduler.

  router.get("/callback", async (req: Request, res: Response) => {
    const { code, state: tenantId, error } = req.query as Record<string, string>;

    if (error) {
      console.warn(`[SlackConnect] OAuth error for tenant ${tenantId}: ${error}`);
      res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&slack_error=${encodeURIComponent(error)}`);
      return;
    }

    if (!code || !tenantId) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }

    const tenant = await registry.findById(tenantId);
    if (!tenant) {
      res.status(404).send("Tenant not found.");
      return;
    }

    const slack = await exchangeSlackCode(code, REDIRECT_URI);

    if (!slack.ok || !slack.access_token) {
      console.error(`[SlackConnect] Token exchange failed for tenant ${tenantId}:`, slack.error);
      res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&slack_error=${encodeURIComponent(slack.error ?? "token_exchange_failed")}`);
      return;
    }

    // Persist the new Slack credentials to the tenant row.
    const updated = await registry.update(tenantId, {
      notification: { provider: "slack" },
      slack: {
        botToken:       slack.access_token,
        signingSecret:  config.oauth.slack.signingSecret || null,
        webhookRfq:     slack.incoming_webhook?.url       ?? null,
        webhookInquiry: slack.incoming_webhook?.url       ?? null,
        poChannelId:    slack.incoming_webhook?.channel_id ?? null,
        teamId:         slack.team?.id                    ?? null,
        botName:        "KAIRA",
      },
    });

    console.log(`[SlackConnect] Slack connected for tenant "${updated.name}" (${tenantId}) — channel: ${slack.incoming_webhook?.channel ?? "unknown"}`);

    // Rebuild the scheduler runtime so the new credentials take effect immediately.
    if (scheduler.getRuntime(tenantId)) {
      scheduler.removeTenant(tenantId);
      if (updated.isActive) {
        await scheduler.addTenant(updated);
      }
    }

    res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&slack_connected=1`);
  });

  return router;
}
