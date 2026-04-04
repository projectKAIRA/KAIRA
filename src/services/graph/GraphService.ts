import { DeviceCodeCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { EmailAttachment, EmailMessage } from "../../types/index.js";

const SCOPES = ["https://graph.microsoft.com/Mail.Read", "offline_access"];

interface GraphConfig {
  tenantId: string;
  clientId: string;
  inboxFolderName: string;
}

export class GraphService {
  private client: Client;
  private credential: DeviceCodeCredential;
  private deltaLink: string | null = null;

  constructor(private readonly cfg: GraphConfig) {
    this.credential = new DeviceCodeCredential({
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      userPromptCallback: (info) => {
        console.log("\n════════════════════════════════════════════════════════");
        console.log("  KAIRA — Microsoft Account Sign-In Required");
        console.log("════════════════════════════════════════════════════════");
        console.log(info.message);
        console.log("════════════════════════════════════════════════════════\n");
      },
    });

    const authProvider = new TokenCredentialAuthenticationProvider(this.credential, {
      scopes: SCOPES,
    });

    this.client = Client.initWithMiddleware({ authProvider });
  }

  /**
   * Explicitly trigger the device code flow before the first API call.
   * Call this once at startup so the sign-in prompt appears on its own line.
   */
  async authenticate(): Promise<void> {
    await this.credential.getToken(SCOPES);
    console.log("[GraphService] Authentication successful.\n");
  }

  /**
   * Fetch all messages that have arrived since the last poll.
   * Uses /me/ endpoints (delegated auth — acts as the signed-in user).
   */
  async fetchNewMessages(): Promise<EmailMessage[]> {
    const folder = this.cfg.inboxFolderName;

    let url: string;

    if (this.deltaLink) {
      url = this.deltaLink;
    } else {
      url = `/me/mailFolders/${folder}/messages/delta?$select=id,subject,body,sender,receivedDateTime,hasAttachments&$top=50`;
    }

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
        this.deltaLink = response["@odata.deltaLink"];
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
      .api(`/me/messages/${messageId}/attachments/${attachmentId}`)
      .get();

    return (attachment.contentBytes as string) ?? "";
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async hydrateMessage(raw: GraphMessage): Promise<EmailMessage> {
    const attachments: EmailAttachment[] = [];

    if (raw.hasAttachments) {
      const attachResponse = await this.client
        .api(`/me/messages/${raw.id}/attachments`)
        .get();

      for (const att of (attachResponse.value ?? []) as GraphAttachment[]) {
        // Only include file attachments (not item/reference attachments)
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


// ─── Graph API shape types ─────────────────────────────────────────────────

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

// ─── Utility ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
