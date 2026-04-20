import axios from "axios";
import { NotificationService } from "./NotificationService.js";
import { NotificationPayload, NotificationResult, POLineItem, TrackedPO } from "../../types/index.js";
import { POTracker } from "../po/POTracker.js";

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
  [key: string]: unknown;
}

interface TeamsConfig {
  webhookUrl: string;
}

/**
 * Microsoft Teams notification provider.
 *
 * Uses the Teams Incoming Webhook with Adaptive Cards (Teams-compatible format).
 * PDF POs are tracked in the database and include a "Claim Order" button that
 * opens a KAIRA web page (baseUrl/teams/claim/:id) where a team member can
 * claim the order — this is the Teams equivalent of Slack's interactive button,
 * since incoming webhooks are one-way and cannot receive button click events.
 *
 * To activate: set NOTIFICATION_PROVIDER=teams and TEAMS_WEBHOOK_URL in .env.
 */
export class TeamsNotificationService implements NotificationService {
  readonly name = "Teams";

  constructor(
    private readonly cfg: TeamsConfig,
    private readonly tracker: POTracker,
    private readonly baseUrl: string,
  ) {}

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    if (payload.type === "pdf_po") {
      return this.sendPdfPo(payload);
    }

    // RFQ, text_po, general_inquiry — no tracking needed, plain card post
    const card = this.buildAdaptiveCard(payload);
    try {
      await this.postCard(card);
    } catch (err) {
      console.error("[TeamsNotificationService] Failed to post message:", err);
    }
    return {};
  }

  // ─── PDF PO — tracked, with Claim Order button ────────────────────────────

  private async sendPdfPo(payload: NotificationPayload): Promise<NotificationResult> {
    const { email, purchaseOrder, attachmentName } = payload;
    if (!purchaseOrder || !email) return {};

    const storedBase64 =
      payload.documentBase64 ??
      email.attachments.find((a) => a.name === attachmentName)?.contentBytes ??
      "";

    const tracked = await this.tracker.track({
      emailId:       email.id,
      purchaseOrder,
      email,
      pdfBase64:     storedBase64,
      pdfName:       attachmentName ?? "purchase_order.pdf",
    });

    const card = this.buildAdaptiveCard(payload, tracked.id);
    try {
      await this.postCard(card);
    } catch (err) {
      console.error("[TeamsNotificationService] Failed to post PO:", err);
    }

    return { poTrackingId: tracked.id };
  }

  /**
   * Post a new Teams channel card announcing that an order has been claimed.
   * Called from the /teams/claim/:id web route after a successful claim.
   */
  async sendClaimNotification(tracked: TrackedPO): Promise<void> {
    const po = tracked.purchaseOrder;
    const claimedAt = tracked.claimedAt
      ? new Date(tracked.claimedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : "unknown time";

    const card = {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type:    "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type:   "TextBlock",
          text:   "✅ Purchase Order Claimed",
          size:   "Large",
          weight: "Bolder",
          color:  "Good",
        },
        {
          type:  "FactSet",
          facts: [
            fact("PO Number",  po.poNumber ?? "—"),
            fact("Claimed By", tracked.claimedByName ?? "—"),
            fact("Claimed At", claimedAt),
            ...(po.total != null ? [fact("Total", formatCurrencyTeams(po.total, po.currency))] : []),
          ],
        },
      ],
      msteams: { width: "Full" },
    };

    try {
      await this.postCard(card);
    } catch (err) {
      console.error("[TeamsNotificationService] Failed to send claim notification:", err);
    }
  }

  private async postCard(card: unknown): Promise<void> {
    await axios.post(this.cfg.webhookUrl, {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl:  null,
        content:     card,
      }],
    });
  }

  // ─── Adaptive Card builder ───────────────────────────────────────────────

  private buildAdaptiveCard(payload: NotificationPayload, trackingId?: string): unknown {
    const body    = this.buildBody(payload, trackingId);
    const actions = trackingId ? this.buildClaimAction(trackingId) : undefined;
    return {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type:    "AdaptiveCard",
      version: "1.5",
      body,
      ...(actions ? { actions } : {}),
      msteams: { width: "Full" },
    };
  }

  private buildBody(payload: NotificationPayload, _trackingId?: string): unknown[] {
    switch (payload.type) {
      case "pdf_po":          return this.pdfPoBody(payload);
      case "rfq":             return this.rfqBody(payload);
      case "text_po":         return this.textPoBody(payload);
      case "general_inquiry": return this.generalInquiryBody(payload);
    }
  }

  private buildClaimAction(trackingId: string): unknown[] {
    return [
      {
        type:  "Action.OpenUrl",
        title: "Claim Order",
        url:   `${this.baseUrl}/teams/claim/${encodeURIComponent(trackingId)}`,
        style: "positive",
      },
    ];
  }

  private pdfPoBody(payload: NotificationPayload): unknown[] {
    const po    = payload.purchaseOrder!;
    const email = payload.email;

    // ── Confidence badge color ────────────────────────────────────────────────
    const confColor = po.rawConfidence === "high" ? "Good" : po.rawConfidence === "medium" ? "Warning" : "Attention";
    const confLabel = po.rawConfidence.toUpperCase();

    // ── Helper: one label+value column ───────────────────────────────────────
    const col = (label: string, value: string, opts: Record<string, unknown> = {}): unknown => ({
      type: "Column",
      width: "stretch",
      items: [
        { type: "TextBlock", text: label,  size: "Small", isSubtle: true, wrap: false, spacing: "None" },
        { type: "TextBlock", text: value,  weight: "Bolder", spacing: "None", wrap: true, ...opts },
      ],
    });

    // ── Helper: a 2-col (or 1-col) field row ─────────────────────────────────
    const row2 = (
      l1: string, v1: string,
      l2?: string | null, v2?: string | null,
      opts?: Record<string, unknown>,
    ): unknown => ({
      type: "ColumnSet",
      spacing: "Small",
      columns: [
        col(l1, v1, opts ?? {}),
        ...(l2 && v2 ? [col(l2, v2, opts ?? {})] : [{ type: "Column", width: "stretch", items: [] }]),
      ],
    });

    // ── PO metadata pairs ─────────────────────────────────────────────────────
    const metaRows: unknown[] = [];
    const metaPairs: Array<[string, string]> = [
      ...(po.poNumber              ? [["PO Number",     po.poNumber]              as [string, string]] : []),
      ...(po.releaseNumber         ? [["Release No.",   po.releaseNumber]         as [string, string]] : []),
      ...(po.orderDate             ? [["Order Date",    po.orderDate]             as [string, string]] : []),
      ...(po.requestedDeliveryDate ? [["Delivery Date", po.requestedDeliveryDate] as [string, string]] : []),
      ...(po.requiredByDate        ? [["Required By",   po.requiredByDate]        as [string, string]] : []),
      ...(po.paymentTerms          ? [["Payment Terms", po.paymentTerms]          as [string, string]] : []),
      ...(po.shipVia               ? [["Ship Via",      po.shipVia]               as [string, string]] : []),
      ...(po.fobTerms              ? [["FOB",           po.fobTerms]              as [string, string]] : []),
      ...(po.currency              ? [["Currency",      po.currency]              as [string, string]] : []),
    ];
    // Emit pairs as 2-column rows, last one solo if odd count
    for (let i = 0; i < metaPairs.length; i += 2) {
      const [l1, v1] = metaPairs[i]!;
      const next = metaPairs[i + 1];
      metaRows.push(row2(l1, v1, next?.[0] ?? null, next?.[1] ?? null));
    }

    // ── Address blocks ────────────────────────────────────────────────────────
    const vendorLine = po.vendor
      ? [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone].filter(Boolean).join("  ·  ")
      : null;

    const billToLine = (po.billTo || po.buyer)
      ? [
          po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
          po.billTo?.poBox   ? `PO Box: ${po.billTo.poBox}` : null,
          po.billTo?.address ?? po.buyer?.address,
          po.buyer?.email,
          po.buyer?.phone,
        ].filter(Boolean).join("  ·  ")
      : null;

    const shipToLine = (po.shipTo && (po.shipTo.company || po.shipTo.address || po.shipTo.poBox))
      ? [
          po.shipTo.company,
          po.shipTo.poBox ? `PO Box: ${po.shipTo.poBox}` : null,
          po.shipTo.address,
        ].filter(Boolean).join("  ·  ")
      : null;

    // ── Line items — one ColumnSet per item ───────────────────────────────────
    const lineItemBlocks: unknown[] = po.lineItems.slice(0, 20).flatMap((li: POLineItem, idx) => {
      const desc = li.description || "(no description)";
      const pn   = [li.partNumber, li.customerPartNumber ? `Cust. PN: ${li.customerPartNumber}` : null]
        .filter(Boolean).join("  /  ");
      const qty  = li.quantity  != null
        ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ""}`
        : null;
      const up   = li.unitPrice  != null ? `${formatCurrencyTeams(li.unitPrice,  po.currency)} ea` : null;
      const tp   = li.totalPrice != null ? formatCurrencyTeams(li.totalPrice, po.currency)          : null;
      const meta = [pn, qty].filter(Boolean).join("  ·  ");

      return [{
        type: "ColumnSet",
        separator: idx > 0,
        spacing: "Small",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              { type: "TextBlock", text: desc, weight: "Bolder", wrap: true,  spacing: "None" },
              ...(meta ? [{ type: "TextBlock", text: meta, size: "Small", isSubtle: true, spacing: "None", wrap: true }] : []),
              ...(up   ? [{ type: "TextBlock", text: up,   size: "Small", isSubtle: true, spacing: "None" }]             : []),
            ],
          },
          {
            type: "Column",
            width: "auto",
            items: [
              ...(tp ? [{ type: "TextBlock", text: tp, weight: "Bolder", horizontalAlignment: "Right", spacing: "None" }] : []),
            ],
          },
        ],
      }];
    });

    if (po.lineItems.length > 20) {
      lineItemBlocks.push({
        type: "TextBlock",
        text: `… and ${po.lineItems.length - 20} more items`,
        isSubtle: true,
        size: "Small",
        spacing: "Small",
      });
    }

    // ── Totals ────────────────────────────────────────────────────────────────
    const subTotalRows: unknown[] = [];
    const subPairs: Array<[string, string]> = [
      ...(po.subtotal     != null ? [["Subtotal",  formatCurrencyTeams(po.subtotal,     po.currency)] as [string, string]] : []),
      ...(po.tax          != null ? [["Tax",        formatCurrencyTeams(po.tax,          po.currency)] as [string, string]] : []),
      ...(po.shippingCost != null ? [["Shipping",   formatCurrencyTeams(po.shippingCost, po.currency)] as [string, string]] : []),
    ];
    for (let i = 0; i < subPairs.length; i += 2) {
      const [l1, v1] = subPairs[i]!;
      const next = subPairs[i + 1];
      subTotalRows.push(row2(l1, v1, next?.[0] ?? null, next?.[1] ?? null));
    }

    return [
      // ── Title bar ────────────────────────────────────────────────────────────
      {
        type: "ColumnSet",
        columns: [
          {
            type: "Column",
            width: "auto",
            verticalContentAlignment: "Center",
            items: [{ type: "TextBlock", text: "📦", size: "ExtraLarge", spacing: "None" }],
          },
          {
            type: "Column",
            width: "stretch",
            verticalContentAlignment: "Center",
            items: [
              { type: "TextBlock", text: "Purchase Order Received", size: "Large", weight: "Bolder", spacing: "None", wrap: false },
              { type: "TextBlock", text: `from ${email.sender}`, size: "Small", isSubtle: true, spacing: "None", wrap: true },
            ],
          },
          {
            type: "Column",
            width: "auto",
            verticalContentAlignment: "Center",
            items: [
              { type: "TextBlock", text: `● ${confLabel}`, color: confColor, weight: "Bolder", horizontalAlignment: "Right", spacing: "None" },
            ],
          },
        ],
      },

      // ── Email metadata ────────────────────────────────────────────────────────
      { type: "FactSet", separator: true, spacing: "Small", facts: [
          fact("Subject",    email.subject),
          fact("Received",   email.receivedAt),
          ...(payload.attachmentName ? [fact("File", payload.attachmentName)] : []),
        ],
      },

      // ── PO identity row ───────────────────────────────────────────────────────
      ...(po.poNumber || po.releaseNumber || po.isBlanketPo ? [{
        type: "TextBlock",
        separator: true,
        spacing: "Medium",
        text: [
          po.poNumber      ? `**PO #${po.poNumber}**`              : "**Purchase Order**",
          po.releaseNumber ? `Release: ${po.releaseNumber}`        : null,
          po.isBlanketPo   ? "🔄 Blanket Order"                   : null,
        ].filter(Boolean).join("   ·   "),
        size: "Medium",
        wrap: true,
      }] : []),

      // ── PO metadata (2-col pairs) ─────────────────────────────────────────────
      ...(metaRows.length > 0 ? [
        { type: "TextBlock", text: "ORDER DETAILS", size: "Small", weight: "Bolder", isSubtle: true, spacing: "Medium" },
        ...metaRows,
      ] : []),

      // ── Addresses ────────────────────────────────────────────────────────────
      ...(vendorLine || billToLine || shipToLine ? [
        { type: "TextBlock", text: "PARTIES", size: "Small", weight: "Bolder", isSubtle: true, spacing: "Medium" },
        ...(vendorLine  ? [{ type: "TextBlock", text: `**Vendor:** ${vendorLine}`,   wrap: true, spacing: "Small" }] : []),
        ...(billToLine  ? [{ type: "TextBlock", text: `**Bill To:** ${billToLine}`,  wrap: true, spacing: "Small" }] : []),
        ...(shipToLine  ? [{ type: "TextBlock", text: `**Ship To:** ${shipToLine}`,  wrap: true, spacing: "Small" }] : []),
      ] : []),

      // ── Line items ────────────────────────────────────────────────────────────
      ...(po.lineItems.length > 0 ? [
        {
          type: "TextBlock",
          text: `LINE ITEMS  (${po.lineItems.length})`,
          size: "Small",
          weight: "Bolder",
          isSubtle: true,
          spacing: "Medium",
        },
        {
          type: "Container",
          style: "emphasis",
          bleed: false,
          spacing: "Small",
          items: lineItemBlocks,
        },
      ] : []),

      // ── Sub-totals ────────────────────────────────────────────────────────────
      ...subTotalRows,

      // ── Grand total — prominent ───────────────────────────────────────────────
      ...(po.total != null ? [{
        type: "ColumnSet",
        separator: true,
        spacing: "Small",
        columns: [
          { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "ORDER TOTAL", size: "Medium", weight: "Bolder", spacing: "None" },
            ],
          },
          { type: "Column", width: "auto", items: [
              { type: "TextBlock", text: formatCurrencyTeams(po.total, po.currency), size: "Large", weight: "Bolder", horizontalAlignment: "Right", color: "Good", spacing: "None" },
            ],
          },
        ],
      }] : []),

      // ── Notes ─────────────────────────────────────────────────────────────────
      ...(po.notes ? [{
        type: "TextBlock",
        text: `**Notes:** ${po.notes}`,
        wrap: true,
        isSubtle: true,
        size: "Small",
        spacing: "Medium",
      }] : []),

      // ── Footer ────────────────────────────────────────────────────────────────
      {
        type: "TextBlock",
        text: `Processed by KAIRA  ·  ${new Date().toISOString()}`,
        isSubtle: true,
        size: "Small",
        spacing: "Medium",
      },
    ];
  }

  private rfqBody(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    const lineItemsText = d.lineItems && d.lineItems.length > 0
      ? d.lineItems.map((li, i) =>
          [
            `${i + 1}.`,
            li.partNumber ? `PN: ${li.partNumber}` : null,
            li.description,
            li.quantity != null ? `Qty: ${li.quantity}${li.unit ? ` ${li.unit}` : ""}` : null,
          ].filter(Boolean).join("  ")
        ).join("\n")
      : null;

    const contactFacts = [
      d.contactName  ? fact("Contact",  d.contactName)  : null,
      d.contactTitle ? fact("Title",    d.contactTitle) : null,
      d.company      ? fact("Company",  d.company)      : null,
      d.email        ? fact("Email",    d.email)        : null,
      d.phone        ? fact("Phone",    d.phone)        : null,
      d.directPhone  ? fact("Direct",   d.directPhone)  : null,
      d.cellPhone    ? fact("Cell",     d.cellPhone)    : null,
    ].filter(Boolean) as ReturnType<typeof fact>[];

    return [
      { type: "TextBlock", text: "📋 RFQ Received", size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: [
          fact("From",       email.sender),
          fact("Subject",    email.subject),
          fact("Received",   email.receivedAt),
          fact("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning
        ? [{ type: "TextBlock", text: classification.reasoning, wrap: true }]
        : []),
      ...(lineItemsText ? [
          { type: "TextBlock", text: "**Requested Items**", weight: "Bolder", spacing: "Medium" },
          { type: "TextBlock", text: lineItemsText, wrap: true, fontType: "Monospace" },
        ] : []),
      ...(contactFacts.length > 0 ? [
          { type: "TextBlock", text: "**Contact Info**", weight: "Bolder", spacing: "Medium" },
          { type: "FactSet", facts: contactFacts },
        ] : []),
      { type: "TextBlock", text: `Classified by KAIRA • ${new Date().toISOString()}`, isSubtle: true, size: "Small", spacing: "Medium" },
    ];
  }

  private textPoBody(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    const lineItemsText = d.lineItems && d.lineItems.length > 0
      ? d.lineItems.map((li, i) =>
          [
            `${i + 1}.`,
            li.partNumber ? `PN: ${li.partNumber}` : null,
            li.description,
            li.quantity != null ? `Qty: ${li.quantity}${li.unit ? ` ${li.unit}` : ""}` : null,
          ].filter(Boolean).join("  ")
        ).join("\n")
      : null;

    const contactFacts = [
      d.contactName ? fact("Contact", d.contactName) : null,
      d.company     ? fact("Company", d.company)     : null,
      d.email       ? fact("Email",   d.email)       : null,
      d.phone       ? fact("Phone",   d.phone)       : null,
    ].filter(Boolean) as ReturnType<typeof fact>[];

    return [
      { type: "TextBlock", text: "📝 Text Purchase Order Received", size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: [
          fact("From",       email.sender),
          fact("Subject",    email.subject),
          fact("Received",   email.receivedAt),
          fact("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning
        ? [{ type: "TextBlock", text: classification.reasoning, wrap: true }]
        : []),
      ...(lineItemsText ? [
          { type: "TextBlock", text: "**Ordered Items**", weight: "Bolder", spacing: "Medium" },
          { type: "TextBlock", text: lineItemsText, wrap: true, fontType: "Monospace" },
        ] : []),
      ...(contactFacts.length > 0 ? [
          { type: "TextBlock", text: "**Contact Info**", weight: "Bolder", spacing: "Medium" },
          { type: "FactSet", facts: contactFacts },
        ] : []),
      { type: "TextBlock", text: `Classified by KAIRA • ${new Date().toISOString()}`, isSubtle: true, size: "Small", spacing: "Medium" },
    ];
  }

  private generalInquiryBody(payload: NotificationPayload): unknown[] {
    const { email, classification } = payload;
    const d = (classification?.extractedData ?? {}) as RfqExtractedData;

    // For general inquiries, pull any structured fields Claude extracted
    const extractedFacts = [
      d.contactName  ? fact("Contact",  d.contactName)  : null,
      d.contactTitle ? fact("Title",    d.contactTitle) : null,
      d.company      ? fact("Company",  d.company)      : null,
      d.email        ? fact("Email",    d.email)        : null,
      d.phone        ? fact("Phone",    d.phone)        : null,
    ].filter(Boolean) as ReturnType<typeof fact>[];

    // Also surface any other top-level string/number fields Claude added
    const extraFacts = Object.entries(d)
      .filter(([k, v]) =>
        !["contactName","contactTitle","company","email","phone","directPhone","cellPhone","lineItems"].includes(k) &&
        v != null && (typeof v === "string" || typeof v === "number")
      )
      .map(([k, v]) => fact(k, String(v)));

    const allFacts = [...extractedFacts, ...extraFacts];

    return [
      { type: "TextBlock", text: "💬 General Inquiry Received", size: "Large", weight: "Bolder" },
      { type: "FactSet", facts: [
          fact("From",       email.sender),
          fact("Subject",    email.subject),
          fact("Received",   email.receivedAt),
          fact("Confidence", classification?.confidence.toUpperCase() ?? "—"),
        ],
      },
      ...(classification?.reasoning
        ? [{ type: "TextBlock", text: classification.reasoning, wrap: true }]
        : []),
      ...(allFacts.length > 0 ? [
          { type: "TextBlock", text: "**Details**", weight: "Bolder", spacing: "Medium" },
          { type: "FactSet", facts: allFacts },
        ] : []),
      { type: "TextBlock", text: `Classified by KAIRA • ${new Date().toISOString()}`, isSubtle: true, size: "Small", spacing: "Medium" },
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
