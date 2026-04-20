// ─── Per-tenant application configuration ────────────────────────────────────
//
// This is the application-level type that all services consume.
// It is derived from the Prisma Tenant model but uses nested sub-objects
// to match the shape the service layer already expects.

export type EmailProviderType = "microsoft" | "imap";

export type PlanTier = "none" | "trial" | "starter" | "growth" | "pro" | "enterprise";

/**
 * Monthly document quotas per plan tier.
 * `null` means unlimited (pro / enterprise).
 *
 * These limits apply whether the tenant is on a trial or a paid subscription —
 * trial is a billing state, not a separate tier.
 */
export const PLAN_DOC_LIMITS: Record<PlanTier, number | null> = {
  none:       0,
  trial:      100,   // fallback only — planTier should never be "trial" in practice
  starter:    100,
  growth:     500,
  pro:        null,
  enterprise: null,
};

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
  /** UPN / email address of the mailbox to monitor (e.g. orders@yourcompany.com).
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
  /** Channel ID for posting new unclaimed POs (e.g. #kaira-unclaimed) */
  poChannelId: string | null;
  /** Channel ID for posting "✅ Claimed" summaries (e.g. #kaira-claimed) */
  claimedChannelId: string | null;
  /** Slack workspace / team ID — used to route slash commands to this tenant */
  teamId: string | null;
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

  // ── Trial & billing ───────────────────────────────────────────────────────
  planTier: PlanTier;
  isTrialActive: boolean;
  trialStartDate: Date | null;
  trialEndDate: Date | null;
  /** True once the tenant has consumed their monthly document quota. */
  trialLimitReached: boolean;
  /** Running count of documents processed this calendar month. */
  monthlyDocCount: number;
  /** When the monthly count was last reset. Null means never reset. */
  monthlyDocResetAt: Date | null;

  /** Stripe customer ID — set after Stripe Checkout completes. */
  stripeCustomerId: string | null;
  /** Stripe subscription ID — set after Stripe Checkout completes. */
  stripeSubscriptionId: string | null;
  /** Customer's own email address, used for the "find my account" recovery flow. */
  contactEmail: string;

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
  // ── Trial & billing ─────────────────────────────────────────────────────
  planTier?: PlanTier;
  isTrialActive?: boolean;
  trialStartDate?: Date | null;
  trialEndDate?: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  contactEmail?: string;
}

/** Any subset of fields that can be changed after creation. */
export type UpdateTenantInput = Partial<CreateTenantInput>;
