import { getPrismaClient } from "../../lib/prisma.js";
import {
  TenantConfig,
  CreateTenantInput,
  UpdateTenantInput,
  NotificationProvider,
} from "../../types/tenant.js";
import { PrismaClient, NotificationProvider as PrismaNotificationProvider } from "@prisma/client";

// Row type inferred from the generated client
type TenantRow = Awaited<ReturnType<PrismaClient["tenant"]["findUniqueOrThrow"]>>;

/**
 * TenantRegistry
 *
 * Single source of truth for tenant lifecycle management.
 * Wraps Prisma CRUD operations and converts between the flat database
 * representation and the nested TenantConfig used by the service layer.
 */
export class TenantRegistry {
  private db: PrismaClient;

  constructor() {
    this.db = getPrismaClient();
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Return all tenants (active and inactive). */
  async findAll(): Promise<TenantConfig[]> {
    const rows = await this.db.tenant.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toConfig);
  }

  /** Return all active tenants — used by the scheduler at startup. */
  async findActive(): Promise<TenantConfig[]> {
    const rows = await this.db.tenant.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toConfig);
  }

  /** Find a single tenant by ID. Returns null if not found. */
  async findById(id: string): Promise<TenantConfig | null> {
    const row = await this.db.tenant.findUnique({ where: { id } });
    return row ? toConfig(row) : null;
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Onboard a new tenant.
   * Throws if Azure credentials or a unique name are not provided.
   */
  async create(input: CreateTenantInput): Promise<TenantConfig> {
    const row = await this.db.tenant.create({
      data: {
        name: input.name,
        isActive: input.isActive ?? true,

        // Graph / Azure
        azureClientId: input.graph.clientId,
        azureClientSecret: input.graph.clientSecret,
        azureTenantId: input.graph.tenantId,
        azureAuthMode: input.graph.authMode ?? "app_only",
        userEmail: input.graph.userEmail,
        inboxFolder: input.graph.inboxFolder,
        pollIntervalSeconds: input.graph.pollIntervalSeconds,

        // Notification provider
        notificationProvider: toDbProvider(
          input.notification?.provider ?? "slack"
        ),

        // Slack
        slackBotToken: input.slack?.botToken ?? null,
        slackSigningSecret: input.slack?.signingSecret ?? null,
        slackWebhookRfq: input.slack?.webhookRfq ?? null,
        slackWebhookInquiry: input.slack?.webhookInquiry ?? null,
        slackPoChannelId: input.slack?.poChannelId ?? null,
        slackBotName: input.slack?.botName ?? "KAIRA",

        // Teams
        teamsWebhookUrl: input.teams?.webhookUrl ?? null,
      },
    });

    console.log(`[TenantRegistry] Created tenant "${row.name}" (${row.id})`);
    return toConfig(row);
  }

  /**
   * Update any subset of a tenant's configuration.
   * Supports partial nested updates — only fields present in the input
   * are written; the rest are left unchanged.
   */
  async update(id: string, input: UpdateTenantInput): Promise<TenantConfig> {
    const row = await this.db.tenant.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),

        // Graph
        ...(input.graph?.clientId !== undefined && { azureClientId: input.graph.clientId }),
        ...(input.graph?.clientSecret !== undefined && { azureClientSecret: input.graph.clientSecret }),
        ...(input.graph?.tenantId !== undefined && { azureTenantId: input.graph.tenantId }),
        ...(input.graph?.authMode !== undefined && { azureAuthMode: input.graph.authMode }),
        ...(input.graph?.userEmail !== undefined && { userEmail: input.graph.userEmail }),
        ...(input.graph?.inboxFolder !== undefined && { inboxFolder: input.graph.inboxFolder }),
        ...(input.graph?.pollIntervalSeconds !== undefined && {
          pollIntervalSeconds: input.graph.pollIntervalSeconds,
        }),

        // Notification provider
        ...(input.notification?.provider !== undefined && {
          notificationProvider: toDbProvider(input.notification.provider),
        }),

        // Slack
        ...(input.slack?.botToken !== undefined && { slackBotToken: input.slack.botToken }),
        ...(input.slack?.signingSecret !== undefined && { slackSigningSecret: input.slack.signingSecret }),
        ...(input.slack?.webhookRfq !== undefined && { slackWebhookRfq: input.slack.webhookRfq }),
        ...(input.slack?.webhookInquiry !== undefined && { slackWebhookInquiry: input.slack.webhookInquiry }),
        ...(input.slack?.poChannelId !== undefined && { slackPoChannelId: input.slack.poChannelId }),
        ...(input.slack?.botName !== undefined && { slackBotName: input.slack.botName }),

        // Teams
        ...(input.teams?.webhookUrl !== undefined && { teamsWebhookUrl: input.teams.webhookUrl }),
      },
    });

    console.log(`[TenantRegistry] Updated tenant "${row.name}" (${row.id})`);
    return toConfig(row);
  }

  /** Soft-enable a tenant — the scheduler will pick it up on next cycle. */
  async activate(id: string): Promise<TenantConfig> {
    return this.update(id, { isActive: true });
  }

  /** Soft-disable a tenant — the scheduler stops polling without deleting data. */
  async deactivate(id: string): Promise<TenantConfig> {
    return this.update(id, { isActive: false });
  }

  /**
   * Permanently remove a tenant and all related records.
   * Cascades to TrackedOrder and DeltaLink via the Prisma schema.
   */
  async delete(id: string): Promise<void> {
    const row = await this.db.tenant.delete({ where: { id } });
    console.log(`[TenantRegistry] Deleted tenant "${row.name}" (${id})`);
  }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

/** Convert a flat Prisma Tenant row → nested TenantConfig. */
function toConfig(row: TenantRow): TenantConfig {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,

    graph: {
      clientId: row.azureClientId,
      clientSecret: row.azureClientSecret,
      tenantId: row.azureTenantId,
      authMode: (row.azureAuthMode === "device_code" ? "device_code" : "app_only"),
      userEmail: row.userEmail,
      inboxFolder: row.inboxFolder,
      pollIntervalSeconds: row.pollIntervalSeconds,
    },

    notification: {
      provider: fromDbProvider(row.notificationProvider),
    },

    slack: {
      botToken: row.slackBotToken,
      signingSecret: row.slackSigningSecret,
      webhookRfq: row.slackWebhookRfq,
      webhookInquiry: row.slackWebhookInquiry,
      poChannelId: row.slackPoChannelId,
      botName: row.slackBotName,
    },

    teams: {
      webhookUrl: row.teamsWebhookUrl,
    },

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDbProvider(p: NotificationProvider): PrismaNotificationProvider {
  return p === "teams"
    ? PrismaNotificationProvider.TEAMS
    : PrismaNotificationProvider.SLACK;
}

function fromDbProvider(p: PrismaNotificationProvider): NotificationProvider {
  return p === PrismaNotificationProvider.TEAMS ? "teams" : "slack";
}
