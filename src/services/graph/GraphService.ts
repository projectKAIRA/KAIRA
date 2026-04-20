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
 *
 * First-sync guard: on the very first poll (no stored deltaLink) the initial
 * delta URL includes a $filter=receivedDateTime ge '{monitoringStartAt}' so
 * the customer's pre-plan inbox is never processed.
 */
export class GraphService implements EmailFetcher {
  private client: Client;
  private readonly userEmail: string;
  private readonly folderName: string;

  /**
   * @param kairaTenantId     Internal KAIRA tenant UUID — used as the DeltaLink FK.
   * @param cfg               Per-tenant Graph configuration from TenantConfig.graph.
   * @param monitoringStartAt Date from which emails should be processed. Used as
   *                          the $filter cutoff on first sync so pre-plan emails
   *                          are never touched. Defaults to epoch (no cutoff) for
   *                          backwards-compat with callers that omit it.
   */
  constructor(
    private readonly kairaTenantId: string,
    cfg: TenantGraphConfig,
    private readonly monitoringStartAt: Date = new Date(0),
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

    // On first sync (no saved link) apply a receivedDateTime filter so we only
    // process emails received on or after the tenant's plan activation date.
    const firstSyncFilter = `&$filter=receivedDateTime ge '${this.monitoringStartAt.toISOString()}'`;

    let url: string = savedLink
      ?? `/users/${this.userEmail}/mailFolders/${this.folderName}/messages/delta`
        + `?$select=id,subject,body,sender,receivedDateTime,hasAttachments`
        + firstSyncFilter
        + `&$top=50`;

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

  /**
   * Extract the inner file attachments from an Outlook Item (itemAttachment).
   *
   * When a user forwards an email by attaching it as an "Outlook Item", Graph
   * returns it as #microsoft.graph.itemAttachment — no contentBytes, no file.
   * The actual PO document lives inside the embedded email.
   *
   * Strategy: use $expand to get the inner message + its attachments directly
   * from the Graph API. This avoids MIME parsing entirely and is far more
   * reliable than the /$value approach (which can return 404 on item attachments).
   *
   * Falls back to /$value + raw base64 extraction if $expand returns nothing.
   */
  private async extractItemAttachmentFiles(
    messageId: string,
    attachmentId: string,
    attName: string,
  ): Promise<EmailAttachment[]> {
    // ── Primary: Graph $expand ────────────────────────────────────────────────
    try {
      const expanded = await this.client
        .api(
          `/users/${this.userEmail}/messages/${messageId}/attachments/${attachmentId}` +
          `?$expand=microsoft.graph.itemAttachment/item($expand=attachments)`
        )
        .get() as ExpandedItemAttachment;

      const innerAtts: GraphAttachment[] = expanded?.item?.attachments ?? [];

      console.log(
        `[GraphService] itemAttachment "${attName}" expanded — ` +
        `inner message has ${innerAtts.length} attachment(s): ` +
        `[${innerAtts.map(a => `"${a.name}" type=${a["@odata.type"] ?? "?"} inline=${a.isInline ?? false}`).join(", ")}]`
      );

      const results: EmailAttachment[] = [];

      for (const innerAtt of innerAtts) {
        const odataType = innerAtt["@odata.type"] ?? "";
        const innerName = innerAtt.name ?? "attachment";

        // Only process real file attachments
        if (odataType !== "#microsoft.graph.fileAttachment") {
          console.log(`[GraphService] Inner att "${innerName}": skipping (type=${odataType})`);
          continue;
        }

        // Skip inline CID images — logos, signature graphics, never PO data
        if (innerAtt.isInline) {
          console.log(`[GraphService] Inner att "${innerName}": skipping inline image`);
          continue;
        }

        let contentBytes = innerAtt.contentBytes ?? "";

        // Large attachments (> ~3 MB) won't have inline contentBytes.
        // Download via /$value using the inner message ID if available.
        if (!contentBytes && innerAtt.id) {
          const innerMsgId = expanded?.item?.id;
          if (innerMsgId) {
            try {
              console.log(`[GraphService] Inner att "${innerName}" has no contentBytes — downloading via inner message /$value`);
              const buf = await this.client
                .api(`/users/${this.userEmail}/messages/${innerMsgId}/attachments/${innerAtt.id}/$value`)
                .responseType(ResponseType.ARRAYBUFFER)
                .get() as ArrayBuffer;
              contentBytes = Buffer.from(buf).toString("base64");
            } catch (dlErr) {
              console.warn(
                `[GraphService] Inner att "${innerName}" /$value download failed:`,
                (dlErr as Error).message ?? dlErr
              );
            }
          }
        }

        if (!contentBytes) {
          console.warn(`[GraphService] Inner att "${innerName}": no contentBytes after all attempts — skipping`);
          continue;
        }

        const size = innerAtt.size ?? 0;
        console.log(`[GraphService] Inner att "${innerName}" (${innerAtt.contentType ?? "?"}, ${size}B) — including`);

        results.push({
          id:           `item-${attachmentId}-${innerName}`,
          name:         innerName,
          contentType:  innerAtt.contentType ?? "application/octet-stream",
          contentBytes,
          size,
        });
      }

      if (results.length > 0 || innerAtts.length > 0) {
        console.log(
          `[GraphService] itemAttachment "${attName}": ` +
          `${results.length} file(s) extracted via $expand — ` +
          `[${results.map(r => `"${r.name}"`).join(", ")}]`
        );
        return results;
      }

      // Expand returned no attachments at all — fall through to /$value fallback
      console.log(`[GraphService] itemAttachment "${attName}": $expand returned no inner attachments — trying /$value fallback`);
    } catch (err) {
      console.error(
        `[GraphService] $expand failed for itemAttachment "${attName}":`,
        (err as Error).message ?? err
      );
    }

    // ── Fallback: /$value raw bytes ───────────────────────────────────────────
    // Some configurations (e.g. device code auth) may not support $expand on
    // itemAttachments. Download the raw MIME bytes and extract base64 chunks.
    try {
      console.log(`[GraphService] itemAttachment "${attName}": attempting /$value fallback`);
      const mimeBuffer = await this.client
        .api(`/users/${this.userEmail}/messages/${messageId}/attachments/${attachmentId}/$value`)
        .responseType(ResponseType.ARRAYBUFFER)
        .get() as ArrayBuffer;

      console.log(`[GraphService] itemAttachment "${attName}" /$value — ${mimeBuffer.byteLength} bytes`);

      // Dynamically import mailparser (only used in this fallback path)
      const { simpleParser } = await import("mailparser");
      const parsed = await simpleParser(Buffer.from(mimeBuffer));
      const results: EmailAttachment[] = [];

      for (const innerAtt of parsed.attachments ?? []) {
        if (!innerAtt.content || !innerAtt.filename) continue;
        if (innerAtt.contentDisposition === "inline") {
          console.log(`[GraphService] /$value inner "${innerAtt.filename}": skipping inline`);
          continue;
        }
        results.push({
          id:           `item-${attachmentId}-${innerAtt.filename}`,
          name:         innerAtt.filename,
          contentType:  innerAtt.contentType ?? "application/octet-stream",
          contentBytes: innerAtt.content.toString("base64"),
          size:         innerAtt.size ?? innerAtt.content.length,
        });
      }

      console.log(
        `[GraphService] itemAttachment "${attName}" /$value fallback: ` +
        `${results.length} file(s) — [${results.map(r => `"${r.name}"`).join(", ")}]`
      );
      return results;
    } catch (err) {
      console.error(
        `[GraphService] /$value fallback also failed for "${attName}":`,
        (err as Error).message ?? err
      );
      return [];
    }
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
        const odataType = att["@odata.type"] ?? "(missing)";
        const attName   = att.name ?? "attachment";
        const attSize   = att.size ?? 0;

        console.log(
          `[GraphService] Attachment: name="${attName}" type="${odataType}" ` +
          `size=${attSize} isInline=${att.isInline ?? false}`
        );

        // ── Outlook Item (itemAttachment) ──────────────────────────────────────
        // When a user forwards an email by attaching it as an "Outlook Item",
        // Graph returns it as #microsoft.graph.itemAttachment. It has no
        // contentBytes — instead we download the raw MIME via /$value and use
        // mailparser to extract the inner file attachments (e.g. the PDF).
        if (odataType === "#microsoft.graph.itemAttachment") {
          console.log(`[GraphService] itemAttachment "${attName}" — extracting inner file attachments`);
          const innerAtts = await this.extractItemAttachmentFiles(raw.id, att.id, attName);
          attachments.push(...innerAtts);
          continue;
        }

        // ── Reference attachments (links, not files) ───────────────────────────
        if (odataType === "#microsoft.graph.referenceAttachment") {
          console.log(`[GraphService] Skipping referenceAttachment "${attName}"`);
          continue;
        }

        // ── Inline file attachments (CID images in HTML body) ─────────────────
        // isInline = true means the attachment is embedded via Content-ID in the
        // HTML body — always a logo, signature image, or decorative element.
        // These never contain PO data and must be filtered out.
        if (att.isInline) {
          console.log(`[GraphService] Skipping inline attachment "${attName}" (signature/embedded image)`);
          continue;
        }

        // ── Regular file attachment ────────────────────────────────────────────
        if (odataType !== "#microsoft.graph.fileAttachment") {
          console.log(`[GraphService] Skipping unknown attachment type "${odataType}" for "${attName}"`);
          continue;
        }

        const attCt       = att.contentType ?? "application/octet-stream";
        let   contentBytes = att.contentBytes ?? "";

        console.log(
          `[GraphService] fileAttachment "${attName}" — ` +
          `contentType="${attCt}" contentBytes=${contentBytes ? `${contentBytes.length} chars` : "MISSING"}`
        );

        // Graph doesn't inline contentBytes for attachments larger than ~3 MB.
        // Fall back to the /$value endpoint to download the raw bytes.
        if (!contentBytes && attSize > 0) {
          console.log(`[GraphService] Downloading "${attName}" via /$value (size=${attSize})`);
          try {
            const valueBuffer = await this.client
              .api(`/users/${this.userEmail}/messages/${raw.id}/attachments/${att.id}/$value`)
              .responseType(ResponseType.ARRAYBUFFER)
              .get() as ArrayBuffer;
            contentBytes = Buffer.from(valueBuffer).toString("base64");
            console.log(`[GraphService] Downloaded "${attName}" — ${contentBytes.length} base64 chars`);
          } catch (err) {
            console.error(
              `[GraphService] /$value download failed for "${attName}":`,
              (err as Error).message ?? err
            );
          }
        }

        if (!contentBytes) {
          console.warn(`[GraphService] "${attName}" has no content after all attempts — skipping.`);
          continue;
        }

        attachments.push({ id: att.id, name: attName, contentType: attCt, contentBytes, size: attSize });
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
  /** True for CID-referenced images embedded in the HTML body (logos, signatures). */
  isInline?: boolean;
}

/** Shape returned by $expand on an itemAttachment. */
interface ExpandedItemAttachment {
  item?: {
    id?: string;
    attachments?: GraphAttachment[];
  };
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
