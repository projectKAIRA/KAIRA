import mammoth from "mammoth";
import * as XLSX from "xlsx";
import sharp from "sharp";
import { createRequire } from "module";
import type { AttachmentData, FieldsData } from "@kenjiuno/msgreader";
import { EmailAttachment } from "../../types/index.js";

// @kenjiuno/msgreader is a CJS package that uses the __esModule convention.
// With module: NodeNext the default import resolves to the module namespace rather
// than the constructor, so we require() it and provide an explicit constructor type.
const _require = createRequire(import.meta.url);
const MsgReader = (_require("@kenjiuno/msgreader") as {
  default: new (buffer: Buffer | ArrayBuffer) => {
    getFileData():                            FieldsData;
    getAttachment(a: number | FieldsData):   AttachmentData;
  };
}).default;

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

const MSG_CONTENT_TYPES = new Set([
  "application/vnd.ms-outlook",
  "application/x-msg",
  "application/msg",
]);

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
 *  - MSG     → parsed via @kenjiuno/msgreader; inner attachments routed through
 *              this same pipeline; falls back to inner email body as text
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

    // .msg files may arrive with a specific MIME type OR as application/octet-stream
    // with a .msg filename — check both.
    if (MSG_CONTENT_TYPES.has(ct) || name.toLowerCase().endsWith(".msg")) {
      return this.extractMsg(contentBytes, name);
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

  /**
   * Parse a .msg (Outlook email) file and extract its inner attachments and/or body.
   *
   * Priority order (highest → lowest):
   *   1. PDF or text-based document (DOCX/XLSX) — definitive PO documents
   *   2. Inner email body text — forwarded emails carry the actual content here
   *   3. Image attachment — last resort; inline images are usually logos/signatures
   *
   * This ordering prevents decorative inline images (logos, headers, email signatures)
   * from blocking access to the body text that contains the actual PO data.
   *
   * Nested .msg files are handled recursively via extract().
   */
  private async extractMsg(base64: string, outerName: string): Promise<ExtractedContent | null> {
    const buffer = Buffer.from(base64, "base64");
    const reader = new MsgReader(buffer);
    const fileData = reader.getFileData();

    const attachments = fileData.attachments ?? [];
    const body = fileData.body?.trim() ?? "";

    console.log(
      `[AttachmentExtractor] .msg "${outerName}": ` +
      `${attachments.length} inner attachment(s), body length=${body.length}`
    );

    // Scan all inner attachments — bucket by kind rather than returning on first match.
    // We need to see what's available before deciding what to use.
    let firstDocument: ExtractedContent | null = null; // pdf or text (DOCX/XLSX)
    let firstImage: ExtractedContent | null = null;

    for (const attInfo of attachments) {
      const inner       = reader.getAttachment(attInfo);
      const innerName   = inner.fileName;
      const innerCt     = mimeFromExtension(innerName);
      const innerBase64 = Buffer.from(inner.content).toString("base64");

      console.log(`[AttachmentExtractor] .msg inner attachment: "${innerName}" (${innerCt})`);

      const synthetic: EmailAttachment = {
        id:           `msg-inner-${innerName}`,
        name:         innerName,
        contentType:  innerCt,
        contentBytes: innerBase64,
        size:         inner.content.length,
      };

      const extracted = await this.extract(synthetic);
      if (!extracted) continue;

      if (extracted.kind === "pdf" || extracted.kind === "text") {
        // Document found — use immediately, no need to scan further.
        console.log(`[AttachmentExtractor] .msg "${outerName}": using inner document "${innerName}"`);
        return extracted;
      }

      // Image — keep as fallback but keep scanning for a document.
      if (extracted.kind === "image" && !firstImage) {
        firstImage = extracted;
      }
    }

    // No document attachment found.
    // Prefer the inner email body — for forwarded emails this is where PO data lives.
    if (body) {
      console.log(
        `[AttachmentExtractor] .msg "${outerName}": ` +
        `no document attachment found — using inner body text` +
        (firstImage ? ` (skipping ${firstImage.name} image)` : "")
      );
      return { kind: "text", content: body, name: outerName, originalBase64: base64 };
    }

    // Body is empty — fall back to the image if one was found.
    if (firstImage) {
      console.log(
        `[AttachmentExtractor] .msg "${outerName}": body empty — falling back to image "${firstImage.name}"`
      );
      return firstImage;
    }

    console.warn(`[AttachmentExtractor] .msg "${outerName}": no extractable content found.`);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Infer a MIME content type from a filename extension. */
function mimeFromExtension(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf:  "application/pdf",
    doc:  "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls:  "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv:  "text/csv",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    png:  "image/png",
    gif:  "image/gif",
    webp: "image/webp",
    tif:  "image/tiff",
    tiff: "image/tiff",
    msg:  "application/vnd.ms-outlook",
  };
  return map[ext] ?? "application/octet-stream";
}
