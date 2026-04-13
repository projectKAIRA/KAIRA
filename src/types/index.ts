// ─── Email types ────────────────────────────────────────────────────────────

export interface EmailMessage {
  id: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  sender: string;
  receivedAt: string;
  hasAttachments: boolean;
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  id: string;
  name: string;
  contentType: string;
  contentBytes: string; // base64-encoded
  size: number;
}

// ─── Classification ──────────────────────────────────────────────────────────

export type EmailCategory = "RFQ" | "General Inquiry" | "Text PO";

export interface EmailClassification {
  category: EmailCategory;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  extractedData: Record<string, unknown>;
}

// ─── PO Extraction ───────────────────────────────────────────────────────────

export interface PurchaseOrderData {
  poNumber: string | null;
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  vendor: VendorInfo | null;
  buyer: BuyerInfo | null;
  /** Bill To — the company/address that should receive the invoice. */
  billTo: AddressBlock | null;
  /** Ship To — the company/address where goods should be delivered. */
  shipTo: AddressBlock | null;
  lineItems: POLineItem[];
  subtotal: number | null;
  tax: number | null;
  shippingCost: number | null;
  total: number | null;
  currency: string | null;
  paymentTerms: string | null;
  notes: string | null;
  rawConfidence: "high" | "medium" | "low";
}

/** A simple company + address block, used for Bill To and Ship To. */
export interface AddressBlock {
  company: string | null;
  address: string | null;
}

export interface VendorInfo {
  name: string | null;
  address: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
}

export interface BuyerInfo {
  name: string | null;
  company: string | null;
  address: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
}

export interface POLineItem {
  lineNumber: number | null;
  partNumber: string | null;
  description: string;
  quantity: number | null;
  unitOfMeasure: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
}

// ─── Notification ─────────────────────────────────────────────────────────────

export interface NotificationPayload {
  type: "pdf_po" | "rfq" | "general_inquiry" | "text_po";
  email: EmailMessage;
  classification?: EmailClassification;
  purchaseOrder?: PurchaseOrderData;
  attachmentName?: string;
  /** Raw base64 bytes of the source document (PDF, image, DOCX, XLSX) stored
   *  in the DB and uploaded to the claiming user via Slack DM. */
  documentBase64?: string;
}

// ─── Notification result ─────────────────────────────────────────────────────

export interface NotificationResult {
  // Populated when a PO is posted via the Slack Web API
  poTrackingId?: string;
  slackMessageTs?: string;
  slackChannelId?: string;
}

// ─── PO claim tracking ────────────────────────────────────────────────────────

export type POStatus = "unclaimed" | "claimed";

export interface TrackedPO {
  id: string;
  tenantId: string;         // KAIRA internal tenant UUID
  emailId: string;
  purchaseOrder: PurchaseOrderData;
  email: EmailMessage;
  pdfBase64: string;
  pdfName: string;
  status: POStatus;
  claimedBy?: string;       // Slack user ID
  claimedByName?: string;   // Slack display name
  claimedAt?: string;
  slackMessageTs?: string;
  slackChannelId?: string;
  receivedAt: string;
}

// ─── Processing result ───────────────────────────────────────────────────────

export interface ProcessingResult {
  emailId: string;
  success: boolean;
  action: "pdf_po_extracted" | "email_classified" | "skipped" | "error";
  details?: string;
  error?: string;
}
