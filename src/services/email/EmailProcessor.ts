import { GraphService } from "../graph/GraphService.js";
import { ClaudeService } from "../claude/ClaudeService.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { EmailMessage, ProcessingResult } from "../../types/index.js";

const PDF_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "application/vnd.pdf",
]);

/**
 * Orchestrates the full email processing pipeline:
 *
 *  1. Fetch new emails from Graph API
 *  2a. Email with PDF → extract PO data via Claude → notify
 *  2b. Email without attachments → classify via Claude → route + notify
 */
export class EmailProcessor {
  constructor(
    private readonly graph: GraphService,
    private readonly claude: ClaudeService,
    private readonly notifier: NotificationService
  ) {}

  /**
   * Run one processing cycle. Called by the poller on each interval tick.
   * Returns a summary of what was processed.
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
      const result = await this.processMessage(message);
      results.push(result);
    }

    return results;
  }

  // ─── Per-message dispatch ─────────────────────────────────────────────────

  private async processMessage(email: EmailMessage): Promise<ProcessingResult> {
    try {
      const pdfAttachment = email.attachments.find((a) =>
        PDF_CONTENT_TYPES.has(a.contentType.toLowerCase())
      );

      if (pdfAttachment) {
        return await this.handlePdfEmail(email, pdfAttachment.id, pdfAttachment.name);
      } else if (!email.hasAttachments) {
        return await this.handlePlainEmail(email);
      } else {
        // Has attachments but none are PDFs — classify as plain text
        return await this.handlePlainEmail(email);
      }
    } catch (err) {
      console.error(`[EmailProcessor] Error processing email ${email.id}:`, err);
      return { emailId: email.id, success: false, action: "error", error: String(err) };
    }
  }

  // ─── PDF PO path ──────────────────────────────────────────────────────────

  private async handlePdfEmail(
    email: EmailMessage,
    attachmentId: string,
    attachmentName: string
  ): Promise<ProcessingResult> {
    console.log(`[EmailProcessor] PDF detected in email ${email.id}: ${attachmentName}`);

    // The attachment bytes are already inlined from the Graph fetch
    const pdfAttachment = email.attachments.find((a) => a.id === attachmentId);
    const pdfBase64 = pdfAttachment?.contentBytes ?? "";

    if (!pdfBase64) {
      return {
        emailId: email.id,
        success: false,
        action: "error",
        error: "PDF attachment had no content bytes.",
      };
    }

    console.log(`[EmailProcessor] Extracting PO from PDF via Claude...`);
    const purchaseOrder = await this.claude.extractPurchaseOrderFromPdf(pdfBase64, attachmentName);

    await this.notifier.send({
      type: "pdf_po",
      email,
      purchaseOrder,
      attachmentName,
    });

    console.log(`[EmailProcessor] PO extracted and notified (PO#: ${purchaseOrder.poNumber ?? "unknown"})`);
    return { emailId: email.id, success: true, action: "pdf_po_extracted", details: purchaseOrder.poNumber ?? undefined };
  }

  // ─── Plain-text classification path ──────────────────────────────────────

  private async handlePlainEmail(email: EmailMessage): Promise<ProcessingResult> {
    console.log(`[EmailProcessor] Classifying email ${email.id}: "${email.subject}"`);

    const classification = await this.claude.classifyEmail(email);
    console.log(`[EmailProcessor] Classified as: ${classification.category} (${classification.confidence})`);

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
        return { emailId: email.id, success: false, action: "error", error: `Unknown category: ${classification.category}` };
    }
  }
}
