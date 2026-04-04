import Anthropic from "@anthropic-ai/sdk";
import { EmailClassification, EmailMessage, PurchaseOrderData } from "../../types/index.js";

/**
 * All Claude API calls live here.
 *
 * - extractPurchaseOrderFromPdf  → parses PDF attachment bytes into structured PO data
 * - classifyEmail               → classifies a plain-text email into RFQ / General Inquiry / Text PO
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
    const systemPrompt = `You are an expert at parsing purchase order documents.
Your job is to extract structured data from purchase order PDFs with high accuracy.
Always return valid JSON matching the schema exactly.
If a field is not present or cannot be determined, use null.
For line items, extract every item listed in the document.`;

    const schema = `{
  "poNumber": string | null,
  "orderDate": string | null,          // ISO-8601 date or human-readable
  "requestedDeliveryDate": string | null,
  "vendor": {
    "name": string | null,
    "address": string | null,
    "contact": string | null,
    "email": string | null,
    "phone": string | null
  } | null,
  "buyer": {
    "name": string | null,
    "company": string | null,
    "address": string | null,
    "contact": string | null,
    "email": string | null,
    "phone": string | null
  } | null,
  "lineItems": [
    {
      "lineNumber": number | null,
      "partNumber": string | null,
      "description": string,
      "quantity": number | null,
      "unitOfMeasure": string | null,
      "unitPrice": number | null,
      "totalPrice": number | null
    }
  ],
  "subtotal": number | null,
  "tax": number | null,
  "shippingCost": number | null,
  "total": number | null,
  "currency": string | null,           // ISO-4217 code, e.g. "USD"
  "paymentTerms": string | null,
  "shippingAddress": string | null,
  "billingAddress": string | null,
  "notes": string | null,
  "rawConfidence": "high" | "medium" | "low"  // your confidence in the extraction
}`;

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: "adaptive" } as any,
      system: systemPrompt,
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
              text: `Extract all purchase order data from this PDF and return ONLY a JSON object matching this schema:\n\n${schema}\n\nReturn only the JSON object — no markdown fences, no explanation.`,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    const rawText = extractText(response);
    return parseJson<PurchaseOrderData>(rawText, defaultPurchaseOrder());
  }

  // ─── Email Classification ─────────────────────────────────────────────────

  async classifyEmail(email: EmailMessage): Promise<EmailClassification> {
    const systemPrompt = `You are an expert at classifying business emails for a manufacturing/supply-chain company.
Classify each email into exactly one of these categories:

- RFQ: Request for Quote — customer is asking for pricing on products or services
- Text PO: Purchase Order in the email body (no PDF attachment) — customer is placing an order via email text
- General Inquiry: Any other inquiry — questions, complaints, shipping status, product info, etc.

Always return valid JSON. Be concise in reasoning (1-2 sentences).`;

    const schema = `{
  "category": "RFQ" | "General Inquiry" | "Text PO",
  "confidence": "high" | "medium" | "low",
  "reasoning": string,
  "extractedData": object  // Any structured data extracted (e.g., product names, quantities, contact info)
}`;

    const emailContext = [
      `Subject: ${email.subject}`,
      `From: ${email.sender}`,
      `Received: ${email.receivedAt}`,
      "",
      "Body:",
      email.bodyText.slice(0, 3000), // cap to avoid excessive tokens
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
    return parseJson<EmailClassification>(rawText, {
      category: "General Inquiry",
      confidence: "low",
      reasoning: "Failed to parse classification response.",
      extractedData: {},
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

function parseJson<T>(raw: string, fallback: T): T {
  // Strip markdown code fences if Claude added them despite instructions
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
    lineItems: [],
    subtotal: null,
    tax: null,
    shippingCost: null,
    total: null,
    currency: null,
    paymentTerms: null,
    shippingAddress: null,
    billingAddress: null,
    notes: null,
    rawConfidence: "low",
  };
}
