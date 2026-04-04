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
    // "consumers" targets personal Microsoft accounts (outlook.com, hotmail.com)
    // Use your actual tenant ID for Microsoft 365 / work accounts
    tenantId: optional("AZURE_TENANT_ID", "consumers"),
    clientId: required("AZURE_CLIENT_ID"),
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

  // ─── App server ─────────────────────────────────────────────────────────
  server: {
    port: parseInt(optional("PORT", "3000"), 10),
    host: optional("HOST", "0.0.0.0"),
  },
};
