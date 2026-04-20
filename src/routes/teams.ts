import express, { Router, Request, Response } from "express";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { TeamsNotificationService } from "../services/notifications/TeamsNotificationService.js";
import { TrackedPO, POLineItem } from "../types/index.js";

export function createTeamsRouter(scheduler: TenantScheduler): Router {
  const router = Router();

  // Parse application/x-www-form-urlencoded bodies (HTML form submissions)
  router.use(express.urlencoded({ extended: false }));

  router.use((_req, res, next) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    next();
  });

  // ─── GET /teams/claim/:id ─────────────────────────────────────────────────
  // Show the claim form with full PO details.
  // If already claimed, show who claimed it.

  router.get("/:id", async (req: Request, res: Response) => {
    const id = req.params["id"] as string;

    const runtime = await scheduler.findRuntimeByOrderId(id);
    if (!runtime) {
      res.status(404).send(page(renderNotFound(id)));
      return;
    }

    const tracked = await runtime.tracker.get(id);
    if (!tracked) {
      res.status(404).send(page(renderNotFound(id)));
      return;
    }

    if (tracked.status === "claimed") {
      res.send(page(renderAlreadyClaimed(tracked)));
      return;
    }

    res.send(page(renderClaimForm(tracked, id)));
  });

  // ─── POST /teams/claim/:id ────────────────────────────────────────────────
  // Process the claim. Body: { claimerName }

  router.post("/:id", async (req: Request, res: Response) => {
    const id          = req.params["id"] as string;
    const claimerName = ((req.body?.claimerName as string) ?? "").trim();

    if (!claimerName) {
      const runtime = await scheduler.findRuntimeByOrderId(id);
      const tracked = runtime ? await runtime.tracker.get(id) : null;
      if (!tracked) { res.status(404).send(page(renderNotFound(id))); return; }
      res.send(page(renderClaimForm(tracked, id, "Please enter your name before claiming.")));
      return;
    }

    const runtime = await scheduler.findRuntimeByOrderId(id);
    if (!runtime) {
      res.status(404).send(page(renderNotFound(id)));
      return;
    }

    // Check current state before attempting claim
    const current = await runtime.tracker.get(id);
    if (!current) {
      res.status(404).send(page(renderNotFound(id)));
      return;
    }
    if (current.status === "claimed") {
      res.send(page(renderAlreadyClaimed(current)));
      return;
    }

    // "teams_web" as the userId — Teams incoming webhooks don't provide a user ID
    const claimed = await runtime.tracker.claim(id, "teams_web", claimerName);
    if (!claimed) {
      // Race condition — someone claimed between our check and this call
      const updated = await runtime.tracker.get(id);
      res.send(page(updated ? renderAlreadyClaimed(updated) : renderNotFound(id)));
      return;
    }

    // Notify the Teams channel that the order has been claimed
    if (runtime.notifier instanceof TeamsNotificationService) {
      void runtime.notifier.sendClaimNotification(claimed).catch((err) => {
        console.error("[TeamsClaimRoute] Failed to send claim notification:", err);
      });
    }

    res.send(page(renderSuccess(claimed)));
  });

  return router;
}

// ─── Page renderers ───────────────────────────────────────────────────────────

function renderClaimForm(tracked: TrackedPO, id: string, errorMsg?: string): string {
  const po = tracked.purchaseOrder;

  return `
    <div class="card">
      <div class="card-title">📄 Purchase Order — Claim this order</div>
      <div class="card-sub">
        Review the details below, enter your name, and click <strong>Claim Order</strong>
        to take ownership. You will receive a copy of all details on this page.
      </div>

      ${errorMsg ? `<div class="error-msg">${escHtml(errorMsg)}</div>` : ""}

      ${renderPoDetails(tracked)}

      <form method="POST" action="/teams/claim/${escAttr(id)}" style="margin-top:1.75rem;">
        <div class="field">
          <label for="claimerName">Your name</label>
          <input type="text" id="claimerName" name="claimerName"
                 placeholder="Jane Smith" required autocomplete="name">
        </div>
        <button type="submit" class="btn btn-claim">Claim Order &rarr;</button>
      </form>
    </div>
  `;
}

function renderSuccess(tracked: TrackedPO): string {
  const claimedAt = tracked.claimedAt
    ? new Date(tracked.claimedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "";

  return `
    <div class="card">
      <div class="success-icon">✅</div>
      <div class="success-title">Order Claimed</div>
      <div class="success-sub">
        Claimed by <strong>${escHtml(tracked.claimedByName ?? "")}</strong>
        ${claimedAt ? `at ${escHtml(claimedAt)}` : ""}.
      </div>
      <div class="save-notice">
        📋 <strong>This page is your order record.</strong>
        Bookmark it, print it, or copy the details below — all PO information is shown in full.
        <button onclick="window.print()" class="btn-print">🖨️ Print / Save as PDF</button>
      </div>
    </div>

    <div class="card" style="margin-top:1.25rem;">
      <div class="card-title" style="margin-bottom:1.25rem;">Full PO Details</div>
      ${renderPoDetails(tracked)}
    </div>
  `;
}

function renderAlreadyClaimed(tracked: TrackedPO): string {
  const claimedAt = tracked.claimedAt
    ? new Date(tracked.claimedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "an earlier time";

  return `
    <div class="card">
      <div class="warn-icon">⚠️</div>
      <div class="success-title" style="color:var(--ink);">Already Claimed</div>
      <div class="success-sub">
        This order was already claimed by
        <strong>${escHtml(tracked.claimedByName ?? tracked.claimedBy ?? "someone")}</strong>
        at ${escHtml(claimedAt)}.
      </div>
    </div>

    <div class="card" style="margin-top:1.25rem;">
      <div class="card-title" style="margin-bottom:1.25rem;">PO Details</div>
      ${renderPoDetails(tracked)}
    </div>
  `;
}

function renderNotFound(id: string): string {
  return `
    <div class="card">
      <div class="warn-icon">🔍</div>
      <div class="success-title">Order Not Found</div>
      <div class="success-sub">
        No purchase order found with ID <code>${escHtml(id)}</code>.<br>
        It may have been deleted or the link may be incorrect.
      </div>
    </div>
  `;
}

// ─── PO detail block (shared between claim form and success/already-claimed) ──

function renderPoDetails(tracked: TrackedPO): string {
  const po    = tracked.purchaseOrder;
  const email = tracked.email;

  // Header facts
  const headerRows = [
    infoRow("From",     email.sender),
    infoRow("Subject",  email.subject),
    infoRow("Received", email.receivedAt),
    po.poNumber              ? infoRow("PO Number",     po.poNumber)                          : "",
    po.releaseNumber         ? infoRow("Release No.",   po.releaseNumber)                     : "",
    po.orderDate             ? infoRow("Order Date",    po.orderDate)                          : "",
    po.requestedDeliveryDate ? infoRow("Delivery Date", po.requestedDeliveryDate)              : "",
    po.requiredByDate        ? infoRow("Required By",   po.requiredByDate)                    : "",
    po.paymentTerms          ? infoRow("Payment Terms", po.paymentTerms)                       : "",
    po.shipVia               ? infoRow("Ship Via",      po.shipVia)                           : "",
    po.fobTerms              ? infoRow("FOB",           po.fobTerms)                          : "",
    po.isBlanketPo           ? infoRow("Order Type",    "🔄 Blanket / Standing Order")        : "",
    po.currency              ? infoRow("Currency",      po.currency)                           : "",
    po.total        != null  ? infoRow("Total",         fmtCurrency(po.total, po.currency))   : "",
  ].filter(Boolean).join("");

  // Vendor / Bill To / Ship To
  const vendorText = po.vendor
    ? [po.vendor.name, po.vendor.address, po.vendor.contact, po.vendor.email, po.vendor.phone]
        .filter(Boolean).join(" • ")
    : null;

  const billToText = (po.billTo || po.buyer)
    ? [
        po.billTo?.company ?? po.buyer?.company ?? po.buyer?.name,
        po.billTo?.poBox   ? `PO Box: ${po.billTo.poBox}` : null,
        po.billTo?.address ?? po.buyer?.address,
        po.buyer?.email,
        po.buyer?.phone,
      ].filter(Boolean).join(" • ")
    : null;

  const shipToText = (po.shipTo && (po.shipTo.company || po.shipTo.address || po.shipTo.poBox))
    ? [
        po.shipTo.company,
        po.shipTo.poBox ? `PO Box: ${po.shipTo.poBox}` : null,
        po.shipTo.address,
      ].filter(Boolean).join(", ")
    : null;

  // Line items
  const lineItemsHtml = po.lineItems.length > 0
    ? po.lineItems.map((li: POLineItem) => {
        const num   = li.lineNumber != null ? `${li.lineNumber}.` : "—";
        const pn    = li.partNumber ? `PN: ${escHtml(li.partNumber)}` : null;
        const cpn   = li.customerPartNumber ? `Internal PN: ${escHtml(li.customerPartNumber)}` : null;
        const desc  = li.description ? escHtml(li.description) : null;
        const qty   = li.quantity != null
          ? `Qty: ${li.quantity}${li.unitOfMeasure ? ` ${escHtml(li.unitOfMeasure)}` : ""}`
          : null;
        const up    = li.unitPrice  != null ? `${fmtCurrency(li.unitPrice,  po.currency)} ea`    : null;
        const tp    = li.totalPrice != null ? `${fmtCurrency(li.totalPrice, po.currency)} total` : null;
        const price = [up, tp].filter(Boolean).join(" • ");

        return `
          <tr>
            <td style="padding:0.55rem 0.75rem;vertical-align:top;color:var(--ink-muted);font-size:0.8rem;">${escHtml(num)}</td>
            <td style="padding:0.55rem 0.75rem;vertical-align:top;">
              ${pn ? `<div style="font-size:0.78rem;color:var(--ink-muted);">${pn}${cpn ? ` &nbsp;/&nbsp; ${cpn}` : ""}</div>` : ""}
              ${desc ? `<div style="font-size:0.875rem;color:var(--ink);">${desc}</div>` : ""}
              ${qty  ? `<div style="font-size:0.8rem;color:var(--ink-soft);">${qty}</div>` : ""}
            </td>
            <td style="padding:0.55rem 0.75rem;vertical-align:top;text-align:right;font-size:0.85rem;white-space:nowrap;">${escHtml(price)}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="3" style="padding:0.75rem;color:var(--ink-muted);font-size:0.85rem;text-align:center;">No line items extracted</td></tr>`;

  // Totals footer
  const totalsHtml = [
    po.subtotal     != null ? `<tr><td style="padding:0.35rem 0.75rem;color:var(--ink-muted);font-size:0.82rem;">Subtotal</td><td style="padding:0.35rem 0.75rem;text-align:right;font-size:0.82rem;">${fmtCurrency(po.subtotal, po.currency)}</td></tr>` : "",
    po.tax          != null ? `<tr><td style="padding:0.35rem 0.75rem;color:var(--ink-muted);font-size:0.82rem;">Tax</td><td style="padding:0.35rem 0.75rem;text-align:right;font-size:0.82rem;">${fmtCurrency(po.tax, po.currency)}</td></tr>` : "",
    po.shippingCost != null ? `<tr><td style="padding:0.35rem 0.75rem;color:var(--ink-muted);font-size:0.82rem;">Shipping</td><td style="padding:0.35rem 0.75rem;text-align:right;font-size:0.82rem;">${fmtCurrency(po.shippingCost, po.currency)}</td></tr>` : "",
    po.total        != null ? `<tr><td style="padding:0.5rem 0.75rem;font-weight:600;font-size:0.9rem;">Total</td><td style="padding:0.5rem 0.75rem;text-align:right;font-weight:700;font-size:0.95rem;">${fmtCurrency(po.total, po.currency)}</td></tr>` : "",
  ].filter(Boolean).join("");

  return `
    <div class="info-table">${headerRows}</div>

    ${vendorText  ? `<div class="address-block"><span class="address-label">Vendor</span> ${escHtml(vendorText)}</div>`  : ""}
    ${billToText  ? `<div class="address-block"><span class="address-label">Bill To</span> ${escHtml(billToText)}</div>` : ""}
    ${shipToText  ? `<div class="address-block"><span class="address-label">Ship To</span> ${escHtml(shipToText)}</div>` : ""}

    <div class="section-label">Line Items</div>
    <div class="line-items-wrap">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="padding:0.4rem 0.75rem;text-align:left;font-size:0.75rem;color:var(--ink-muted);font-weight:500;">#</th>
            <th style="padding:0.4rem 0.75rem;text-align:left;font-size:0.75rem;color:var(--ink-muted);font-weight:500;">Description</th>
            <th style="padding:0.4rem 0.75rem;text-align:right;font-size:0.75rem;color:var(--ink-muted);font-weight:500;">Price</th>
          </tr>
        </thead>
        <tbody>${lineItemsHtml}</tbody>
        ${totalsHtml ? `<tfoot style="border-top:2px solid var(--border);">${totalsHtml}</tfoot>` : ""}
      </table>
    </div>

    ${po.notes ? `<div class="notes-block"><span class="address-label">Notes</span> ${escHtml(po.notes)}</div>` : ""}
  `;
}

function infoRow(label: string, value: string): string {
  return `
    <div class="info-row">
      <span class="info-label">${escHtml(label)}</span>
      <span class="info-value">${escHtml(value)}</span>
    </div>
  `;
}

// ─── HTML shell ───────────────────────────────────────────────────────────────

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA — Claim Order</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink:          #0D0D14;
      --ink-soft:     #3D3A52;
      --ink-muted:    #7A778F;
      --purple:       #8B5CF6;
      --purple-mid:   #A78BFA;
      --purple-light: #C4B5FD;
      --purple-pale:  #EDE9FE;
      --purple-ghost: #F5F3FF;
      --white:        #FFFFFF;
      --border:       rgba(139,92,246,0.15);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--white);
      color: var(--ink);
      min-height: 100vh;
      padding: 2rem 1.25rem 4rem;
    }

    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 50% at 15% 0%,   rgba(196,181,253,0.2)  0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 85% 10%,  rgba(167,139,250,0.12) 0%, transparent 55%),
        radial-gradient(ellipse 50% 60% at 50% 100%, rgba(237,233,254,0.28) 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }

    .shell { width: 100%; max-width: 680px; margin: 0 auto; position: relative; z-index: 1; }

    /* Logo */
    .logo { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin-bottom: 2.25rem; text-decoration: none; }
    .logo-butterfly { width: 48px; height: 48px; }
    .logo-text { display: flex; flex-direction: column; align-items: center; line-height: 1; gap: 3px; }
    .logo-project { font-family: 'Dancing Script', cursive; font-size: 13px; font-weight: 500; color: var(--purple-mid); letter-spacing: 0.5px; }
    .logo-kaira   { font-family: 'DM Sans', sans-serif; font-size: 15px; font-weight: 600; color: var(--ink); letter-spacing: 4px; text-transform: uppercase; }

    /* Card */
    .card {
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 2rem;
      box-shadow: 0 4px 24px rgba(139,92,246,0.07);
    }
    .card-title { font-size: 1.15rem; font-weight: 600; color: var(--ink); margin-bottom: 0.35rem; }
    .card-sub   { font-size: 0.875rem; color: var(--ink-muted); margin-bottom: 1.5rem; line-height: 1.65; }

    /* Form */
    label { display: block; font-size: 0.8rem; font-weight: 500; color: var(--ink-soft); margin-bottom: 0.35rem; letter-spacing: 0.02em; }
    .field { margin-bottom: 1rem; }
    input[type="text"] {
      width: 100%; background: var(--white);
      border: 1px solid rgba(139,92,246,0.22); border-radius: 10px;
      padding: 0.7rem 1rem; color: var(--ink); font-size: 0.9rem;
      font-family: 'DM Sans', sans-serif; outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input::placeholder { color: var(--ink-muted); }
    input:focus { border-color: var(--purple); box-shadow: 0 0 0 3px rgba(139,92,246,0.1); }

    /* Buttons */
    .btn {
      display: block; width: 100%; padding: 0.8rem 1.25rem;
      border-radius: 100px; border: none;
      font-size: 0.9rem; font-weight: 500; font-family: 'DM Sans', sans-serif;
      cursor: pointer; text-align: center; letter-spacing: 0.3px; transition: all 0.25s;
      margin-top: 1rem;
    }
    .btn-claim { background: var(--ink); color: var(--white); }
    .btn-claim:hover { background: var(--purple); box-shadow: 0 8px 28px rgba(139,92,246,0.3); transform: translateY(-1px); }

    /* Error */
    .error-msg { background: #FFF1F2; border: 1px solid #FECDD3; color: #BE123C; border-radius: 10px; padding: 0.65rem 1rem; font-size: 0.85rem; margin-bottom: 1rem; }

    /* Success / warn icons */
    .success-icon, .warn-icon { text-align: center; font-size: 3rem; margin-bottom: 1.25rem; }
    .success-title { font-size: 1.4rem; font-weight: 700; color: var(--ink); text-align: center; margin-bottom: 0.5rem; }
    .success-sub   { font-size: 0.875rem; color: var(--ink-muted); text-align: center; line-height: 1.7; }

    /* Info table (header facts) */
    .info-table { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 1rem; }
    .info-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.85rem; gap: 1rem; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: var(--ink-muted); flex-shrink: 0; }
    .info-value { color: var(--ink); font-weight: 500; text-align: right; word-break: break-word; }

    /* Address / vendor blocks */
    .address-block {
      background: var(--purple-ghost); border: 1px solid var(--border); border-radius: 10px;
      padding: 0.65rem 1rem; font-size: 0.85rem; color: var(--ink-soft); margin-bottom: 0.75rem;
      line-height: 1.55;
    }
    .address-label { font-weight: 600; color: var(--ink); margin-right: 0.5rem; }

    /* Section label */
    .section-label { font-size: 0.75rem; font-weight: 600; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.07em; margin: 1.25rem 0 0.5rem; }

    /* Line items table */
    .line-items-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .line-items-wrap table tbody tr:nth-child(even) { background: var(--purple-ghost); }

    /* Notes */
    .notes-block {
      background: #FEFCE8; border: 1px solid #FEF08A; border-radius: 10px;
      padding: 0.65rem 1rem; font-size: 0.85rem; color: var(--ink-soft); margin-top: 0.75rem;
    }

    code { font-family: monospace; font-size: 0.85em; background: var(--purple-ghost); padding: 0.1em 0.35em; border-radius: 4px; }

    /* Save notice */
    .save-notice {
      margin-top: 1.25rem; background: var(--purple-ghost); border: 1px solid rgba(139,92,246,0.2);
      border-radius: 12px; padding: 0.9rem 1rem; font-size: 0.84rem; color: var(--ink-soft);
      line-height: 1.55;
    }
    .btn-print {
      display: block; width: 100%; margin-top: 0.75rem; padding: 0.6rem 1rem;
      border-radius: 100px; border: 1px solid rgba(139,92,246,0.3);
      background: var(--white); color: var(--purple); font-size: 0.85rem;
      font-family: 'DM Sans', sans-serif; font-weight: 500; cursor: pointer;
      transition: all 0.2s;
    }
    .btn-print:hover { background: var(--purple-pale); border-color: var(--purple); }

    @media print {
      body::after, .logo, .save-notice { display: none !important; }
      .card { box-shadow: none; border: 1px solid #ddd; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <a class="logo" href="/">
      <svg class="logo-butterfly" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 55 C40 40, 15 30, 10 15 C8 8, 18 5, 25 12 C32 19, 42 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C60 40, 85 30, 90 15 C92 8, 82 5, 75 12 C68 19, 58 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C38 65, 12 72, 8 88 C6 95, 18 97, 26 88 C34 79, 44 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C62 65, 88 72, 92 88 C94 95, 82 97, 74 88 C66 79, 56 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <circle cx="50" cy="55" r="3" fill="#8B5CF6" opacity="0.6"/>
        <line x1="50" y1="58" x2="50" y2="78" stroke="#8B5CF6" stroke-width="1.5" opacity="0.4" stroke-linecap="round"/>
      </svg>
      <div class="logo-text">
        <span class="logo-project">Project</span>
        <span class="logo-kaira">Kaira</span>
      </div>
    </a>
    ${body}
  </div>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function fmtCurrency(amount: number, currency: string | null): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
}
