import Anthropic from "@anthropic-ai/sdk";
import { EmailClassification, EmailMessage, PurchaseOrderData } from "../../types/index.js";
import { SupportedImageMime } from "../attachments/AttachmentExtractor.js";

/**
 * All Claude API calls live here.
 *
 * - extractPurchaseOrderFromPdf   → parses PDF bytes into structured PO data
 * - extractPurchaseOrderFromImage → parses an image (JPEG/PNG/GIF/WebP) into PO data
 * - extractPurchaseOrderFromText  → parses extracted document text (DOCX/XLSX) into PO data
 * - classifyEmail                 → classifies a plain-text email into RFQ / General Inquiry / Text PO
 */
export class ClaudeService {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-opus-4-6") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  // ─── PDF Purchase Order Extraction ────────────────────────────────────────

  async extractPurchaseOrderFromPdf(
    pdfBase64: string,
    attachmentName: string
  ): Promise<PurchaseOrderData> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: "adaptive" } as any,
      system: PO_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
              title: attachmentName,
            },
            {
              type: "text",
              text: `Extract all purchase order data from this PDF and return ONLY a JSON object matching this schema:\n\n${PO_SCHEMA}\n\nReturn only the JSON object — no markdown fences, no explanation.`,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    return parseJson<PurchaseOrderData>(extractText(response), defaultPurchaseOrder());
  }

  // ─── Image Purchase Order Extraction ─────────────────────────────────────

  /**
   * Extracts PO data from a scanned document image (JPEG, PNG, GIF, WebP).
   * TIFF files should be converted to PNG by AttachmentExtractor before calling this.
   */
  async extractPurchaseOrderFromImage(
    imageBase64: string,
    mimeType: SupportedImageMime,
    attachmentName: string
  ): Promise<PurchaseOrderData> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: "adaptive" } as any,
      system: PO_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: `Extract all purchase order data from this scanned document image (${attachmentName}) and return ONLY a JSON object matching this schema:\n\n${PO_SCHEMA}\n\nReturn only the JSON object — no markdown fences, no explanation.`,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    return parseJson<PurchaseOrderData>(extractText(response), defaultPurchaseOrder());
  }

  // ─── Text Document Purchase Order Extraction ──────────────────────────────

  /**
   * Extracts PO data from plain text extracted from a DOCX or XLSX attachment.
   */
  async extractPurchaseOrderFromText(
    textContent: string,
    attachmentName: string
  ): Promise<PurchaseOrderData> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: "adaptive" } as any,
      system: PO_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Extract all purchase order data from this document (${attachmentName}) and return ONLY a JSON object matching this schema:\n\n${PO_SCHEMA}\n\nDocument content:\n\n${textContent.slice(0, 8000)}\n\nReturn only the JSON object — no markdown fences, no explanation.`,
        },
      ],
    });

    return parseJson<PurchaseOrderData>(extractText(response), defaultPurchaseOrder());
  }

  // ─── Email Classification ─────────────────────────────────────────────────

  async classifyEmail(email: EmailMessage): Promise<EmailClassification> {
    const systemPrompt = `You are an expert at classifying business emails for a manufacturing/supply-chain company.
Classify each email into exactly one of these categories:

- RFQ: Request for Quote — customer is explicitly asking for pricing, a quote, or availability on specific products
- Text PO: Purchase Order in the email body — customer is unambiguously placing an order with clear order details (quantities, part numbers, prices)
- General Inquiry: Any other email — questions, complaints, shipping status, product info, follow-ups, or anything that is NOT clearly an RFQ or PO

IMPORTANT: When in doubt, classify as "General Inquiry". Only classify as "RFQ" or "Text PO" when you are confident the email clearly matches those definitions. A low-confidence RFQ or Text PO should be classified as "General Inquiry" instead.

Always return valid JSON. Be concise in reasoning (1-2 sentences).`;

    const schema = `{
  "category": "RFQ" | "General Inquiry" | "Text PO",
  "confidence": "high" | "medium" | "low",
  "reasoning": string,         // 1-2 sentence summary of the email
  "extractedData": {
    // For RFQ — populate as many fields as you can find in the email:
    "contactName": string | null,
    "contactTitle": string | null,
    "company": string | null,
    "email": string | null,
    "phone": string | null,
    "directPhone": string | null,
    "cellPhone": string | null,
    "lineItems": [
      {
        "partNumber": string | null,
        "description": string,
        "quantity": number | null,
        "unit": string | null
      }
    ] | null,
    // For General Inquiry or Text PO — include any relevant structured data found
    [key: string]: any
  }
}`;

    const emailContext = [
      `Subject: ${email.subject}`,
      `From: ${email.sender}`,
      `Received: ${email.receivedAt}`,
      "",
      "Body:",
      email.bodyText.slice(0, 3000),
    ].join("\n");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: "adaptive" } as any,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Classify this email and return ONLY a JSON object matching this schema:\n\n${schema}\n\nEmail:\n${emailContext}\n\nReturn only the JSON object — no markdown fences, no explanation.`,
        },
      ],
    });

    const rawText = extractText(response);
    const result = parseJson<EmailClassification>(rawText, {
      category: "General Inquiry",
      confidence: "low",
      reasoning: "Failed to parse classification response.",
      extractedData: {},
    });

    // Safety net: low-confidence non-General-Inquiry → downgrade to General Inquiry.
    // Prevents ambiguous emails from being mis-routed as orders or quotes.
    if (result.confidence === "low" && result.category !== "General Inquiry") {
      console.log(
        `[ClaudeService] Downgrading "${result.category}" (low confidence) → General Inquiry`
      );
      return { ...result, category: "General Inquiry" };
    }

    return result;
  }
}

// ─── Shared PO extraction constants ───────────────────────────────────────────

const PO_SYSTEM_PROMPT = `You are an expert at parsing purchase order documents for a manufacturing and supply-chain company.

Your job is to extract ALL structured data from purchase orders with the highest possible accuracy. Follow these rules:

1. Always return valid JSON that exactly matches the schema — never omit a field, use null if not found.
2. Extract EVERY line item listed in the document, no matter how many there are.
3. For dates, preserve the format as written in the document (e.g. "2024-03-15", "March 15, 2024", "03/15/24").
4. For currency amounts, return numeric values only (no symbols) — capture the currency code separately.
5. Distinguish carefully between:
   - "Bill To" (who gets invoiced) vs "Ship To" (where goods are delivered)
   - "Vendor/Supplier" (who KAIRA's customer is ordering FROM) vs "Buyer" (who is placing the order)
6. For payment terms, capture the exact text (e.g. "Net 30", "2/10 Net 30", "Due on receipt").
7. If a document is clearly not a purchase order, set rawConfidence to "low" and fill what you can.`;

const PO_SCHEMA = `{
  "poNumber":             string | null,  // PO number / Purchase Order number / Order number
  "orderDate":            string | null,  // Date the PO was issued
  "requestedDeliveryDate": string | null, // Requested delivery date / ship date / need-by date

  "vendor": {                             // The vendor / supplier being ordered FROM
    "name":    string | null,
    "address": string | null,
    "contact": string | null,
    "email":   string | null,
    "phone":   string | null
  } | null,

  "buyer": {                              // The person / department placing the order
    "name":    string | null,             // Contact person name
    "company": string | null,             // Buyer's company name
    "address": string | null,
    "contact": string | null,             // Title or department
    "email":   string | null,
    "phone":   string | null
  } | null,

  "billTo": {                             // Bill To — company/address that receives the invoice
    "company": string | null,
    "address": string | null
  } | null,

  "shipTo": {                             // Ship To — company/address where goods are delivered
    "company": string | null,
    "address": string | null
  } | null,

  "lineItems": [                          // Every line item in the document
    {
      "lineNumber":    number | null,     // Line or item number
      "partNumber":    string | null,     // Part number, SKU, item code, catalog number
      "description":   string,            // Item description (required — use "" if truly absent)
      "quantity":      number | null,
      "unitOfMeasure": string | null,     // ea, pcs, lbs, kg, ft, etc.
      "unitPrice":     number | null,
      "totalPrice":    number | null      // Line total = quantity × unitPrice
    }
  ],

  "subtotal":     number | null,          // Sum of line totals before tax/shipping
  "tax":          number | null,          // Tax amount
  "shippingCost": number | null,          // Freight / shipping charge
  "total":        number | null,          // Grand total (subtotal + tax + shipping)
  "currency":     string | null,          // ISO-4217 code: "USD", "EUR", "GBP", etc.
  "paymentTerms": string | null,          // e.g. "Net 30", "2/10 Net 30", "Due on receipt"
  "notes":        string | null,          // Special instructions, comments, terms & conditions

  "rawConfidence": "high" | "medium" | "low"  // Overall confidence in this extraction
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

function parseJson<T>(raw: string, fallback: T): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    console.error("[ClaudeService] Failed to parse JSON response:", raw.slice(0, 200));
    return fallback;
  }
}

function defaultPurchaseOrder(): PurchaseOrderData {
  return {
    poNumber: null,
    orderDate: null,
    requestedDeliveryDate: null,
    vendor: null,
    buyer: null,
    billTo: null,
    shipTo: null,
    lineItems: [],
    subtotal: null,
    tax: null,
    shippingCost: null,
    total: null,
    currency: null,
    paymentTerms: null,
    notes: null,
    rawConfidence: "low",
  };
}
