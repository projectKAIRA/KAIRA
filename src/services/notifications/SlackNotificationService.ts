import axios from "axios";
import { WebClient } from "@slack/web-api";
import { NotificationService } from "./NotificationService.js";
import {
  NotificationPayload,
  NotificationResult,
  POLineItem,
  PurchaseOrderData,
  TrackedPO,
} from "../../types/index.js";
import { POTracker } from "../po/POTracker.js";

export const CLAIM_ACTION_ID = "claim_po";

interface SlackConfig {
  botToken: string;
  poChannel: string;
  webhookRfq: string;
  webhookInquiry: string;
  botName: string;
}

export class SlackNotificationService implements NotificationService {
  readonly name = "Slack";
  private web: WebClient;

  constructor(private readonly cfg: SlackConfig, private readonly tracker: POTracker) {
    this.web = new WebClient(cfg.botToken);
  }

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    switch (payload.type) {
      case "pdf_po":
        return this.postPurchaseOrder(payload);
      case "rfq":
        return this.postWebhook(this.cfg.webhookRfq, this.buildRfqBlocks(payload));
      case "general_inquiry":
        return this.postWebhook(this.cfg.webhookInquiry, this.buildGeneralInquiryBlocks(payload));
      case "text_po":
        return this.postWebhook(this.cfg.webhookRfq, this.buildTextPoBlocks(payload));
    }
  }

  // ─── PO — Web API (returns ts for later updates) ─────────────────────────

  private async postPurchaseOrder(payload: NotificationPayload): Promise<NotificationResult> {
    const { email, purchaseOrder, attachmentName } = payload;
    if (!purchaseOrder || !email) return {};

    // Register in tracker first so we have an ID for the button
    const tracked = this.tracker.track({
      emailId: email.id,
      purchaseOrder,
      email,
      pdfBase64: email.attachments.find((a) => a.name === attachmentName)?.contentBytes ?? "",
      pdfName: attachmentName ?? "purchase_order.pdf",
    });

    const blocks = this.buildPdfPoBlocks(payload, tracked.id);

    try {
      const result = await this.web.chat.postMessage({
        channel: this.cfg.poChannel,
        username: this.cfg.botName,
        icon_emoji: ":robot_face:",
        blocks: blocks as any,
        text: `New Purchase Order received from ${email.sender}`,
      });

      const ts = result.ts ?? "";
      const channelId = typeof result.channel === "string" ? result.channel : "";
      this.tracker.setSlackMessage(tracked.id, ts, channelId);

      return { poTrackingId: tracked.id, slackMessageTs: ts, slackChannelId: channelId };
    } catch (err) {
      console.error("[SlackNotificationService] Failed to post PO:", err);
      return { poTrackingId: tracked.id };
    }
  }

  // ─── Webhook posts (RFQ, Inquiry, Text PO) ───────────────────────────────

  private async postWebhook(webhookUrl: string, blocks: unknown[]): Promise<NotificationResult> {
    if (!webhookUrl) {
      console.warn("[SlackNotificationService] No webhook URL configured for this message type.");
      return {};
    }
    try {
      await axios.post(webhookUrl, {
        username: this.cfg.botName,
        icon_emoji: ":robot_face:",
        blocks,
      });
    } catch (err) {
      console.error("[SlackNotificationService] Webhook post failed:", err);
    }
    return {};
  }

  // ─── Build claimed/unclaimed PO blocks (used by SlackInteractionService) ─

  buildPdfPoBlocks(payload: NotificationPayload, trackingId: string, claimed?: { byName: string; at: string }): unknown[] {
    const po = payload.purchaseOrder!;
    const email = payload.email;

    const lineItemsText =
      po.lineItems.length > 0
        ? po.lineItems.map((li: POLineItem) =>
            [
              `*${li.lineNumber ?? "—"}*`,
              li.partNumber ? `PN: ${li.partNumber}` : null,
              li.description,
              li.quantity != null ? `Qty: ${li.quantity} ${li.unitOfMeasure ?? ""}` : null,
              li.unitPrice != null ? `@ ${formatCurrency(li.unitPrice, po.currency)}` : null,
              li.totalPrice != null ? `= ${formatCurrency(li.totalPrice, po.currency)}` : null,
            ]
              .filter(Boolean)
              .join("  |  ")
          ).join("\n")
        : "_No line items extracted_";

    const claimBlock = claimed
      ? {
          type: "section",
          text: mrkdwn(`✅ *Claimed by ${claimed.byName}* at ${claimed.at}`),
        }
      : {
          type: "actions",
          block_id: "po_actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Claim Order", emoji: true },
              style: "primary",
              action_id: CLAIM_ACTION_ID,
              value: trackingId,
              confirm: {
                title: { type: "plain_text", text: "Claim this order?" },
                text: { type: "mrkdwn", text: "You'll receive a DM with the full PO details and the original PDF." },
                confirm: { type: "plain_text", text: "Yes, claim it" },
                deny: { type: "plain_text", text: "Cancel" },
              },
            },
          ],
        };

    return [
      { type: "header", text: { type: "plain_text", text: "📄 Purchase Order Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From", email.sender),
          field("Subject", email.subject),
          field("Received", email.receivedAt),
          field("Attachment", payload.attachmentName ?? "—"),
        ],
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          field("PO Number", po.poNumber ?? "—"),
          field("Order Date", po.orderDate ?? "—"),
          field("Delivery Date", po.requestedDeliveryDate ?? "—"),
          field("Currency", po.currency ?? "—"),
          field("Payment Terms", po.paymentTerms ?? "—"),
          field("Confidence", po.rawConfidence.toUpperCase()),
        ],
      },
      ...(po.buyer
        ? [{
            type: "section",
            text: mrkdwn(
              `*Buyer:* ${po.buyer.company ?? po.buyer.name ?? "—"}` +
              (po.buyer.contact ? `\n${po.buyer.contact}` : "") +
              (po.buyer.email ? `  •  ${po.buyer.email}` : "")
            ),
          }]
        : []),
      { type: "divider" },
      { type: "section", text: mrkdwn(`*Line Items*\n\`\`\`${lineItemsText}\`\`\``) },
      {
        type: "section",
        fields: [
          field("Subtotal", po.subtotal != null ? formatCurrency(po.subtotal, po.currency) : "—"),
          field("Tax", po.tax != null ? formatCurrency(po.tax, po.currency) : "—"),
          field("Shipping", po.shippingCost != null ? formatCurrency(po.shippingCost, po.currency) : "—"),
          field("*Total*", po.total != null ? `*${formatCurrency(po.total, po.currency)}*` : "—"),
        ],
      },
      ...(po.shippingAddress ? [{ type: "section", text: mrkdwn(`*Ship To:* ${po.shippingAddress}`) }] : []),
      ...(po.notes ? [{ type: "section", text: mrkdwn(`*Notes:* ${po.notes}`) }] : []),
      { type: "divider" },
      claimBlock,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Processed by KAIRA • ${new Date().toISOString()}_` }],
      },
    ];
  }

  /** Rebuild PO blocks with the claim button replaced by a claimed banner. */
  buildClaimedPOBlocks(tracked: TrackedPO): unknown[] {
    const payload: NotificationPayload = {
      type: "pdf_po",
      email: tracked.email,
      purchaseOrder: tracked.purchaseOrder,
      attachmentName: tracked.pdfName,
    };
    return this.buildPdfPoBlocks(payload, tracked.id, {
      byName: tracked.claimedByName ?? tracked.claimedBy ?? "unknown",
      at: tracked.claimedAt ?? new Date().toISOString(),
    });
  }

  /** Build DM blocks with full PO details (no claim button). */
  buildPoDmBlocks(tracked: TrackedPO): unknown[] {
    const po = tracked.purchaseOrder;
    const lineItemsText =
      po.lineItems.length > 0
        ? po.lineItems.map((li) =>
            `${li.lineNumber ?? "—"}. ${li.description}  |  Qty: ${li.quantity ?? "—"}  |  ${li.unitPrice != null ? formatCurrency(li.unitPrice, po.currency) : "—"} ea  =  ${li.totalPrice != null ? formatCurrency(li.totalPrice, po.currency) : "—"}`
          ).join("\n")
        : "No line items extracted.";

    return [
      { type: "header", text: { type: "plain_text", text: `📋 You claimed PO #${po.poNumber ?? "unknown"}`, emoji: true } },
      {
        type: "section",
        text: mrkdwn(`Here are the full details for the order you just claimed.\n*From:* ${tracked.email.sender}\n*Subject:* ${tracked.email.subject}`),
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          field("PO Number", po.poNumber ?? "—"),
          field("Order Date", po.orderDate ?? "—"),
          field("Delivery Date", po.requestedDeliveryDate ?? "—"),
          field("Total", po.total != null ? formatCurrency(po.total, po.currency) : "—"),
          field("Payment Terms", po.paymentTerms ?? "—"),
          field("Currency", po.currency ?? "—"),
        ],
      },
      ...(po.buyer
        ? [{
            type: "section",
            text: mrkdwn(
              `*Buyer*\n${[po.buyer.company, po.buyer.name, po.buyer.contact, po.buyer.email, po.buyer.phone].filter(Boolean).join("\n")}`
            ),
          }]
        : []),
      ...(po.vendor
        ? [{
            type: "section",
            text: mrkdwn(
              `*Vendor*\n${[po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone].filter(Boolean).join("\n")}`
            ),
          }]
        : []),
      { type: "divider" },
      { type: "section", text: mrkdwn(`*Line Items*\n\`\`\`${lineItemsText}\`\`\``) },
      ...(po.shippingAddress ? [{ type: "section", text: mrkdwn(`*Ship To:* ${po.shippingAddress}`) }] : []),
      ...(po.notes ? [{ type: "section", text: mrkdwn(`*Notes:* ${po.notes}`) }] : []),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_The original PDF is attached below • KAIRA_` }],
      },
    ];
  }

  // ─── Non-PO block builders ────────────────────────────────────────────────

  private buildRfqBlocks(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    const lineItemsText = d.lineItems && d.lineItems.length > 0
      ? d.lineItems.map((li, i) =>
          [
            `*${i + 1}*`,
            li.partNumber ? `PN: ${li.partNumber}` : null,
            li.description,
            li.quantity != null ? `Qty: ${li.quantity}${li.unit ? ` ${li.unit}` : ""}` : null,
          ]
            .filter(Boolean)
            .join("  |  ")
        ).join("\n")
      : null;

    const contactFields: ReturnType<typeof field>[] = [];
    if (d.contactName) contactFields.push(field("Contact", d.contactName));
    if (d.contactTitle) contactFields.push(field("Title", d.contactTitle));
    if (d.company) contactFields.push(field("Company", d.company));
    if (d.email) contactFields.push(field("Email", d.email));
    if (d.phone) contactFields.push(field("Phone", d.phone));
    if (d.directPhone) contactFields.push(field("Direct", d.directPhone));
    if (d.cellPhone) contactFields.push(field("Cell", d.cellPhone));

    return [
      { type: "header", text: { type: "plain_text", text: "📋 Request for Quote Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From", email.sender),
          field("Subject", email.subject),
          field("Received", email.receivedAt),
          field("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning
        ? [{ type: "section", text: mrkdwn(`*Summary:* ${classification.reasoning}`) }]
        : []),
      { type: "divider" },
      ...(lineItemsText
        ? [
            { type: "section", text: mrkdwn(`*Requested Items*\n\`\`\`${lineItemsText}\`\`\``) },
          ]
        : []),
      ...(contactFields.length > 0
        ? [
            { type: "divider" },
            { type: "section", fields: contactFields.slice(0, 10) },
          ]
        : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `_Classified as *RFQ* by KAIRA • ${new Date().toISOString()}_` }] },
    ];
  }

  private buildTextPoBlocks(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    return [
      { type: "header", text: { type: "plain_text", text: "📝 Text Purchase Order Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From", email.sender),
          field("Subject", email.subject),
          field("Received", email.receivedAt),
          field("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning ? [{ type: "section", text: mrkdwn(`*Summary:* ${classification.reasoning}`) }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `_Classified as *Text PO* by KAIRA • ${new Date().toISOString()}_` }] },
    ];
  }

  private buildGeneralInquiryBlocks(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    return [
      { type: "header", text: { type: "plain_text", text: "💬 General Inquiry Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From", email.sender),
          field("Subject", email.subject),
          field("Received", email.receivedAt),
          field("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning ? [{ type: "section", text: mrkdwn(`*Summary:* ${classification.reasoning}`) }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `_Classified as *General Inquiry* by KAIRA • ${new Date().toISOString()}_` }] },
    ];
  }

  // ─── Expose the Web client for SlackInteractionService ────────────────────
  getWebClient(): WebClient {
    return this.web;
  }
}

// ─── RFQ extracted data shape ─────────────────────────────────────────────────

interface RfqExtractedData {
  contactName?: string | null;
  contactTitle?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  directPhone?: string | null;
  cellPhone?: string | null;
  lineItems?: Array<{
    partNumber?: string | null;
    description: string;
    quantity?: number | null;
    unit?: string | null;
  }> | null;
}

// ─── Block helpers ────────────────────────────────────────────────────────────

function field(label: string, value: string): { type: string; text: string } {
  return { type: "mrkdwn", text: `*${label}:*\n${value}` };
}

function mrkdwn(text: string): { type: string; text: string } {
  return { type: "mrkdwn", text };
}


function formatCurrency(amount: number, currency: string | null): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}
