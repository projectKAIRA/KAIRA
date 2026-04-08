import { getPrismaClient } from "../../lib/prisma.js";
import {
  TenantConfig,
  CreateTenantInput,
  UpdateTenantInput,
  NotificationProvider,
  EmailProviderType,
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

  async create(input: CreateTenantInput): Promise<TenantConfig> {
    const providerType = input.providerType ?? "microsoft";

    const row = await this.db.tenant.create({
      data: {
        name:         input.name,
        isActive:     input.isActive ?? true,
        providerType,

        // Graph / Azure (only used when providerType === "microsoft")
        azureClientId:      input.graph?.clientId      ?? "",
        azureClientSecret:  input.graph?.clientSecret  ?? "",
        azureTenantId:      input.graph?.tenantId      ?? "consumers",
        azureAuthMode:      input.graph?.authMode      ?? "app_only",
        userEmail:          input.graph?.userEmail      ?? "",
        inboxFolder:        input.graph?.inboxFolder    ?? input.imap?.inboxFolder ?? "inbox",
        pollIntervalSeconds: input.graph?.pollIntervalSeconds ?? input.imap?.pollIntervalSeconds ?? 60,

        // IMAP (only used when providerType === "imap")
        imapHost:     input.imap?.host     ?? null,
        imapPort:     input.imap?.port     ?? null,
        imapUser:     input.imap?.username ?? null,
        imapPassword: input.imap?.password ?? null,
        imapSecure:   input.imap?.secure   ?? true,

        // Notification
        notificationProvider: toDbProvider(input.notification?.provider ?? "slack"),

        // Slack
        slackBotToken:      input.slack?.botToken      ?? null,
        slackSigningSecret: input.slack?.signingSecret ?? null,
        slackWebhookRfq:    input.slack?.webhookRfq    ?? null,
        slackWebhookInquiry: input.slack?.webhookInquiry ?? null,
        slackPoChannelId:   input.slack?.poChannelId   ?? null,
        slackBotName:       input.slack?.botName       ?? "KAIRA",

        // Teams
        teamsWebhookUrl: input.teams?.webhookUrl ?? null,
      },
    });

    console.log(`[TenantRegistry] Created tenant "${row.name}" (${row.id}) — provider: ${providerType}`);
    return toConfig(row);
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantConfig> {
    const row = await this.db.tenant.update({
      where: { id },
      data: {
        ...(input.name         !== undefined && { name: input.name }),
        ...(input.isActive     !== undefined && { isActive: input.isActive }),
        ...(input.providerType !== undefined && { providerType: input.providerType }),

        // Graph
        ...(input.graph?.clientId           !== undefined && { azureClientId: input.graph.clientId }),
        ...(input.graph?.clientSecret       !== undefined && { azureClientSecret: input.graph.clientSecret }),
        ...(input.graph?.tenantId           !== undefined && { azureTenantId: input.graph.tenantId }),
        ...(input.graph?.authMode           !== undefined && { azureAuthMode: input.graph.authMode }),
        ...(input.graph?.userEmail          !== undefined && { userEmail: input.graph.userEmail }),
        ...(input.graph?.inboxFolder        !== undefined && { inboxFolder: input.graph.inboxFolder }),
        ...(input.graph?.pollIntervalSeconds !== undefined && { pollIntervalSeconds: input.graph.pollIntervalSeconds }),

        // IMAP
        ...(input.imap?.host     !== undefined && { imapHost: input.imap.host }),
        ...(input.imap?.port     !== undefined && { imapPort: input.imap.port }),
        ...(input.imap?.username !== undefined && { imapUser: input.imap.username }),
        ...(input.imap?.password !== undefined && { imapPassword: input.imap.password }),
        ...(input.imap?.secure   !== undefined && { imapSecure: input.imap.secure }),
        ...(input.imap?.inboxFolder !== undefined && { inboxFolder: input.imap.inboxFolder }),
        ...(input.imap?.pollIntervalSeconds !== undefined && { pollIntervalSeconds: input.imap.pollIntervalSeconds }),

        // Notification
        ...(input.notification?.provider !== undefined && {
          notificationProvider: toDbProvider(input.notification.provider),
        }),

        // Slack
        ...(input.slack?.botToken      !== undefined && { slackBotToken: input.slack.botToken }),
        ...(input.slack?.signingSecret !== undefined && { slackSigningSecret: input.slack.signingSecret }),
        ...(input.slack?.webhookRfq    !== undefined && { slackWebhookRfq: input.slack.webhookRfq }),
        ...(input.slack?.webhookInquiry !== undefined && { slackWebhookInquiry: input.slack.webhookInquiry }),
        ...(input.slack?.poChannelId   !== undefined && { slackPoChannelId: input.slack.poChannelId }),
        ...(input.slack?.botName       !== undefined && { slackBotName: input.slack.botName }),

        // Teams
        ...(input.teams?.webhookUrl !== undefined && { teamsWebhookUrl: input.teams.webhookUrl }),
      },
    });

    console.log(`[TenantRegistry] Updated tenant "${row.name}" (${row.id})`);
    return toConfig(row);
  }

  async activate(id: string): Promise<TenantConfig> {
    return this.update(id, { isActive: true });
  }

  async deactivate(id: string): Promise<TenantConfig> {
    return this.update(id, { isActive: false });
  }

  async delete(id: string): Promise<void> {
    const row = await this.db.tenant.delete({ where: { id } });
    console.log(`[TenantRegistry] Deleted tenant "${row.name}" (${id})`);
  }
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function toConfig(row: TenantRow): TenantConfig {
  const providerType = toProviderType(row.providerType);

  return {
    id:           row.id,
    name:         row.name,
    isActive:     row.isActive,
    providerType,

    graph: {
      clientId:           row.azureClientId,
      clientSecret:       row.azureClientSecret,
      tenantId:           row.azureTenantId,
      authMode:           row.azureAuthMode === "device_code" ? "device_code" : "app_only",
      userEmail:          row.userEmail,
      inboxFolder:        row.inboxFolder,
      pollIntervalSeconds: row.pollIntervalSeconds,
    },

    imap: providerType === "imap" && row.imapHost && row.imapUser && row.imapPassword
      ? {
          host:               row.imapHost,
          port:               row.imapPort ?? 993,
          secure:             row.imapSecure,
          username:           row.imapUser,
          password:           row.imapPassword,
          inboxFolder:        row.inboxFolder,
          pollIntervalSeconds: row.pollIntervalSeconds,
        }
      : null,

    notification: {
      provider: fromDbProvider(row.notificationProvider),
    },

    slack: {
      botToken:      row.slackBotToken,
      signingSecret: row.slackSigningSecret,
      webhookRfq:    row.slackWebhookRfq,
      webhookInquiry: row.slackWebhookInquiry,
      poChannelId:   row.slackPoChannelId,
      botName:       row.slackBotName,
    },

    teams: {
      webhookUrl: row.teamsWebhookUrl,
    },

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProviderType(raw: string): EmailProviderType {
  return raw === "imap" ? "imap" : "microsoft";
}

function toDbProvider(p: NotificationProvider): PrismaNotificationProvider {
  return p === "teams" ? PrismaNotificationProvider.TEAMS : PrismaNotificationProvider.SLACK;
}

function fromDbProvider(p: PrismaNotificationProvider): NotificationProvider {
  return p === PrismaNotificationProvider.TEAMS ? "teams" : "slack";
}
