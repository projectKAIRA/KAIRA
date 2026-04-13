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

    if (!contentBytes) {
      console.warn(`[AttachmentExtractor] "${name}" has empty contentBytes — skipping.`);
      return null;
    }

    if (PDF_CONTENT_TYPES.has(ct)) {
      console.log(`[AttachmentExtractor] PDF matched by content type: "${name}" (${contentBytes.length} base64 chars)`);
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

    // Last resort: some email clients and servers send attachments with the generic
    // application/octet-stream content type regardless of the actual file format.
    // Re-route by filename extension so PDFs, DOCX, images, etc. are not silently dropped.
    if (ct === "application/octet-stream") {
      const inferredCt = mimeFromExtension(name);
      if (inferredCt !== "application/octet-stream") {
        console.log(
          `[AttachmentExtractor] "${name}" has generic content type — ` +
          `re-routing as inferred type "${inferredCt}" based on extension`
        );
        return this.extract({ ...attachment, contentType: inferredCt });
      }
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
   * Always scans EVERY inner attachment before deciding what to use.
   * Priority order (highest → lowest):
   *   1. PDF / DOCX / XLSX — the actual PO document
   *   2. Inner email body text — forwarded emails carry PO data here
   *   3. Image — last resort only; inline images are almost always logos/signatures
   *
   * Never stops early on an image. Logo and header images (image001.jpg, etc.) that
   * appear first in the attachment list are collected as a fallback only — the full
   * scan always completes so that a PDF appearing later is never missed.
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

    // Always scan every attachment. Collect documents and images into separate
    // buckets — never return early — so that a PDF listed after image001.jpg is
    // never skipped.
    const documents: ExtractedContent[] = []; // pdf or text (DOCX/XLSX/MSG)
    const images:    ExtractedContent[] = []; // image/* — fallback only

    for (const attInfo of attachments) {
      const inner       = reader.getAttachment(attInfo);
      const innerName   = inner.fileName;
      const innerCt     = mimeFromExtension(innerName);
      const innerBase64 = Buffer.from(inner.content).toString("base64");

      console.log(`[AttachmentExtractor] .msg inner attachment: "${innerName}" (${innerCt}, ${inner.content.length}B)`);

      const synthetic: EmailAttachment = {
        id:           `msg-inner-${innerName}`,
        name:         innerName,
        contentType:  innerCt,
        contentBytes: innerBase64,
        size:         inner.content.length,
      };

      const extracted = await this.extract(synthetic);
      if (!extracted) {
        console.log(`[AttachmentExtractor] .msg inner "${innerName}": extract() returned null — skipping`);
        continue;
      }

      if (extracted.kind === "pdf" || extracted.kind === "text") {
        documents.push(extracted);
        console.log(`[AttachmentExtractor] .msg inner "${innerName}": bucketed as document (kind=${extracted.kind})`);
      } else if (extracted.kind === "image") {
        images.push(extracted);
        console.log(`[AttachmentExtractor] .msg inner "${innerName}": bucketed as image (fallback only)`);
      }
    }

    console.log(
      `[AttachmentExtractor] .msg "${outerName}" scan complete: ` +
      `${documents.length} document(s), ${images.length} image(s), body=${body.length > 0 ? "present" : "empty"}`
    );

    // 1. Prefer the first real document — PDF wins, then DOCX/XLSX.
    if (documents.length > 0) {
      // Sort: pdf before text so a PDF attachment beats a text-extracted DOCX.
      const sorted = [...documents].sort((a, b) => {
        if (a.kind === "pdf" && b.kind !== "pdf") return -1;
        if (a.kind !== "pdf" && b.kind === "pdf") return  1;
        return 0;
      });
      const winner = sorted[0]!;
      console.log(`[AttachmentExtractor] .msg "${outerName}": using document "${winner.name}" (kind=${winner.kind})`);
      return winner;
    }

    // 2. No document — use inner email body text if available.
    if (body) {
      console.log(
        `[AttachmentExtractor] .msg "${outerName}": no document found — using inner body text` +
        (images.length > 0 ? ` (skipping ${images.length} image(s): ${images.map(i => i.name).join(", ")})` : "")
      );
      return { kind: "text", content: body, name: outerName, originalBase64: base64 };
    }

    // 3. Body empty — last resort: first image.
    if (images.length > 0) {
      console.log(
        `[AttachmentExtractor] .msg "${outerName}": body empty, no documents — ` +
        `falling back to image "${images[0]!.name}"`
      );
      return images[0]!;
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
