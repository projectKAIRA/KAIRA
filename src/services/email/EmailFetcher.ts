import { EmailMessage } from "../../types/index.js";

/**
 * Common interface implemented by both GraphService (Microsoft) and ImapService (IMAP).
 *
 * EmailProcessor depends only on this interface — it never imports a concrete
 * provider class — so adding new email providers never touches the processor.
 */
export interface EmailFetcher {
  /**
   * Fetch all messages that have arrived since the last poll.
   * Must persist a delta bookmark (delta link or last-seen UID) so that the
   * next call only returns genuinely new messages.
   */
  fetchNewMessages(): Promise<EmailMessage[]>;

  /**
   * Scan email body text and HTML for the first OneDrive or SharePoint
   * sharing URL, returning it or null if none found.
   * IMAP implementations return null (no Graph API access).
   */
  findLinkedDocumentUrl(bodyText: string, bodyHtml: string): string | null;

  /**
   * Download a file from a OneDrive / SharePoint sharing URL.
   * IMAP implementations always return null — Graph API is required.
   */
  downloadSharedFile(
    sharingUrl: string
  ): Promise<{ base64: string; contentType: string; name: string } | null>;
}
