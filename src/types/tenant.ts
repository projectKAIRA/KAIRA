// ─── Per-tenant application configuration ────────────────────────────────────
//
// This is the application-level type that all services consume.
// It is derived from the Prisma Tenant model but uses nested sub-objects
// to match the shape the service layer already expects.

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
   *                   Use this in production.
   * - "device_code" — DeviceCodeCredential. Works with personal @outlook.com accounts.
   *                   Prompts for an interactive login on first run. Use for testing only.
   */
  authMode: "app_only" | "device_code";
  /** UPN / email address of the mailbox to monitor (e.g. orders@leespring.com).
   *  Used to construct /users/{userEmail}/ Graph API endpoints. */
  userEmail: string;
  /** Mail folder to monitor, e.g. "inbox" */
  inboxFolder: string;
  /** Polling interval in seconds */
  pollIntervalSeconds: number;
}

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

export interface TenantConfig {
  id: string;
  name: string;
  isActive: boolean;

  graph: TenantGraphConfig;

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
  graph: TenantGraphConfig;
  notification?: { provider?: NotificationProvider };
  slack?: Partial<TenantSlackConfig>;
  teams?: Partial<TenantTeamsConfig>;
}

/** Any subset of fields that can be changed after creation. */
export type UpdateTenantInput = Partial<CreateTenantInput>;
