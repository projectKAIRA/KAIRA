// ─── Per-tenant application configuration ────────────────────────────────────
//
// This is the application-level type that all services consume.
// It is derived from the Prisma Tenant model but uses nested sub-objects
// to match the shape the service layer already expects.

export type EmailProviderType = "microsoft" | "imap";

// ─── Microsoft Graph config ───────────────────────────────────────────────────

export interface TenantGraphConfig {
  /** Azure AD application (client) ID */
  clientId: string;
  /** Azure AD client secret */
  clientSecret: string;
  /** Azure AD tenant ID (directory ID) for the customer's Microsoft 365 org */
  tenantId: string;
  /**
   * Authentication mode.
   * - "app_only"    — ClientSecretCredential. Requires a work/school Azure AD account.
   * - "device_code" — DeviceCodeCredential. Works with personal @outlook.com accounts.
   * - "oauth"       — Delegated OAuth 2.0 via self-serve onboarding. Uses a refresh
   *                   token stored in the DB; tokens are auto-renewed on expiry.
   */
  authMode: "app_only" | "device_code" | "oauth";
  /** Delegated OAuth refresh token (authMode === "oauth" only). */
  refreshToken?: string | null;
  /** Delegated OAuth access token (authMode === "oauth" only). */
  accessToken?: string | null;
  /** Access token expiry (authMode === "oauth" only). */
  tokenExpiresAt?: Date | null;
  /** UPN / email address of the mailbox to monitor (e.g. orders@leespring.com).
   *  Used to construct /users/{userEmail}/ Graph API endpoints. */
  userEmail: string;
  /** Mail folder to monitor, e.g. "inbox" */
  inboxFolder: string;
  /** Polling interval in seconds */
  pollIntervalSeconds: number;
}

// ─── IMAP config ──────────────────────────────────────────────────────────────

export interface TenantImapConfig {
  /** IMAP server hostname, e.g. "imap.gmail.com" or "imap.mail.yahoo.com" */
  host: string;
  /** IMAP port — 993 for TLS, 143 for STARTTLS */
  port: number;
  /** true = TLS (recommended), false = STARTTLS */
  secure: boolean;
  /** Login username — usually the full email address */
  username: string;
  /** App password (not the account password).
   *  Gmail: Settings → Security → App passwords.
   *  Yahoo: Account Security → Generate app password. */
  password: string;
  /** Mailbox folder to monitor, e.g. "INBOX" */
  inboxFolder: string;
  /** Polling interval in seconds */
  pollIntervalSeconds: number;
}

// ─── Notification configs ─────────────────────────────────────────────────────

export interface TenantSlackConfig {
  /** Bot User OAuth Token (xoxb-...) */
  botToken: string | null;
  /** Signing secret for verifying interaction payloads */
  signingSecret: string | null;
  /** Incoming Webhook URL for #request-for-quote */
  webhookRfq: string | null;
  /** Incoming Webhook URL for #general-inquiry */
  webhookInquiry: string | null;
  /** Channel ID for posting POs via Web API */
  poChannelId: string | null;
  /** Display name for the bot */
  botName: string;
}

export interface TenantTeamsConfig {
  /** Teams Incoming Webhook URL */
  webhookUrl: string | null;
}

export type NotificationProvider = "slack" | "teams";

// ─── Unified tenant config ────────────────────────────────────────────────────

export interface TenantConfig {
  id: string;
  name: string;
  isActive: boolean;

  /** Which email backend this tenant uses. */
  providerType: EmailProviderType;

  /** Microsoft Graph config — populated when providerType === "microsoft" */
  graph: TenantGraphConfig;

  /** IMAP config — populated when providerType === "imap", null otherwise */
  imap: TenantImapConfig | null;

  notification: {
    provider: NotificationProvider;
  };

  slack: TenantSlackConfig;
  teams: TenantTeamsConfig;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Input types for create / update ─────────────────────────────────────────

/** All fields required when onboarding a new tenant. */
export interface CreateTenantInput {
  name: string;
  isActive?: boolean;
  /** Required when providerType === "microsoft" (or omitted, as microsoft is the default) */
  graph?: Partial<TenantGraphConfig>;
  /** Required when providerType === "imap" */
  imap?: Partial<TenantImapConfig>;
  providerType?: EmailProviderType;
  notification?: { provider?: NotificationProvider };
  slack?: Partial<TenantSlackConfig>;
  teams?: Partial<TenantTeamsConfig>;
}

/** Any subset of fields that can be changed after creation. */
export type UpdateTenantInput = Partial<CreateTenantInput>;
