import axios from "axios";
import { NotificationService } from "./NotificationService.js";
import { NotificationPayload, NotificationResult, POLineItem } from "../../types/index.js";

interface TeamsConfig {
  webhookUrl: string;
}

/**
 * Microsoft Teams notification provider.
 *
 * Uses the Teams Incoming Webhook with Adaptive Cards (Teams-compatible format).
 * To activate: set NOTIFICATION_PROVIDER=teams and TEAMS_WEBHOOK_URL in .env.
 */
export class TeamsNotificationService implements NotificationService {
  readonly name = "Teams";

  constructor(private readonly cfg: TeamsConfig) {}

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const card = this.buildAdaptiveCard(payload);

    try {
      await axios.post(this.cfg.webhookUrl, {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: card,
          },
        ],
      });
    } catch (err) {
      console.error("[TeamsNotificationService] Failed to post message:", err);
    }
    return {};
  }

  // ─── Adaptive Card builder ───────────────────────────────────────────────

  private buildAdaptiveCard(payload: NotificationPayload): unknown {
    const body = this.buildBody(payload);
    return {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.5",
      body,
      msteams: { width: "Full" },
    };
  }

  private buildBody(payload: NotificationPayload): unknown[] {
    switch (payload.type) {
      case "pdf_po":
        return this.pdfPoBody(payload);
      case "rfq":
        return this.classifiedBody(payload, "📋 RFQ Received");
      case "text_po":
        return this.classifiedBody(payload, "📝 Text Purchase Order Received");
      case "general_inquiry":
        return this.classifiedBody(payload, "💬 General Inquiry Received");
    }
  }

  private pdfPoBody(payload: NotificationPayload): unknown[] {
    const po = payload.purchaseOrder!;
    const email = payload.email;

    const lineItems = po.lineItems
      .map((li: POLineItem) =>
        `${li.lineNumber ?? "—"}) ${li.description} — Qty: ${li.quantity ?? "—"} @ ${li.unitPrice ?? "—"} = ${li.totalPrice ?? "—"}`
      )
      .join("\n");

    return [
      { type: "TextBlock", text: "📄 Purchase Order Received", size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: [
          fact("From", email.sender),
          fact("Subject", email.subject),
          fact("Received", email.receivedAt),
          fact("Attachment", payload.attachmentName ?? "—"),
          fact("PO Number", po.poNumber ?? "—"),
          fact("Order Date", po.orderDate ?? "—"),
          fact("Delivery Date", po.requestedDeliveryDate ?? "—"),
          fact("Total", po.total != null ? `${po.total} ${po.currency ?? ""}` : "—"),
          fact("Confidence", po.rawConfidence.toUpperCase()),
        ],
      },
      ...(lineItems
        ? [{ type: "TextBlock", text: "**Line Items**", weight: "Bolder" },
           { type: "TextBlock", text: lineItems, wrap: true, fontType: "Monospace" }]
        : []),
      { type: "TextBlock", text: `_Processed by KAIRA • ${new Date().toISOString()}_`, isSubtle: true, size: "Small" },
    ];
  }

  private classifiedBody(payload: NotificationPayload, title: string): unknown[] {
    const { email, classification } = payload;
    return [
      { type: "TextBlock", text: title, size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: [
          fact("From", email.sender),
          fact("Subject", email.subject),
          fact("Received", email.receivedAt),
          fact("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning
        ? [{ type: "TextBlock", text: classification.reasoning, wrap: true }]
        : []),
      { type: "TextBlock", text: `_Classified by KAIRA • ${new Date().toISOString()}_`, isSubtle: true, size: "Small" },
    ];
  }
}

function fact(title: string, value: string): { title: string; value: string } {
  return { title, value };
}
