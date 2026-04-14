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

    // Register in tracker first so we have an ID for the button.
    // Use the explicit documentBase64 if provided (for linked/non-PDF docs),
    // otherwise fall back to looking up by attachment name.
    const storedBase64 =
      payload.documentBase64 ??
      email.attachments.find((a) => a.name === attachmentName)?.contentBytes ??
      "";

    const tracked = await this.tracker.track({
      emailId: email.id,
      purchaseOrder,
      email,
      pdfBase64: storedBase64,
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
      await this.tracker.setSlackMessage(tracked.id, ts, channelId);

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
        ? po.lineItems.map((li: POLineItem) => {
            const num   = li.lineNumber != null ? `${li.lineNumber}.` : "—.";
            const pn    = li.partNumber ? `PN: ${li.partNumber}` : null;
            const desc  = li.description || null;
            const qty   = li.quantity != null
              ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}`
              : null;
            const price = [
              li.unitPrice  != null ? `${formatCurrency(li.unitPrice,  po.currency)} ea`    : null,
              li.totalPrice != null ? `${formatCurrency(li.totalPrice, po.currency)} total` : null,
            ].filter(Boolean).join("  •  ") || null;

            const cpn = li.customerPartNumber ? `   Internal PN: ${li.customerPartNumber}` : null;
            return [
              [num, pn].filter(Boolean).join("  "),
              cpn,
              desc  ? `   ${desc}`  : null,
              (qty || price) ? `   ${[qty, price].filter(Boolean).join("  •  ")}` : null,
            ].filter(Boolean).join("\n");
          }).join("\n\n")
        : "_No line items extracted_";

    // Build PO detail fields — only include non-null values
    const poFields = [
      po.poNumber           ? field("PO Number",     po.poNumber)            : null,
      po.orderDate          ? field("Order Date",     po.orderDate)           : null,
      po.requestedDeliveryDate ? field("Delivery Date", po.requestedDeliveryDate) : null,
      po.paymentTerms       ? field("Payment Terms",  po.paymentTerms)        : null,
      po.currency           ? field("Currency",       po.currency)            : null,
      field("Confidence", po.rawConfidence.toUpperCase()),
    ].filter(Boolean) as ReturnType<typeof field>[];

    // Totals — only include non-null amounts
    const totalFields = [
      po.subtotal     != null ? field("Subtotal",  formatCurrency(po.subtotal,     po.currency)) : null,
      po.tax          != null ? field("Tax",        formatCurrency(po.tax,          po.currency)) : null,
      po.shippingCost != null ? field("Shipping",   formatCurrency(po.shippingCost, po.currency)) : null,
      po.total        != null ? field("*Total*", `*${formatCurrency(po.total, po.currency)}*`)   : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

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
          field("From",     email.sender),
          field("Subject",  email.subject),
          field("Received", email.receivedAt),
          ...(payload.attachmentName ? [field("Attachment", payload.attachmentName)] : []),
        ],
      },
      { type: "divider" },
      ...(poFields.length > 0 ? [{ type: "section", fields: poFields }] : []),
      // Vendor section — only if any vendor field is present
      ...(po.vendor && (po.vendor.name || po.vendor.address || po.vendor.contact || po.vendor.email || po.vendor.phone)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Vendor / Supplier*\n` +
              [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone]
                .filter(Boolean).join("\n")
            ),
          }]
        : []),
      // Buyer / Bill To — show buyer contact info and/or billTo address
      ...(po.buyer || po.billTo
        ? [{
            type: "section",
            text: mrkdwn(
              `*Bill To*\n` +
              [
                po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
                po.billTo?.address ?? po.buyer?.address,
                po.buyer?.contact,
                po.buyer?.email,
                po.buyer?.phone,
              ].filter(Boolean).join("\n")
            ),
          }]
        : []),
      // Ship To
      ...(po.shipTo && (po.shipTo.company || po.shipTo.address)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Ship To*\n` +
              [po.shipTo.company, po.shipTo.address].filter(Boolean).join("\n")
            ),
          }]
        : []),
      { type: "divider" },
      { type: "section", text: mrkdwn(`*Line Items*\n\`\`\`${lineItemsText}\`\`\``) },
      ...(totalFields.length > 0 ? [{ type: "section", fields: totalFields }] : []),
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
        ? po.lineItems.map((li) => {
            const num   = li.lineNumber != null ? `${li.lineNumber}.` : "—.";
            const pn    = li.partNumber ? `PN: ${li.partNumber}` : null;
            const desc  = li.description || null;
            const qty   = li.quantity != null
              ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}`
              : null;
            const price = [
              li.unitPrice  != null ? `${formatCurrency(li.unitPrice,  po.currency)} ea`    : null,
              li.totalPrice != null ? `${formatCurrency(li.totalPrice, po.currency)} total` : null,
            ].filter(Boolean).join("  •  ") || null;

            const cpn = li.customerPartNumber ? `   Internal PN: ${li.customerPartNumber}` : null;
            return [
              [num, pn].filter(Boolean).join("  "),
              cpn,
              desc  ? `   ${desc}`  : null,
              (qty || price) ? `   ${[qty, price].filter(Boolean).join("  •  ")}` : null,
            ].filter(Boolean).join("\n");
          }).join("\n\n")
        : "No line items extracted.";

    const dmFields = [
      po.poNumber              ? field("PO Number",     po.poNumber)                             : null,
      po.orderDate             ? field("Order Date",     po.orderDate)                            : null,
      po.requestedDeliveryDate ? field("Delivery Date",  po.requestedDeliveryDate)                : null,
      po.total        != null  ? field("Total",          formatCurrency(po.total, po.currency))   : null,
      po.paymentTerms          ? field("Payment Terms",  po.paymentTerms)                         : null,
      po.currency              ? field("Currency",       po.currency)                             : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

    return [
      { type: "header", text: { type: "plain_text", text: `📋 You claimed PO #${po.poNumber ?? "unknown"}`, emoji: true } },
      {
        type: "section",
        text: mrkdwn(`Here are the full details for the order you just claimed.\n*From:* ${tracked.email.sender}\n*Subject:* ${tracked.email.subject}`),
      },
      { type: "divider" },
      ...(dmFields.length > 0 ? [{ type: "section", fields: dmFields }] : []),
      ...(po.vendor && (po.vendor.name || po.vendor.address || po.vendor.contact || po.vendor.email || po.vendor.phone)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Vendor / Supplier*\n` +
              [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone]
                .filter(Boolean).join("\n")
            ),
          }]
        : []),
      ...(po.buyer || po.billTo
        ? [{
            type: "section",
            text: mrkdwn(
              `*Bill To*\n` +
              [
                po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
                po.billTo?.address ?? po.buyer?.address,
                po.buyer?.contact,
                po.buyer?.email,
                po.buyer?.phone,
              ].filter(Boolean).join("\n")
            ),
          }]
        : []),
      ...(po.shipTo && (po.shipTo.company || po.shipTo.address)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Ship To*\n` +
              [po.shipTo.company, po.shipTo.address].filter(Boolean).join("\n")
            ),
          }]
        : []),
      { type: "divider" },
      { type: "section", text: mrkdwn(`*Line Items*\n\`\`\`${lineItemsText}\`\`\``) },
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
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    const lineItemsText = d.lineItems && d.lineItems.length > 0
      ? d.lineItems.map((li, i) =>
          [
            `*${i + 1}*`,
            li.partNumber ? `PN: ${li.partNumber}` : null,
            li.description,
            li.quantity != null ? `Qty: ${li.quantity}${li.unit ? ` ${li.unit}` : ""}` : null,
          ].filter(Boolean).join("  |  ")
        ).join("\n")
      : null;

    const contactFields: ReturnType<typeof field>[] = [];
    if (d.contactName) contactFields.push(field("Contact", d.contactName));
    if (d.company)     contactFields.push(field("Company", d.company));
    if (d.email)       contactFields.push(field("Email",   d.email));
    if (d.phone)       contactFields.push(field("Phone",   d.phone));

    return [
      { type: "header", text: { type: "plain_text", text: "📝 Text Purchase Order Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From",       email.sender),
          field("Subject",    email.subject),
          field("Received",   email.receivedAt),
          field("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning ? [{ type: "section", text: mrkdwn(`*Summary:* ${classification.reasoning}`) }] : []),
      ...(lineItemsText ? [
          { type: "divider" },
          { type: "section", text: mrkdwn(`*Ordered Items*\n\`\`\`${lineItemsText}\`\`\``) },
        ] : []),
      ...(contactFields.length > 0 ? [{ type: "section", fields: contactFields.slice(0, 10) }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `_Classified as *Text PO* by KAIRA • ${new Date().toISOString()}_` }] },
    ];
  }

  private buildGeneralInquiryBlocks(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    const extractedFields: ReturnType<typeof field>[] = [];
    if (d.contactName)  extractedFields.push(field("Contact",  d.contactName));
    if (d.contactTitle) extractedFields.push(field("Title",    d.contactTitle));
    if (d.company)      extractedFields.push(field("Company",  d.company));
    if (d.email)        extractedFields.push(field("Email",    d.email));
    if (d.phone)        extractedFields.push(field("Phone",    d.phone));

    // Surface any other top-level string/number fields Claude extracted
    const extraFields = Object.entries(d)
      .filter(([k, v]) =>
        !["contactName","contactTitle","company","email","phone","directPhone","cellPhone","lineItems"].includes(k) &&
        v != null && (typeof v === "string" || typeof v === "number")
      )
      .map(([k, v]) => field(k, String(v)));

    const allFields = [...extractedFields, ...extraFields].slice(0, 10);

    return [
      { type: "header", text: { type: "plain_text", text: "💬 General Inquiry Received", emoji: true } },
      {
        type: "section",
        fields: [
          field("From",       email.sender),
          field("Subject",    email.subject),
          field("Received",   email.receivedAt),
          field("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning ? [{ type: "section", text: mrkdwn(`*Summary:* ${classification.reasoning}`) }] : []),
      ...(allFields.length > 0 ? [
          { type: "divider" },
          { type: "section", fields: allFields },
        ] : []),
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
