import { ClientSecretCredential, DeviceCodeCredential } from "@azure/identity";
import type { TokenCredential, AccessToken } from "@azure/identity";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { TenantGraphConfig } from "../../types/tenant.js";
import { EmailAttachment, EmailMessage } from "../../types/index.js";
import { EmailFetcher } from "../email/EmailFetcher.js";
import { refreshMicrosoftToken } from "../auth/OAuthService.js";

// App-only scope — uses whatever application permissions are granted in Azure.
const SCOPES = ["https://graph.microsoft.com/.default"];

// ─── OAuth delegated credential ───────────────────────────────────────────────

/**
 * TokenCredential implementation for delegated OAuth tokens obtained via the
 * self-serve onboarding flow.  Automatically refreshes the access token using
 * the stored refresh token and writes the new token pair back to the database.
 */
class OAuthTokenCredential implements TokenCredential {
  private accessToken: string;
  private expiresAt: number;

  constructor(
    private readonly kairaTenantId: string,
    private readonly azureTenantId: string,
    private readonly refreshToken: string,
    initialAccessToken: string,
    initialExpiresAt: Date,
  ) {
    this.accessToken = initialAccessToken;
    this.expiresAt   = initialExpiresAt.getTime();
  }

  async getToken(_scopes: string | string[]): Promise<AccessToken | null> {
    // Refresh 60 s before expiry to avoid using a token that expires in-flight.
    if (Date.now() < this.expiresAt - 60_000) {
      return { token: this.accessToken, expiresOnTimestamp: this.expiresAt };
    }

    const result = await refreshMicrosoftToken(this.azureTenantId, this.refreshToken);

    if (!result.access_token) {
      throw new Error(
        `[OAuthTokenCredential] Token refresh failed: ${result.error ?? "unknown"} — ${result.error_description ?? ""}`,
      );
    }

    this.accessToken = result.access_token;
    this.expiresAt   = Date.now() + (result.expires_in ?? 3600) * 1000;

    // Persist the refreshed token to the database.
    const db = getPrismaClient();
    await db.tenant.update({
      where: { id: this.kairaTenantId },
      data: {
        azureAccessToken:    this.accessToken,
        azureTokenExpiresAt: new Date(this.expiresAt),
      },
    });

    console.log(`[OAuthTokenCredential] Refreshed access token for tenant ${this.kairaTenantId}`);
    return { token: this.accessToken, expiresOnTimestamp: this.expiresAt };
  }
}

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
export class GraphService implements EmailFetcher {
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

    let credential: TokenCredential;

    if (cfg.authMode === "device_code") {
      // Personal @outlook.com accounts — interactive device code flow.
      // On first run the user visits aka.ms/devicelogin and enters the printed code.
      credential = new DeviceCodeCredential({
        tenantId: "consumers",
        clientId: cfg.clientId,
        userPromptCallback: (info) => {
          console.log("\n[GraphService] ── Device code login required ──────────────────");
          console.log(info.message);
          console.log("────────────────────────────────────────────────────────────────\n");
        },
      });
    } else if (cfg.authMode === "oauth") {
      if (!cfg.accessToken || !cfg.refreshToken || !cfg.tokenExpiresAt) {
        throw new Error(
          `[GraphService] authMode "oauth" requires accessToken, refreshToken, and tokenExpiresAt`,
        );
      }
      credential = new OAuthTokenCredential(
        kairaTenantId,
        cfg.tenantId,
        cfg.refreshToken,
        cfg.accessToken,
        cfg.tokenExpiresAt,
      );
    } else {
      credential = new ClientSecretCredential(
        cfg.tenantId,
        cfg.clientId,
        cfg.clientSecret,
      );
    }

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

  // ─── OneDrive / SharePoint link handling ──────────────────────────────────

  /**
   * Scan email body text and HTML for the first OneDrive or SharePoint
   * sharing URL and return it, or null if none is found.
   */
  findLinkedDocumentUrl(bodyText: string, bodyHtml: string): string | null {
    const LINK_PATTERNS = [
      /https?:\/\/1drv\.ms\/\S+/i,
      /https?:\/\/onedrive\.live\.com\/\S+/i,
      /https?:\/\/[\w-]+-my\.sharepoint\.com\/\S+/i,
      /https?:\/\/[\w-]+\.sharepoint\.com\/\S+/i,
    ];

    const stripped = bodyHtml.replace(/<[^>]+>/g, " ");

    for (const pattern of LINK_PATTERNS) {
      // Check plain text first, then stripped HTML
      const match = bodyText.match(pattern) ?? stripped.match(pattern);
      if (match) {
        // Strip trailing punctuation that may have been captured
        return match[0].replace(/['")\]>,;]+$/, "");
      }
    }
    return null;
  }

  /**
   * Download a file from a OneDrive or SharePoint sharing URL using the
   * Graph /shares/ endpoint. Returns null if the download fails (e.g. the
   * app lacks Files.Read.All permission or the link has expired).
   */
  async downloadSharedFile(
    sharingUrl: string
  ): Promise<{ base64: string; contentType: string; name: string } | null> {
    const shareId = encodeSharingUrl(sharingUrl);

    try {
      // Fetch metadata to get file name and MIME type
      const item = await this.client.api(`/shares/${shareId}/driveItem`).get();
      const name: string = (item.name as string | undefined) ?? "linked_document";
      const contentType: string =
        (item.file?.mimeType as string | undefined) ?? "application/octet-stream";

      // Download the raw bytes
      const content: ArrayBuffer = await this.client
        .api(`/shares/${shareId}/driveItem/content`)
        .responseType(ResponseType.ARRAYBUFFER)
        .get();

      const base64 = Buffer.from(content).toString("base64");
      console.log(`[GraphService] Downloaded linked file "${name}" (${contentType})`);
      return { base64, contentType, name };
    } catch (err) {
      console.warn(
        `[GraphService] Could not download shared file from ${sharingUrl}:`,
        (err as Error).message ?? err
      );
      return null;
    }
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

    console.log(
      `[GraphService] Hydrating message id=${raw.id} ` +
      `subject="${raw.subject ?? ""}" hasAttachments=${raw.hasAttachments ?? false}`
    );

    if (raw.hasAttachments) {
      const attachResponse = await this.client
        .api(`/users/${this.userEmail}/messages/${raw.id}/attachments`)
        .get();

      const rawAtts = (attachResponse.value ?? []) as GraphAttachment[];
      console.log(`[GraphService] /attachments returned ${rawAtts.length} item(s) for message ${raw.id}`);

      for (const att of rawAtts) {
        const odataType   = att["@odata.type"] ?? "(missing)";
        const attName     = att.name ?? "attachment";
        const attCt       = att.contentType ?? "application/octet-stream";
        const attSize     = att.size ?? 0;
        const inlineBytes = att.contentBytes;

        console.log(
          `[GraphService] Attachment: name="${attName}" type="${odataType}" ` +
          `contentType="${attCt}" size=${attSize} ` +
          `contentBytes=${inlineBytes ? `${inlineBytes.length} chars (base64)` : "MISSING"}`
        );

        // Accept both "#microsoft.graph.fileAttachment" (standard) and any
        // variant that isn't a reference or item attachment, to guard against
        // SDK/version differences in the @odata.type value.
        const isFileAttachment =
          odataType === "#microsoft.graph.fileAttachment" ||
          (!odataType.includes("itemAttachment") && !odataType.includes("referenceAttachment") && attSize > 0);

        if (!isFileAttachment) {
          console.log(`[GraphService] Skipping non-file attachment "${attName}" (${odataType})`);
          continue;
        }

        let contentBytes = inlineBytes ?? "";

        // Graph doesn't inline contentBytes for attachments larger than ~3 MB.
        // Fall back to the /$value endpoint to download the raw bytes.
        if (!contentBytes && attSize > 0) {
          console.log(
            `[GraphService] contentBytes missing for "${attName}" (size=${attSize}) — ` +
            `downloading via /$value endpoint`
          );
          try {
            const valueBuffer = await this.client
              .api(`/users/${this.userEmail}/messages/${raw.id}/attachments/${att.id}/$value`)
              .responseType(ResponseType.ARRAYBUFFER)
              .get() as ArrayBuffer;
            contentBytes = Buffer.from(valueBuffer).toString("base64");
            console.log(
              `[GraphService] Downloaded "${attName}" via /$value — ` +
              `${contentBytes.length} base64 chars (${attSize} bytes)`
            );
          } catch (err) {
            console.error(
              `[GraphService] Failed to download attachment "${attName}" via /$value:`,
              (err as Error).message ?? err
            );
          }
        }

        if (!contentBytes) {
          console.warn(
            `[GraphService] Attachment "${attName}" has no content after all attempts — skipping.`
          );
          continue;
        }

        attachments.push({
          id:           att.id,
          name:         attName,
          contentType:  attCt,
          contentBytes,
          size:         attSize,
        });

        console.log(`[GraphService] Added attachment "${attName}" (${attCt}, ${attSize} bytes)`);
      }
    }

    console.log(
      `[GraphService] Message ${raw.id}: ${attachments.length} usable attachment(s) — ` +
      `[${attachments.map(a => `"${a.name}" ${a.size}B`).join(", ")}]`
    );

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

/**
 * Encode a sharing URL into the base64url format expected by the Graph
 * /shares/ endpoint: "u!" + base64url(url) with padding stripped.
 */
function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
  return `u!${b64}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
