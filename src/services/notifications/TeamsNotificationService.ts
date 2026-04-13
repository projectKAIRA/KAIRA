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

    // Build header facts — only include non-null values
    const headerFacts = [
      fact("From",     email.sender),
      fact("Subject",  email.subject),
      fact("Received", email.receivedAt),
      ...(payload.attachmentName                ? [fact("Attachment",    payload.attachmentName)]                 : []),
      ...(po.poNumber                           ? [fact("PO Number",     po.poNumber)]                           : []),
      ...(po.orderDate                          ? [fact("Order Date",     po.orderDate)]                          : []),
      ...(po.requestedDeliveryDate              ? [fact("Delivery Date",  po.requestedDeliveryDate)]              : []),
      ...(po.paymentTerms                       ? [fact("Payment Terms",  po.paymentTerms)]                       : []),
      ...(po.currency                           ? [fact("Currency",       po.currency)]                           : []),
      ...(po.total        != null               ? [fact("Grand Total",    formatCurrencyTeams(po.total, po.currency))] : []),
      ...(po.subtotal     != null               ? [fact("Subtotal",       formatCurrencyTeams(po.subtotal,     po.currency))] : []),
      ...(po.tax          != null               ? [fact("Tax",            formatCurrencyTeams(po.tax,          po.currency))] : []),
      ...(po.shippingCost != null               ? [fact("Shipping",       formatCurrencyTeams(po.shippingCost, po.currency))] : []),
      fact("Confidence", po.rawConfidence.toUpperCase()),
    ];

    const lineItems = po.lineItems.length > 0
      ? po.lineItems.map((li: POLineItem) =>
          [
            li.lineNumber != null ? `${li.lineNumber})` : "—)",
            li.description,
            li.partNumber                 ? `PN: ${li.partNumber}`                              : null,
            li.quantity   != null         ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}` : null,
            li.unitPrice  != null         ? `@ ${formatCurrencyTeams(li.unitPrice,  po.currency)}` : null,
            li.totalPrice != null         ? `= ${formatCurrencyTeams(li.totalPrice, po.currency)}` : null,
          ].filter(Boolean).join("  ")
        ).join("\n")
      : null;

    // Build vendor/buyer/address text blocks — only if relevant data is present
    const vendorLine = po.vendor
      ? [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone].filter(Boolean).join(", ")
      : null;

    const billToLine = (po.billTo || po.buyer)
      ? [
          po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
          po.billTo?.address ?? po.buyer?.address,
          po.buyer?.email,
          po.buyer?.phone,
        ].filter(Boolean).join(", ")
      : null;

    const shipToLine = (po.shipTo && (po.shipTo.company || po.shipTo.address))
      ? [po.shipTo.company, po.shipTo.address].filter(Boolean).join(", ")
      : null;

    return [
      { type: "TextBlock", text: "📄 Purchase Order Received", size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: headerFacts },
      ...(vendorLine  ? [{ type: "TextBlock", text: `**Vendor:** ${vendorLine}`,   wrap: true }] : []),
      ...(billToLine  ? [{ type: "TextBlock", text: `**Bill To:** ${billToLine}`,   wrap: true }] : []),
      ...(shipToLine  ? [{ type: "TextBlock", text: `**Ship To:** ${shipToLine}`,   wrap: true }] : []),
      ...(lineItems   ? [
          { type: "TextBlock", text: "**Line Items**", weight: "Bolder" },
          { type: "TextBlock", text: lineItems, wrap: true, fontType: "Monospace" },
        ] : []),
      ...(po.notes    ? [{ type: "TextBlock", text: `**Notes:** ${po.notes}`, wrap: true }] : []),
      { type: "TextBlock", text: `Processed by KAIRA • ${new Date().toISOString()}`, isSubtle: true, size: "Small" },
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

function formatCurrencyTeams(amount: number, currency: string | null): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}
