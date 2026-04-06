import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { TenantGraphConfig } from "../../types/tenant.js";
import { EmailAttachment, EmailMessage } from "../../types/index.js";

// App-only scope — uses whatever application permissions are granted in Azure.
const SCOPES = ["https://graph.microsoft.com/.default"];

/**
 * GraphService — tenant-aware Microsoft Graph client.
 *
 * Auth:    ClientSecretCredential (app-only, non-interactive).
 *          Requires the Azure app to have Mail.Read *application* permission
 *          (not delegated) and admin consent granted.
 *
 * Routing: All endpoints use /users/{userEmail}/ instead of /me/,
 *          because app-only tokens have no "me" context.
 *
 * Delta links are persisted to the DeltaLink table so polling survives
 * process restarts and can be shared across future horizontal replicas.
 */
export class GraphService {
  private client: Client;
  private readonly userEmail: string;
  private readonly folderName: string;

  /**
   * @param kairaTenantId  Internal KAIRA tenant UUID — used as the DeltaLink FK.
   * @param cfg            Per-tenant Graph configuration from TenantConfig.graph.
   */
  constructor(
    private readonly kairaTenantId: string,
    cfg: TenantGraphConfig,
  ) {
    this.userEmail  = cfg.userEmail;
    this.folderName = cfg.inboxFolder;

    const credential = new ClientSecretCredential(
      cfg.tenantId,
      cfg.clientId,
      cfg.clientSecret,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: SCOPES,
    });

    this.client = Client.initWithMiddleware({ authProvider });
  }

  /**
   * Fetch all messages that have arrived since the last poll.
   * Uses /users/{userEmail}/ endpoints (app-only auth).
   * Persists the returned deltaLink to the database for the next call.
   */
  async fetchNewMessages(): Promise<EmailMessage[]> {
    const savedLink = await this.loadDeltaLink();

    let url: string = savedLink
      ?? `/users/${this.userEmail}/mailFolders/${this.folderName}/messages/delta`
        + `?$select=id,subject,body,sender,receivedDateTime,hasAttachments&$top=50`;

    const messages: EmailMessage[] = [];

    while (url) {
      const response = await this.client.api(url).get();
      const rawMessages: GraphMessage[] = response.value ?? [];

      for (const raw of rawMessages) {
        const message = await this.hydrateMessage(raw);
        messages.push(message);
      }

      if (response["@odata.nextLink"]) {
        url = response["@odata.nextLink"];
      } else if (response["@odata.deltaLink"]) {
        await this.saveDeltaLink(response["@odata.deltaLink"] as string);
        break;
      } else {
        break;
      }
    }

    return messages;
  }

  /**
   * Download a single attachment's content as a base64-encoded string.
   */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<string> {
    const attachment = await this.client
      .api(`/users/${this.userEmail}/messages/${messageId}/attachments/${attachmentId}`)
      .get();

    return (attachment.contentBytes as string) ?? "";
  }

  // ─── Delta link persistence ───────────────────────────────────────────────

  private async loadDeltaLink(): Promise<string | null> {
    const db = getPrismaClient();
    const row = await db.deltaLink.findUnique({
      where: {
        tenantId_folderName: {
          tenantId: this.kairaTenantId,
          folderName: this.folderName,
        },
      },
    });
    return row?.deltaLink ?? null;
  }

  private async saveDeltaLink(link: string): Promise<void> {
    const db = getPrismaClient();
    await db.deltaLink.upsert({
      where: {
        tenantId_folderName: {
          tenantId: this.kairaTenantId,
          folderName: this.folderName,
        },
      },
      update: { deltaLink: link },
      create: {
        tenantId:   this.kairaTenantId,
        folderName: this.folderName,
        deltaLink:  link,
      },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async hydrateMessage(raw: GraphMessage): Promise<EmailMessage> {
    const attachments: EmailAttachment[] = [];

    if (raw.hasAttachments) {
      const attachResponse = await this.client
        .api(`/users/${this.userEmail}/messages/${raw.id}/attachments`)
        .get();

      for (const att of (attachResponse.value ?? []) as GraphAttachment[]) {
        if (att["@odata.type"] === "#microsoft.graph.fileAttachment") {
          attachments.push({
            id: att.id,
            name: att.name ?? "attachment",
            contentType: att.contentType ?? "application/octet-stream",
            contentBytes: att.contentBytes ?? "",
            size: att.size ?? 0,
          });
        }
      }
    }

    return {
      id: raw.id,
      subject: raw.subject ?? "(no subject)",
      bodyText: raw.body?.content
        ? raw.body.contentType === "text"
          ? raw.body.content
          : stripHtml(raw.body.content)
        : "",
      bodyHtml: raw.body?.contentType === "html" ? (raw.body.content ?? "") : "",
      sender: raw.sender?.emailAddress?.address ?? raw.sender?.emailAddress?.name ?? "unknown",
      receivedAt: raw.receivedDateTime ?? new Date().toISOString(),
      hasAttachments: raw.hasAttachments ?? false,
      attachments,
    };
  }
}

// ─── Graph API shape types ────────────────────────────────────────────────────

interface GraphMessage {
  id: string;
  subject?: string;
  body?: { content?: string; contentType?: string };
  sender?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  hasAttachments?: boolean;
}

interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  contentBytes?: string;
  size?: number;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
