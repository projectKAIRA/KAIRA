import dotenv from "dotenv";

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  // ─── Microsoft Graph (Azure AD app registration) ────────────────────────
  graph: {
    // Azure AD directory (tenant) ID for the customer's Microsoft 365 org
    tenantId: optional("AZURE_TENANT_ID", "consumers"),
    clientId: optional("AZURE_CLIENT_ID", ""),
    // Client secret for app-only (non-interactive) authentication
    clientSecret: optional("AZURE_CLIENT_SECRET", ""),
    // UPN / email of the mailbox to monitor (e.g. orders@leespring.com)
    userEmail: optional("GRAPH_USER_EMAIL", ""),
    // Folder to watch (defaults to "inbox")
    inboxFolderName: optional("GRAPH_INBOX_FOLDER", "inbox"),
    // How often to poll for new messages (seconds)
    pollIntervalSeconds: parseInt(optional("POLL_INTERVAL_SECONDS", "60"), 10),
  },

  // ─── Anthropic / Claude ─────────────────────────────────────────────────
  claude: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("CLAUDE_MODEL", "claude-opus-4-6"),
  },

  // ─── Notification layer ──────────────────────────────────────────────────
  // Set NOTIFICATION_PROVIDER to "slack" or "teams"
  notification: {
    provider: optional("NOTIFICATION_PROVIDER", "slack") as "slack" | "teams",

    // Slack
    slack: {
      // Bot token — required for Web API (chat.update, DMs, file uploads)
      botToken: optional("SLACK_BOT_TOKEN", ""),
      // Signing secret — used to verify interaction payloads from Slack
      signingSecret: optional("SLACK_SIGNING_SECRET", ""),
      // Per-type webhook URLs
      webhookPo: optional("SLACK_WEBHOOK_PO", ""),
      webhookRfq: optional("SLACK_WEBHOOK_RFQ", ""),
      webhookInquiry: optional("SLACK_WEBHOOK_INQUIRY", ""),
      // Channel name for PO posting via Web API (e.g. #purchase-orders)
      poChannel: optional("SLACK_PO_CHANNEL", "#purchase-orders"),
      botName: optional("SLACK_BOT_NAME", "KAIRA"),
    },

    // Microsoft Teams (for future swap)
    teams: {
      webhookUrl: optional("TEAMS_WEBHOOK_URL", ""),
    },
  },

  // ─── Self-serve OAuth app credentials ───────────────────────────────────
  // These are KAIRA's own Azure/Slack app registrations used for the
  // onboarding authorization code flow.  Different from per-tenant credentials.
  oauth: {
    microsoft: {
      clientId:     optional("OAUTH_MICROSOFT_CLIENT_ID", ""),
      clientSecret: optional("OAUTH_MICROSOFT_CLIENT_SECRET", ""),
      redirectUri:  optional(
        "OAUTH_MICROSOFT_REDIRECT_URI",
        "http://localhost:3000/onboarding/auth/microsoft/callback",
      ),
    },
    slack: {
      clientId:      optional("OAUTH_SLACK_CLIENT_ID", ""),
      clientSecret:  optional("OAUTH_SLACK_CLIENT_SECRET", ""),
      redirectUri:   optional(
        "OAUTH_SLACK_REDIRECT_URI",
        "http://localhost:3000/onboarding/auth/slack/callback",
      ),
      // Signing secret for verifying Slack interaction payloads.
      // Same for every installation of the KAIRA Slack app.
      signingSecret: optional("OAUTH_SLACK_SIGNING_SECRET", ""),
    },
    // Public base URL of this server (used to build redirect URIs)
    baseUrl: optional("APP_BASE_URL", "http://localhost:3000"),
  },

  // ─── Stripe ──────────────────────────────────────────────────────────────────
  stripe: {
    secretKey:     optional("STRIPE_SECRET_KEY", ""),
    webhookSecret: optional("STRIPE_WEBHOOK_SECRET", ""),
    prices: {
      starter: optional("STRIPE_PRICE_STARTER", ""),
      growth:  optional("STRIPE_PRICE_GROWTH",  ""),
      pro:     optional("STRIPE_PRICE_PRO",     ""),
    },
  },

  // ─── Admin dashboard ─────────────────────────────────────────────────────
  admin: {
    password: optional("ADMIN_PASSWORD", ""),
  },

  // ─── App server ─────────────────────────────────────────────────────────
  server: {
    port: parseInt(optional("PORT", "3000"), 10),
    host: optional("HOST", "0.0.0.0"),
  },
};
