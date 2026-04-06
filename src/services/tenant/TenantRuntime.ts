import { TenantConfig } from "../../types/tenant.js";
import { GraphService } from "../graph/GraphService.js";
import { ClaudeService } from "../claude/ClaudeService.js";
import { POTracker } from "../po/POTracker.js";
import { EmailProcessor } from "../email/EmailProcessor.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { SlackNotificationService } from "../notifications/SlackNotificationService.js";
import { TeamsNotificationService } from "../notifications/TeamsNotificationService.js";
import { SlackInteractionService } from "../notifications/SlackInteractionService.js";

/**
 * TenantRuntime
 *
 * Bundles every per-tenant service instance into a single object.
 * One TenantRuntime is created per active tenant and held by the
 * TenantScheduler (Phase 6).
 *
 * Construction is intentionally synchronous — all services receive their
 * config at build time and connect lazily on first use.
 */
export class TenantRuntime {
  readonly tenantId:    string;
  readonly config:      TenantConfig;
  readonly graph:       GraphService;
  readonly claude:      ClaudeService;
  readonly tracker:     POTracker;
  readonly notifier:    NotificationService;
  readonly processor:   EmailProcessor;
  /** Non-null only when the tenant uses Slack and has a signing secret configured. */
  readonly interactions: SlackInteractionService | null;

  /**
   * @param tenantConfig  Full per-tenant configuration from TenantRegistry.
   * @param claudeApiKey  Platform-level Anthropic API key (shared across tenants).
   * @param claudeModel   Claude model ID (platform-level default).
   */
  constructor(
    tenantConfig: TenantConfig,
    claudeApiKey: string,
    claudeModel:  string,
  ) {
    this.tenantId = tenantConfig.id;
    this.config   = tenantConfig;

    this.graph   = new GraphService(tenantConfig.id, tenantConfig.graph);
    this.claude  = new ClaudeService(claudeApiKey, claudeModel);
    this.tracker = new POTracker(tenantConfig.id);

    this.notifier = buildNotifier(tenantConfig, this.tracker);
    this.processor = new EmailProcessor(this.graph, this.claude, this.notifier);
    this.interactions = buildInteractions(tenantConfig, this.notifier, this.tracker);

    console.log(
      `[TenantRuntime] Initialised tenant "${tenantConfig.name}" ` +
      `(${tenantConfig.id}) — provider: ${tenantConfig.notification.provider}` +
      (this.interactions ? ", interactions: enabled" : ""),
    );
  }
}

// ─── Private builders ─────────────────────────────────────────────────────────

function buildNotifier(config: TenantConfig, tracker: POTracker): NotificationService {
  const { provider } = config.notification;

  switch (provider) {
    case "slack": {
      const s = config.slack;
      if (!s.botToken) {
        throw new Error(
          `[TenantRuntime] Tenant "${config.name}" is configured for Slack but SLACK_BOT_TOKEN is missing.`,
        );
      }
      return new SlackNotificationService(
        {
          botToken:      s.botToken,
          poChannel:     s.poChannelId    ?? "",
          webhookRfq:    s.webhookRfq     ?? "",
          webhookInquiry: s.webhookInquiry ?? "",
          botName:       s.botName,
        },
        tracker,
      );
    }

    case "teams": {
      const t = config.teams;
      if (!t.webhookUrl) {
        throw new Error(
          `[TenantRuntime] Tenant "${config.name}" is configured for Teams but TEAMS_WEBHOOK_URL is missing.`,
        );
      }
      return new TeamsNotificationService({ webhookUrl: t.webhookUrl });
    }

    default: {
      // TypeScript exhaustiveness — this branch is unreachable if NotificationProvider
      // is kept in sync with the switch arms above.
      const _: never = provider;
      throw new Error(`[TenantRuntime] Unknown notification provider: "${provider}"`);
    }
  }
}

function buildInteractions(
  config:  TenantConfig,
  notifier: NotificationService,
  tracker:  POTracker,
): SlackInteractionService | null {
  if (!(notifier instanceof SlackNotificationService)) return null;

  const signingSecret = config.slack.signingSecret;
  if (!signingSecret) {
    console.warn(
      `[TenantRuntime] Tenant "${config.name}" has no Slack signing secret — ` +
      `Claim Order button will not work.`,
    );
    return null;
  }

  return new SlackInteractionService(signingSecret, notifier, tracker);
}
