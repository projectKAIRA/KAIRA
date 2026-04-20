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
  /** ID of the channel where new (unclaimed) POs are posted — e.g. #kaira-unclaimed */
  poChannel: string;
  /** ID of the channel where claim summaries are posted — e.g. #kaira-claimed.
   *  Optional: if empty, no claim summary is posted to a second channel. */
  claimedChannel: string;
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
    const po    = payload.purchaseOrder!;
    const email = payload.email;

    // ── Confidence icon ───────────────────────────────────────────────────────
    const confIcon  = po.rawConfidence === "high" ? "🟢" : po.rawConfidence === "medium" ? "🟡" : "🔴";
    const confLabel = po.rawConfidence.toUpperCase();

    // ── Line items — clean mrkdwn rows, no code block ─────────────────────────
    const lineItemsText = po.lineItems.length > 0
      ? po.lineItems.slice(0, 15).map((li: POLineItem) => {
          const num  = li.lineNumber != null ? `*${li.lineNumber}.*` : "•";
          const desc = li.description ? `*${li.description}*` : "*(no description)*";
          const pn   = li.partNumber         ? `PN: ${li.partNumber}`                                       : null;
          const cpn  = li.customerPartNumber ? `Cust. PN: ${li.customerPartNumber}`                         : null;
          const qty  = li.quantity  != null  ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}` : null;
          const up   = li.unitPrice  != null ? `${formatCurrency(li.unitPrice,  po.currency)} ea`           : null;
          const tp   = li.totalPrice != null ? `${formatCurrency(li.totalPrice, po.currency)}`              : null;
          const meta = [pn, cpn, qty, up, tp].filter(Boolean).join("  ·  ");
          return `${num}  ${desc}${meta ? `\n      ${meta}` : ""}`;
        }).join("\n\n") +
        (po.lineItems.length > 15 ? `\n\n_… and ${po.lineItems.length - 15} more items_` : "")
      : "_No line items extracted_";

    // ── PO metadata fields — 2-column grid ────────────────────────────────────
    const poFields = [
      po.poNumber              ? field("PO Number",     po.poNumber)              : null,
      po.releaseNumber         ? field("Release No.",   po.releaseNumber)         : null,
      po.orderDate             ? field("Order Date",    po.orderDate)             : null,
      po.requestedDeliveryDate ? field("Delivery Date", po.requestedDeliveryDate) : null,
      po.requiredByDate        ? field("Required By",   po.requiredByDate)        : null,
      po.paymentTerms          ? field("Payment Terms", po.paymentTerms)          : null,
      po.shipVia               ? field("Ship Via",      po.shipVia)               : null,
      po.fobTerms              ? field("FOB",           po.fobTerms)              : null,
      po.currency              ? field("Currency",      po.currency)              : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

    // ── Sub-total breakdown ───────────────────────────────────────────────────
    const subFields = [
      po.subtotal     != null ? field("Subtotal",  formatCurrency(po.subtotal,     po.currency)) : null,
      po.tax          != null ? field("Tax",        formatCurrency(po.tax,          po.currency)) : null,
      po.shippingCost != null ? field("Shipping",   formatCurrency(po.shippingCost, po.currency)) : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

    // ── Claim / claimed block ─────────────────────────────────────────────────
    const claimBlock = claimed
      ? { type: "section", text: mrkdwn(`✅  *Claimed by ${claimed.byName}*  ·  ${claimed.at}`) }
      : {
          type: "actions",
          block_id: "po_actions",
          elements: [{
            type:      "button",
            text:      { type: "plain_text", text: "🏷️  Claim Order", emoji: true },
            style:     "primary",
            action_id: CLAIM_ACTION_ID,
            value:     trackingId,
            confirm: {
              title:   { type: "plain_text", text: "Claim this order?" },
              text:    { type: "mrkdwn",     text: "You'll receive a DM with the full PO details and the original PDF." },
              confirm: { type: "plain_text", text: "Yes, claim it" },
              deny:    { type: "plain_text", text: "Cancel" },
            },
          }],
        };

    return [
      // ── Header ──────────────────────────────────────────────────────────────
      { type: "header", text: { type: "plain_text", text: "📦  Purchase Order Received", emoji: true } },

      // ── Email origin ─────────────────────────────────────────────────────────
      {
        type: "section",
        fields: [
          field("From",     email.sender),
          field("Received", email.receivedAt),
          field("Subject",  email.subject),
          ...(payload.attachmentName ? [field("File", payload.attachmentName)] : []),
        ],
      },

      // ── PO identity + confidence banner ──────────────────────────────────────
      {
        type: "section",
        text: mrkdwn(
          [
            po.poNumber    ? `*PO #${po.poNumber}*`           : "*Purchase Order*",
            po.releaseNumber ? `Release: ${po.releaseNumber}` : null,
            `${confIcon}  ${confLabel}`,
            po.isBlanketPo ? "  🔄  *Blanket Order*"          : null,
          ].filter(Boolean).join("   ·   ")
        ),
      },

      { type: "divider" },

      // ── PO metadata (2-col) ───────────────────────────────────────────────────
      ...(poFields.length > 0 ? [{ type: "section", fields: poFields }] : []),

      // ── Vendor ───────────────────────────────────────────────────────────────
      ...(po.vendor && (po.vendor.name || po.vendor.address || po.vendor.contact || po.vendor.email || po.vendor.phone)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Vendor / Supplier*\n` +
              [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone]
                .filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      // ── Bill To ───────────────────────────────────────────────────────────────
      ...(po.buyer || po.billTo
        ? [{
            type: "section",
            text: mrkdwn(
              `*Bill To*\n` +
              [
                po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
                po.billTo?.poBox   ? `PO Box: ${po.billTo.poBox}` : null,
                po.billTo?.address ?? po.buyer?.address,
                po.buyer?.contact,
                po.buyer?.email,
                po.buyer?.phone,
              ].filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      // ── Ship To ───────────────────────────────────────────────────────────────
      ...(po.shipTo && (po.shipTo.company || po.shipTo.address || po.shipTo.poBox)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Ship To*\n` +
              [
                po.shipTo.company,
                po.shipTo.poBox ? `PO Box: ${po.shipTo.poBox}` : null,
                po.shipTo.address,
              ].filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      { type: "divider" },

      // ── Line items ────────────────────────────────────────────────────────────
      {
        type: "section",
        text: mrkdwn(
          `*Line Items${po.lineItems.length > 0 ? `  (${po.lineItems.length})` : ""}*\n\n${lineItemsText}`
        ),
      },

      // ── Sub-totals ────────────────────────────────────────────────────────────
      ...(subFields.length > 0 ? [{ type: "section", fields: subFields }] : []),

      // ── Grand total — prominent ───────────────────────────────────────────────
      ...(po.total != null
        ? [{
            type: "section",
            text: mrkdwn(`*Order Total*\n*${formatCurrency(po.total, po.currency)}*`),
          }]
        : []),

      // ── Notes ─────────────────────────────────────────────────────────────────
      ...(po.notes ? [{ type: "section", text: mrkdwn(`*Notes*\n${po.notes}`) }] : []),

      { type: "divider" },

      // ── Action ────────────────────────────────────────────────────────────────
      claimBlock,

      // ── Footer ────────────────────────────────────────────────────────────────
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Processed by KAIRA  ·  ${new Date().toISOString()}_` }],
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

    // ── Line items — clean mrkdwn rows, no code block ─────────────────────────
    const lineItemsText = po.lineItems.length > 0
      ? po.lineItems.slice(0, 20).map((li) => {
          const num  = li.lineNumber != null ? `*${li.lineNumber}.*` : "•";
          const desc = li.description ? `*${li.description}*` : "*(no description)*";
          const pn   = li.partNumber         ? `PN: ${li.partNumber}`                                       : null;
          const cpn  = li.customerPartNumber ? `Cust. PN: ${li.customerPartNumber}`                         : null;
          const qty  = li.quantity  != null  ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}` : null;
          const up   = li.unitPrice  != null ? `${formatCurrency(li.unitPrice,  po.currency)} ea`           : null;
          const tp   = li.totalPrice != null ? `${formatCurrency(li.totalPrice, po.currency)}`              : null;
          const meta = [pn, cpn, qty, up, tp].filter(Boolean).join("  ·  ");
          return `${num}  ${desc}${meta ? `\n      ${meta}` : ""}`;
        }).join("\n\n") +
        (po.lineItems.length > 20 ? `\n\n_… and ${po.lineItems.length - 20} more items_` : "")
      : "_No line items extracted_";

    const dmFields = [
      po.poNumber              ? field("PO Number",     po.poNumber)                           : null,
      po.releaseNumber         ? field("Release No.",   po.releaseNumber)                      : null,
      po.orderDate             ? field("Order Date",    po.orderDate)                          : null,
      po.requestedDeliveryDate ? field("Delivery Date", po.requestedDeliveryDate)              : null,
      po.requiredByDate        ? field("Required By",   po.requiredByDate)                     : null,
      po.paymentTerms          ? field("Payment Terms", po.paymentTerms)                       : null,
      po.shipVia               ? field("Ship Via",      po.shipVia)                            : null,
      po.fobTerms              ? field("FOB",           po.fobTerms)                           : null,
      po.currency              ? field("Currency",      po.currency)                           : null,
      po.isBlanketPo           ? field("Order Type",    "🔄 Blanket / Standing Order")         : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

    const subFields = [
      po.subtotal     != null ? field("Subtotal",  formatCurrency(po.subtotal,     po.currency)) : null,
      po.tax          != null ? field("Tax",        formatCurrency(po.tax,          po.currency)) : null,
      po.shippingCost != null ? field("Shipping",   formatCurrency(po.shippingCost, po.currency)) : null,
    ].filter(Boolean) as ReturnType<typeof field>[];

    return [
      // ── Header ──────────────────────────────────────────────────────────────
      {
        type: "header",
        text: { type: "plain_text", text: `✅  PO Claimed: #${po.poNumber ?? "Order"}`, emoji: true },
      },

      // ── Confirmation intro ────────────────────────────────────────────────────
      {
        type: "section",
        fields: [
          field("From",    tracked.email.sender),
          field("Subject", tracked.email.subject),
        ],
      },

      { type: "divider" },

      // ── PO metadata ──────────────────────────────────────────────────────────
      ...(dmFields.length > 0 ? [{ type: "section", fields: dmFields }] : []),

      // ── Vendor ───────────────────────────────────────────────────────────────
      ...(po.vendor && (po.vendor.name || po.vendor.address || po.vendor.contact || po.vendor.email || po.vendor.phone)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Vendor / Supplier*\n` +
              [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone]
                .filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      // ── Bill To ───────────────────────────────────────────────────────────────
      ...(po.buyer || po.billTo
        ? [{
            type: "section",
            text: mrkdwn(
              `*Bill To*\n` +
              [
                po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
                po.billTo?.poBox   ? `PO Box: ${po.billTo.poBox}` : null,
                po.billTo?.address ?? po.buyer?.address,
                po.buyer?.contact,
                po.buyer?.email,
                po.buyer?.phone,
              ].filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      // ── Ship To ───────────────────────────────────────────────────────────────
      ...(po.shipTo && (po.shipTo.company || po.shipTo.address || po.shipTo.poBox)
        ? [{
            type: "section",
            text: mrkdwn(
              `*Ship To*\n` +
              [
                po.shipTo.company,
                po.shipTo.poBox ? `PO Box: ${po.shipTo.poBox}` : null,
                po.shipTo.address,
              ].filter(Boolean).join("  ·  ")
            ),
          }]
        : []),

      { type: "divider" },

      // ── Line items ────────────────────────────────────────────────────────────
      {
        type: "section",
        text: mrkdwn(
          `*Line Items${po.lineItems.length > 0 ? `  (${po.lineItems.length})` : ""}*\n\n${lineItemsText}`
        ),
      },

      // ── Sub-totals ────────────────────────────────────────────────────────────
      ...(subFields.length > 0 ? [{ type: "section", fields: subFields }] : []),

      // ── Grand total ───────────────────────────────────────────────────────────
      ...(po.total != null
        ? [{ type: "section", text: mrkdwn(`*Order Total*\n*${formatCurrency(po.total, po.currency)}*`) }]
        : []),

      // ── Notes ─────────────────────────────────────────────────────────────────
      ...(po.notes ? [{ type: "section", text: mrkdwn(`*Notes*\n${po.notes}`) }] : []),

      // ── Footer ────────────────────────────────────────────────────────────────
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_The original PDF is attached below  ·  KAIRA_` }],
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

  // ─── Post a "✅ Claimed" summary to #kaira-claimed ────────────────────────

  /** Post a brief claim summary to the claimed channel (if configured). */
  async postClaimedSummary(tracked: TrackedPO): Promise<void> {
    if (!this.cfg.claimedChannel) return;

    const po = tracked.purchaseOrder;
    const claimedAt = tracked.claimedAt
      ? new Date(tracked.claimedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

    const fields = [
      po.poNumber   ? field("PO Number", po.poNumber)                                : null,
      po.total != null ? field("Total",  formatCurrency(po.total, po.currency))      : null,
      field("From",       tracked.email.sender),
      field("Claimed By", tracked.claimedByName ?? tracked.claimedBy ?? "Unknown"),
      field("Claimed At", claimedAt),
    ].filter(Boolean) as ReturnType<typeof field>[];

    const blocks = [
      { type: "header", text: { type: "plain_text", text: "✅ Purchase Order Claimed", emoji: true } },
      ...(fields.length > 0 ? [{ type: "section", fields }] : []),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_PO tracking ID: ${tracked.id} • KAIRA_` }],
      },
    ];

    try {
      await this.web.chat.postMessage({
        channel:    this.cfg.claimedChannel,
        username:   this.cfg.botName,
        icon_emoji: ":white_check_mark:",
        blocks:     blocks as any,
        text:       `PO claimed by ${tracked.claimedByName ?? "someone"}`,
      });
    } catch (err) {
      console.error("[SlackNotificationService] Failed to post claimed summary:", err);
    }
  }

  // ─── Daily digest of unclaimed orders ────────────────────────────────────

  /** Post the 9am daily digest of unclaimed orders to the unclaimed channel. */
  async postDailyDigest(orders: TrackedPO[]): Promise<void> {
    if (!this.cfg.poChannel) return;

    const count = orders.length;
    const header = count === 0
      ? "✅ No unclaimed orders — you're all caught up!"
      : `📋 Daily Digest — ${count} unclaimed order${count === 1 ? "" : "s"}`;

    const orderLines = orders.slice(0, 20).map((o) => {
      const po       = o.purchaseOrder;
      const poNum    = po.poNumber ? `*PO #${po.poNumber}*` : "*No PO Number*";
      const total    = po.total != null ? ` — ${formatCurrency(po.total, po.currency)}` : "";
      const received = o.receivedAt
        ? ` • Received ${new Date(o.receivedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : "";
      return `• ${poNum} from ${o.email.sender}${total}${received}`;
    });

    if (count > 20) orderLines.push(`_…and ${count - 20} more_`);

    const blocks: unknown[] = [
      { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    ];

    if (count > 0) {
      blocks.push({
        type: "section",
        text: mrkdwn(orderLines.join("\n")),
      });
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_Type \`/orders\` to see the full list with details • KAIRA_` }],
      });
    }

    try {
      await this.web.chat.postMessage({
        channel:    this.cfg.poChannel,
        username:   this.cfg.botName,
        icon_emoji: ":calendar:",
        blocks:     blocks as any,
        text:       header,
      });
    } catch (err) {
      console.error("[SlackNotificationService] Failed to post daily digest:", err);
    }
  }

  // ─── /orders slash command ephemeral response ─────────────────────────────

  /** Build the Block Kit blocks for the /orders ephemeral response. */
  buildOrdersEphemeral(orders: TrackedPO[]): unknown[] {
    if (orders.length === 0) {
      return [
        { type: "header", text: { type: "plain_text", text: "📋 Unclaimed Orders", emoji: true } },
        { type: "section", text: mrkdwn("✅ *No unclaimed orders right now.* You're all caught up!") },
      ];
    }

    const orderBlocks = orders.slice(0, 15).flatMap((o) => {
      const po       = o.purchaseOrder;
      const poNum    = po.poNumber ? `PO #${po.poNumber}` : "No PO Number";
      const total    = po.total != null ? `  *${formatCurrency(po.total, po.currency)}*` : "";
      const received = o.receivedAt
        ? new Date(o.receivedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Unknown date";

      const detailFields = [
        field("From",     o.email.sender),
        field("Received", received),
        ...(po.poNumber           ? [field("PO Number",    po.poNumber)]                           : []),
        ...(po.releaseNumber      ? [field("Release No.",  po.releaseNumber)]                      : []),
        ...(po.total     != null  ? [field("Total",        formatCurrency(po.total, po.currency))]  : []),
        ...(po.requiredByDate     ? [field("Required By",  po.requiredByDate)]                     : []),
        ...(po.shipVia            ? [field("Ship Via",     po.shipVia)]                            : []),
        ...(po.paymentTerms       ? [field("Payment Terms", po.paymentTerms)]                      : []),
      ].slice(0, 8) as ReturnType<typeof field>[];

      return [
        { type: "divider" },
        {
          type: "section",
          text: mrkdwn(`*${poNum}*${total}\n_${o.email.subject}_`),
          ...(detailFields.length > 0 && { fields: detailFields }),
        },
        {
          type: "actions",
          block_id: `po_actions_${o.id}`,
          elements: [
            {
              type:      "button",
              text:      { type: "plain_text", text: "Claim Order", emoji: true },
              style:     "primary",
              action_id: CLAIM_ACTION_ID,
              value:     o.id,
              confirm: {
                title:   { type: "plain_text", text: "Claim this order?" },
                text:    { type: "mrkdwn", text: "You'll receive a DM with the full PO details and the original PDF." },
                confirm: { type: "plain_text", text: "Yes, claim it" },
                deny:    { type: "plain_text", text: "Cancel" },
              },
            },
          ],
        },
      ];
    });

    const overflow = orders.length > 15
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: `_…and ${orders.length - 15} more unclaimed orders not shown_` }] }]
      : [];

    return [
      { type: "header", text: { type: "plain_text", text: `📋 Unclaimed Orders (${orders.length})`, emoji: true } },
      ...orderBlocks,
      ...overflow,
    ];
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
