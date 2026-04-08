import { ImapFlow } from "imapflow";
import { simpleParser, Attachment } from "mailparser";
import { getPrismaClient } from "../../lib/prisma.js";
import { TenantImapConfig } from "../../types/tenant.js";
import { EmailAttachment, EmailMessage } from "../../types/index.js";
import { EmailFetcher } from "../email/EmailFetcher.js";

// How many days back to scan on the very first poll (no stored UID yet).
const FIRST_SYNC_DAYS = 7;

/**
 * ImapService — generic IMAP email fetcher.
 *
 * Works with any IMAP server: Gmail (imap.gmail.com:993), Yahoo
 * (imap.mail.yahoo.com:993), Outlook personal (outlook.office365.com:993),
 * or any self-hosted Exchange / Postfix server.
 *
 * Auth: username + app password (not the account password).
 *   Gmail:  Settings → Security → App passwords
 *   Yahoo:  Account Security → Generate app password
 *   Others: consult your mail provider's documentation
 *
 * Delta tracking: stores the highest seen IMAP UID in the DeltaLink table
 * (same table used by GraphService — the deltaLink column holds the UID string).
 * On each poll only messages with UID > lastSeenUid are fetched.
 */
export class ImapService implements EmailFetcher {
  private readonly folderName: string;

  constructor(
    private readonly kairaTenantId: string,
    private readonly cfg: TenantImapConfig,
  ) {
    this.folderName = cfg.inboxFolder;
  }

  // ─── EmailFetcher implementation ──────────────────────────────────────────

  async fetchNewMessages(): Promise<EmailMessage[]> {
    const client = this.buildClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.folderName);

      try {
        const lastUid = await this.loadLastUid();
        const uids    = await this.searchNewUids(client, lastUid);

        if (uids.length === 0) return [];

        const messages: EmailMessage[] = [];
        let highestUid = lastUid;

        for await (const raw of client.fetch(uids, { uid: true, source: true })) {
          try {
            if (!raw.source) continue; // source may be undefined if message was expunged
            const message = await this.parseMessage({ uid: raw.uid, source: raw.source });
            messages.push(message);
            if (raw.uid > highestUid) highestUid = raw.uid;
          } catch (err) {
            console.warn(`[ImapService] Failed to parse message uid=${raw.uid}:`, err);
          }
        }

        if (highestUid > lastUid) {
          await this.saveLastUid(highestUid);
        }

        return messages;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {/* ignore logout errors */});
    }
  }

  /** IMAP tenants have no Graph API access — linked document download is unavailable. */
  findLinkedDocumentUrl(_bodyText: string, _bodyHtml: string): string | null {
    return null;
  }

  /** IMAP tenants have no Graph API access — linked document download is unavailable. */
  async downloadSharedFile(
    _sharingUrl: string
  ): Promise<{ base64: string; contentType: string; name: string } | null> {
    console.warn("[ImapService] OneDrive/SharePoint link download requires Microsoft Graph — not available for IMAP tenants.");
    return null;
  }

  // ─── UID persistence (reuses DeltaLink table) ─────────────────────────────

  private async loadLastUid(): Promise<number> {
    const db  = getPrismaClient();
    const row = await db.deltaLink.findUnique({
      where: {
        tenantId_folderName: {
          tenantId:   this.kairaTenantId,
          folderName: this.folderName,
        },
      },
    });
    return row ? parseInt(row.deltaLink, 10) || 0 : 0;
  }

  private async saveLastUid(uid: number): Promise<void> {
    const db = getPrismaClient();
    await db.deltaLink.upsert({
      where: {
        tenantId_folderName: {
          tenantId:   this.kairaTenantId,
          folderName: this.folderName,
        },
      },
      update: { deltaLink: String(uid) },
      create: {
        tenantId:   this.kairaTenantId,
        folderName: this.folderName,
        deltaLink:  String(uid),
      },
    });
  }

  // ─── UID search ───────────────────────────────────────────────────────────

  private async searchNewUids(client: ImapFlow, lastUid: number): Promise<number[]> {
    if (lastUid === 0) {
      // First sync — limit to the last N days to avoid processing a full inbox.
      const since = new Date();
      since.setDate(since.getDate() - FIRST_SYNC_DAYS);
      const results = await client.search({ since }, { uid: true });
      return (results ?? []) as number[];
    }

    // Normal poll — fetch everything newer than the last seen UID.
    const results = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
    return (results ?? []) as number[];
  }

  // ─── Message parsing ──────────────────────────────────────────────────────

  private async parseMessage(
    raw: { uid: number; source: Buffer }
  ): Promise<EmailMessage> {
    const parsed = await simpleParser(raw.source);

    const attachments: EmailAttachment[] = (parsed.attachments ?? [])
      .filter((att: Attachment) => att.content && att.filename)
      .map((att: Attachment, i: number) => ({
        id:           att.checksum ?? `att-${raw.uid}-${i}`,
        name:         att.filename ?? `attachment-${i}`,
        contentType:  att.contentType ?? "application/octet-stream",
        contentBytes: att.content.toString("base64"),
        size:         att.size ?? att.content.length,
      }));

    const sender =
      parsed.from?.value[0]?.address ??
      parsed.from?.value[0]?.name ??
      "unknown";

    const receivedAt =
      parsed.date?.toISOString() ?? new Date().toISOString();

    const bodyHtml = typeof parsed.html === "string" ? parsed.html : "";
    const bodyText = parsed.text ?? stripHtml(bodyHtml);

    return {
      id:             `imap-${this.kairaTenantId}-${raw.uid}`,
      subject:        parsed.subject ?? "(no subject)",
      bodyText,
      bodyHtml,
      sender,
      receivedAt,
      hasAttachments: attachments.length > 0,
      attachments,
    };
  }

  // ─── Client factory ───────────────────────────────────────────────────────

  private buildClient(): ImapFlow {
    return new ImapFlow({
      host:   this.cfg.host,
      port:   this.cfg.port,
      secure: this.cfg.secure,
      auth: {
        user: this.cfg.username,
        pass: this.cfg.password,
      },
      logger: false, // suppress imapflow's verbose internal logging
    });
  }
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
