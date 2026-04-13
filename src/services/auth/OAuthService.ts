/**
 * OAuthService
 *
 * Handles the self-serve onboarding OAuth flows for Microsoft 365 and Slack.
 *
 * Session lifecycle:
 *   1. POST /onboarding/start        — creates a session keyed by a UUID state param
 *   2. GET  /auth/microsoft/callback — exchanges MS auth code, stores tokens in session
 *   3. GET  /auth/slack/callback     — exchanges Slack code, finalises tenant creation
 *
 * Sessions are held in memory and expire after 1 hour.  If the process restarts
 * mid-onboarding the user simply starts over.
 */

import { randomUUID } from "crypto";
import { config } from "../../config/index.js";

// ─── Session types ────────────────────────────────────────────────────────────

export interface OnboardingSession {
  id: string;
  companyName: string;
  /** Current step in the wizard. */
  step: "email" | "notification" | "billing" | "complete";
  createdAt: number;
  /** Set after Microsoft OAuth completes. Mutually exclusive with `imap`. */
  microsoft?: {
    accessToken: string;
    refreshToken: string;
    /** Unix milliseconds */
    expiresAt: number;
    userEmail: string;
    /** Azure AD tenant ID (directory ID) from the id_token. */
    azureTenantId: string;
  };
  /** Set after the IMAP credentials form is submitted. Mutually exclusive with `microsoft`. */
  imap?: {
    host: string;
    port: number;
    username: string;
    password: string;
    secure: boolean;
  };
  /** Set after the notification channel is connected (Step 2). Carries Slack/Teams
   *  config forward to the billing step so tenant creation happens after payment. */
  notificationConfig?: {
    provider: "slack" | "teams";
    slack?: {
      botToken: string;
      signingSecret: string | null;
      webhookRfq: string | null;
      webhookInquiry: string | null;
      poChannelId: string | null;
      botName: string;
    };
    teams?: { webhookUrl: string };
  };
  /** Stripe Checkout Session ID — set after redirecting to Stripe. */
  stripeCheckoutSessionId?: string;
  /** Price ID the user selected on the plans page. */
  selectedPriceId?: string;
  /** The customer's email address — used for confirmation emails.
   *  Set explicitly on both provider paths so it's always available. */
  customerEmail?: string;
  /** KAIRA tenant UUID — set after the DB row is created. */
  tenantId?: string;
}

// ─── Session store ────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

const sessions = new Map<string, OnboardingSession>();

// Prune expired sessions every 10 minutes.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

export const OAuthSessionStore = {
  create(companyName: string): OnboardingSession {
    const session: OnboardingSession = {
      id: randomUUID(),
      companyName,
      step: "email",
      createdAt: Date.now(),
    };
    sessions.set(session.id, session);
    return session;
  },

  get(id: string): OnboardingSession | null {
    return sessions.get(id) ?? null;
  },

  update(id: string, patch: Partial<OnboardingSession>): OnboardingSession | null {
    const session = sessions.get(id);
    if (!session) return null;
    const updated = { ...session, ...patch };
    sessions.set(id, updated);
    return updated;
  },

  delete(id: string): void {
    sessions.delete(id);
  },
};

// ─── Microsoft 365 OAuth ──────────────────────────────────────────────────────

const MS_OAUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
// offline_access is required for a refresh token.
// User.Read gives us the user's email from the id_token.
const MS_SCOPES = "offline_access Mail.Read User.Read";

export interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export function buildMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     config.oauth.microsoft.clientId,
    response_type: "code",
    redirect_uri:  config.oauth.microsoft.redirectUri,
    response_mode: "query",
    scope:         MS_SCOPES,
    state,
    prompt:        "select_account",
  });
  return `${MS_OAUTH_BASE}/authorize?${params.toString()}`;
}

export async function exchangeMicrosoftCode(
  code: string,
): Promise<MicrosoftTokenResponse> {
  const res = await fetch(`${MS_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     config.oauth.microsoft.clientId,
      client_secret: config.oauth.microsoft.clientSecret,
      code,
      redirect_uri:  config.oauth.microsoft.redirectUri,
      grant_type:    "authorization_code",
      scope:         MS_SCOPES,
    }),
  });
  return res.json() as Promise<MicrosoftTokenResponse>;
}

export async function refreshMicrosoftToken(
  azureTenantId: string,
  refreshToken: string,
): Promise<MicrosoftTokenResponse> {
  const res = await fetch(
    `https://login.microsoftonline.com/${azureTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     config.oauth.microsoft.clientId,
        client_secret: config.oauth.microsoft.clientSecret,
        refresh_token: refreshToken,
        grant_type:    "refresh_token",
        scope:         MS_SCOPES,
      }),
    },
  );
  return res.json() as Promise<MicrosoftTokenResponse>;
}

/**
 * Decode the JWT id_token returned by Microsoft to extract the user's email
 * address and Azure tenant ID without verifying the signature.
 * (The token is already verified by Microsoft before being issued to us.)
 */
export function decodeMicrosoftIdToken(idToken: string): {
  email?: string;
  preferred_username?: string;
  tid?: string;
} {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return {};
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json) as {
      email?: string;
      preferred_username?: string;
      tid?: string;
    };
  } catch {
    return {};
  }
}

/**
 * Fetch the signed-in user's email from Microsoft Graph /me.
 * Falls back to userPrincipalName if the mail field is absent.
 * Returns empty string on any error rather than throwing.
 */
export async function fetchMicrosoftUserEmail(accessToken: string): Promise<string> {
  try {
    const res  = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json() as { mail?: string; userPrincipalName?: string };
    return data.mail ?? data.userPrincipalName ?? "";
  } catch {
    return "";
  }
}

// ─── Slack OAuth ──────────────────────────────────────────────────────────────

const SLACK_SCOPES = "chat:write,incoming-webhook,files:write,channels:read";

export interface SlackOAuthResponse {
  ok: boolean;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
  incoming_webhook?: {
    channel?: string;
    channel_id?: string;
    url?: string;
  };
  error?: string;
}

export function buildSlackAuthUrl(state: string, redirectUri?: string): string {
  const params = new URLSearchParams({
    client_id:    config.oauth.slack.clientId,
    scope:        SLACK_SCOPES,
    redirect_uri: redirectUri ?? config.oauth.slack.redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(
  code: string,
  redirectUri?: string,
): Promise<SlackOAuthResponse> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     config.oauth.slack.clientId,
      client_secret: config.oauth.slack.clientSecret,
      code,
      redirect_uri:  redirectUri ?? config.oauth.slack.redirectUri,
    }),
  });
  return res.json() as Promise<SlackOAuthResponse>;
}
