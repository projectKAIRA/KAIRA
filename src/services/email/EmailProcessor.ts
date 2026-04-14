import { EmailFetcher } from "./EmailFetcher.js";
import { ClaudeService } from "../claude/ClaudeService.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { AttachmentExtractor, ExtractedContent } from "../attachments/AttachmentExtractor.js";
import { EmailAttachment, EmailMessage, ProcessingResult } from "../../types/index.js";

/** Priority score for attachment kinds — higher wins. */
function attachmentPriority(kind: ExtractedContent["kind"]): number {
  switch (kind) {
    case "pdf":   return 3;
    case "text":  return 2;  // DOCX / XLSX
    case "image": return 1;
  }
}

/**
 * Orchestrates the full email processing pipeline.
 *
 * Supported attachment types (handled by AttachmentExtractor):
 *  - PDF        → Claude document block
 *  - DOCX / DOC → plain text via mammoth → Claude text prompt
 *  - XLSX / XLS → CSV text via SheetJS  → Claude text prompt
 *  - JPEG / PNG / GIF / WebP → Claude image block
 *  - TIFF       → converted to PNG via sharp → Claude image block
 *  - MSG        → inner attachments extracted and routed as above;
 *                 falls back to inner email body text if no supported attachment found
 *  - OneDrive / SharePoint link in body → downloaded then routed above
 *  - Unrecognized type → logged and skipped; email falls through to classification
 *
 * Plain-text emails (no recognized attachment or link):
 *  → classified as RFQ / Text PO / General Inquiry via Claude
 */
export class EmailProcessor {
  private readonly extractor = new AttachmentExtractor();

  constructor(
    private readonly graph: EmailFetcher,
    private readonly claude: ClaudeService,
    private readonly notifier: NotificationService
  ) {}

  /**
   * Run one processing cycle. Called by the poller on each interval tick.
   */
  async runCycle(): Promise<ProcessingResult[]> {
    console.log("[EmailProcessor] Fetching new messages...");

    let messages: EmailMessage[];
    try {
      messages = await this.graph.fetchNewMessages();
    } catch (err) {
      console.error("[EmailProcessor] Graph fetch failed:", err);
      return [{ emailId: "batch", success: false, action: "error", error: String(err) }];
    }

    if (messages.length === 0) {
      console.log("[EmailProcessor] No new messages.");
      return [];
    }

    console.log(`[EmailProcessor] Processing ${messages.length} message(s).`);

    const results: ProcessingResult[] = [];
    for (const message of messages) {
      results.push(await this.processMessage(message));
    }
    return results;
  }

  // ─── Per-message dispatch ─────────────────────────────────────────────────

  private async processMessage(email: EmailMessage): Promise<ProcessingResult> {
    try {
      console.log(
        `[EmailProcessor] Processing email ${email.id} — ` +
        `subject="${email.subject}" from=${email.sender} ` +
        `hasAttachments=${email.hasAttachments} attachmentCount=${email.attachments.length} ` +
        `bodyLength=${email.bodyText.length}`
      );

      if (email.attachments.length > 0) {
        console.log(
          `[EmailProcessor] Attachments: ` +
          email.attachments.map(a => `"${a.name}" (${a.contentType}, ${a.size}B, base64len=${a.contentBytes.length})`).join(" | ")
        );
      }

      // 1. Scan ALL attachments and pick the best one.
      //    Priority: PDF > DOCX/XLSX/text > image.
      //    Never stop early at an image — a PDF that appears later must win.
      let best: ExtractedContent | null = null;

      for (const attachment of email.attachments) {
        console.log(`[EmailProcessor] Extracting attachment "${attachment.name}" (${attachment.contentType}, ${attachment.size}B)`);
        const extracted = await this.extractor.extract(attachment);

        if (!extracted) {
          console.warn(`[EmailProcessor] extract() returned null for "${attachment.name}" (${attachment.contentType}) — skipping`);
          continue;
        }

        console.log(`[EmailProcessor] Extracted "${attachment.name}" as kind="${extracted.kind}"`);

        if (best === null || attachmentPriority(extracted.kind) > attachmentPriority(best.kind)) {
          best = extracted;
          console.log(`[EmailProcessor] New best attachment: "${extracted.name}" (kind=${extracted.kind})`);
        }

        // PDF is the highest priority — no need to check remaining attachments.
        if (best.kind === "pdf") break;
      }

      if (best) {
        console.log(`[EmailProcessor] Using attachment "${best.name}" (kind=${best.kind}) — routing to document handler`);
        return await this.handleDocumentEmail(email, best);
      }

      // 2. No recognised attachment found.
      //    Check whether the email body contains an OneDrive / SharePoint link.
      const linkedUrl = this.graph.findLinkedDocumentUrl(email.bodyText, email.bodyHtml);
      if (linkedUrl) {
        return await this.handleLinkedDocument(email, linkedUrl);
      }

      // 3. Has attachments but none were recognised → log and classify as text.
      if (email.hasAttachments && email.attachments.length > 0) {
        const types = email.attachments.map((a) => `"${a.name}" (${a.contentType})`).join(", ");
        console.warn(
          `[EmailProcessor] Email ${email.id}: ${email.attachments.length} attachment(s) found but none extracted — ` +
          `types: ${types} — falling back to body text classification`
        );
        return await this.handlePlainEmail(email);
      }

      // 4. Plain-text email — classify and route.
      console.log(`[EmailProcessor] Email ${email.id}: no attachments — classifying body text`);
      return await this.handlePlainEmail(email);
    } catch (err) {
      console.error(`[EmailProcessor] Error processing email ${email.id}:`, err);
      return { emailId: email.id, success: false, action: "error", error: String(err) };
    }
  }

  // ─── Document extraction path (PDF / image / DOCX / XLSX) ────────────────

  private async handleDocumentEmail(
    email: EmailMessage,
    extracted: ExtractedContent
  ): Promise<ProcessingResult> {
    console.log(
      `[EmailProcessor] Extracting PO from ${extracted.kind} attachment "${extracted.name}" in email ${email.id}`
    );

    let purchaseOrder;
    switch (extracted.kind) {
      case "pdf":
        purchaseOrder = await this.claude.extractPurchaseOrderFromPdf(extracted.base64, extracted.name);
        break;
      case "image":
        purchaseOrder = await this.claude.extractPurchaseOrderFromImage(
          extracted.base64,
          extracted.mimeType,
          extracted.name
        );
        break;
      case "text":
        purchaseOrder = await this.claude.extractPurchaseOrderFromText(extracted.content, extracted.name);
        break;
    }

    // For text-based documents (DOCX/XLSX) store the original file bytes so
    // the Slack DM can upload the source file when a PO is claimed.
    const documentBase64 = extracted.kind === "text" ? extracted.originalBase64 : extracted.base64;

    await this.notifier.send({
      type: "pdf_po",
      email,
      purchaseOrder,
      attachmentName: extracted.name,
      documentBase64,
    });

    console.log(
      `[EmailProcessor] PO extracted and notified (PO#: ${purchaseOrder.poNumber ?? "unknown"})`
    );
    return {
      emailId: email.id,
      success: true,
      action: "pdf_po_extracted",
      details: purchaseOrder.poNumber ?? undefined,
    };
  }

  // ─── OneDrive / SharePoint link path ─────────────────────────────────────

  private async handleLinkedDocument(
    email: EmailMessage,
    sharingUrl: string
  ): Promise<ProcessingResult> {
    console.log(
      `[EmailProcessor] OneDrive/SharePoint link found in email ${email.id}: ${sharingUrl}`
    );

    const downloaded = await this.graph.downloadSharedFile(sharingUrl);
    if (!downloaded) {
      console.warn(
        `[EmailProcessor] Could not download linked file — falling back to plain-text classification.`
      );
      return this.handlePlainEmail(email);
    }

    // Build a synthetic attachment so AttachmentExtractor can route by content type.
    const synthetic: EmailAttachment = {
      id: "linked",
      name: downloaded.name,
      contentType: downloaded.contentType,
      contentBytes: downloaded.base64,
      size: 0,
    };

    const extracted = await this.extractor.extract(synthetic);
    if (!extracted) {
      console.warn(
        `[EmailProcessor] Linked file type "${downloaded.contentType}" not supported — falling back to plain-text classification.`
      );
      return this.handlePlainEmail(email);
    }

    return this.handleDocumentEmail(email, extracted);
  }

  // ─── Plain-text classification path ──────────────────────────────────────

  private async handlePlainEmail(email: EmailMessage): Promise<ProcessingResult> {
    console.log(`[EmailProcessor] Classifying email ${email.id}: "${email.subject}"`);

    const classification = await this.claude.classifyEmail(email);
    console.log(
      `[EmailProcessor] Classified as: ${classification.category} (${classification.confidence})`
    );

    switch (classification.category) {
      case "RFQ":
        await this.notifier.send({ type: "rfq", email, classification });
        return { emailId: email.id, success: true, action: "email_classified", details: "RFQ" };

      case "Text PO":
        await this.notifier.send({ type: "text_po", email, classification });
        return { emailId: email.id, success: true, action: "email_classified", details: "Text PO" };

      case "General Inquiry":
        await this.notifier.send({ type: "general_inquiry", email, classification });
        return { emailId: email.id, success: true, action: "email_classified", details: "General Inquiry" };

      default:
        return {
          emailId: email.id,
          success: false,
          action: "error",
          error: `Unknown category: ${classification.category}`,
        };
    }
  }
}
