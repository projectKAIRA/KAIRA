import mammoth from "mammoth";
import * as XLSX from "xlsx";
import sharp from "sharp";
import { EmailAttachment } from "../../types/index.js";

// ─── Content-type sets ────────────────────────────────────────────────────────

export const PDF_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "application/vnd.pdf",
]);

const DOCX_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword", // legacy .doc — mammoth handles with degraded fidelity
]);

const XLSX_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]);

// MIME types Claude's image block accepts directly
const DIRECT_IMAGE_TYPES = new Map<string, SupportedImageMime>([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg",  "image/jpeg"],
  ["image/png",  "image/png"],
  ["image/gif",  "image/gif"],
  ["image/webp", "image/webp"],
]);

const TIFF_CONTENT_TYPES = new Set(["image/tiff", "image/x-tiff"]);

// ─── Public types ─────────────────────────────────────────────────────────────

export type SupportedImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Normalised content extracted from an email attachment, ready to pass to Claude.
 *
 * `originalBase64` on the `text` variant carries the raw source file bytes so
 * the original DOCX/XLSX can be uploaded to Slack when a PO is claimed —
 * even though Claude only sees the extracted text.
 */
export type ExtractedContent =
  | { kind: "pdf";   base64: string;  name: string }
  | { kind: "image"; base64: string;  mimeType: SupportedImageMime; name: string }
  | { kind: "text";  content: string; name: string; originalBase64: string };

// ─── AttachmentExtractor ─────────────────────────────────────────────────────

/**
 * Converts any supported email attachment into normalised content for Claude.
 *
 * Supported formats:
 *  - PDF     → base64 passthrough (Claude document block)
 *  - DOCX    → plain text via mammoth
 *  - XLSX    → CSV text via SheetJS
 *  - JPEG / PNG / GIF / WebP → base64 passthrough (Claude image block)
 *  - TIFF    → converted to PNG via sharp, then base64
 *  - Unknown → returns null with a console.warn
 */
export class AttachmentExtractor {
  async extract(attachment: EmailAttachment): Promise<ExtractedContent | null> {
    // Strip parameters (e.g. "application/pdf; name=…") and normalise case
    const ct = attachment.contentType.toLowerCase().split(";")[0].trim();
    const { name, contentBytes } = attachment;

    if (PDF_CONTENT_TYPES.has(ct)) {
      return { kind: "pdf", base64: contentBytes, name };
    }

    if (DOCX_CONTENT_TYPES.has(ct)) {
      return this.extractDocx(contentBytes, name);
    }

    if (XLSX_CONTENT_TYPES.has(ct)) {
      return this.extractXlsx(contentBytes, name);
    }

    const imageMime = DIRECT_IMAGE_TYPES.get(ct);
    if (imageMime) {
      return { kind: "image", base64: contentBytes, mimeType: imageMime, name };
    }

    if (TIFF_CONTENT_TYPES.has(ct)) {
      return this.convertTiffToPng(contentBytes, name);
    }

    console.warn(
      `[AttachmentExtractor] Unrecognized content type "${ct}" for "${name}" — skipping.`
    );
    return null;
  }

  // ─── Format handlers ────────────────────────────────────────────────────────

  private async extractDocx(base64: string, name: string): Promise<ExtractedContent> {
    const buffer = Buffer.from(base64, "base64");
    const result = await mammoth.extractRawText({ buffer });

    if (result.messages.length > 0) {
      const warnings = result.messages.map((m) => m.message).join("; ");
      console.warn(`[AttachmentExtractor] mammoth warnings for "${name}": ${warnings}`);
    }

    return { kind: "text", content: result.value.trim(), name, originalBase64: base64 };
  }

  private extractXlsx(base64: string, name: string): ExtractedContent {
    const buffer = Buffer.from(base64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });

    const content = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return `=== Sheet: ${sheetName} ===\n${XLSX.utils.sheet_to_csv(sheet!)}`;
    }).join("\n\n");

    return { kind: "text", content, name, originalBase64: base64 };
  }

  private async convertTiffToPng(base64: string, name: string): Promise<ExtractedContent> {
    const buffer = Buffer.from(base64, "base64");
    const pngBuffer = await sharp(buffer).png().toBuffer();
    const pngBase64 = pngBuffer.toString("base64");
    const pngName = name.replace(/\.tiff?$/i, ".png");
    console.log(`[AttachmentExtractor] Converted TIFF "${name}" → PNG for Claude`);
    return { kind: "image", base64: pngBase64, mimeType: "image/png", name: pngName };
  }
}
