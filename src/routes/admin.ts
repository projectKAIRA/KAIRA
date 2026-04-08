/**
 * Admin dashboard — GET /admin
 *
 * Password-protected via HTTP Basic Auth (ADMIN_PASSWORD env var).
 * Shows all tenants with plan tier, trial status, monthly doc usage, and
 * active/paused state in a clean HTML table.
 */

import { Router, Request, Response } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantConfig, TRIAL_DOC_LIMIT } from "../types/tenant.js";
import { config } from "../config/index.js";

export function createAdminRouter(): Router {
  const router   = Router();
  const registry = new TenantRegistry();

  router.get("/", async (req: Request, res: Response) => {
    // ── Basic Auth ──────────────────────────────────────────────────────────
    const adminPassword = config.admin.password;

    if (!adminPassword) {
      res.status(503).send(renderError("ADMIN_PASSWORD is not set in the environment."));
      return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const [scheme, encoded] = authHeader.split(" ");

    if (scheme?.toLowerCase() !== "basic" || !encoded) {
      res.setHeader("WWW-Authenticate", 'Basic realm="KAIRA Admin"');
      res.status(401).send(renderError("Authentication required."));
      return;
    }

    const decoded  = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.split(":").slice(1).join(":");   // everything after first ":"

    if (password !== adminPassword) {
      res.setHeader("WWW-Authenticate", 'Basic realm="KAIRA Admin"');
      res.status(401).send(renderError("Incorrect password."));
      return;
    }

    // ── Data ────────────────────────────────────────────────────────────────
    const tenants = await registry.findAll();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard(tenants));
  });

  return router;
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function renderDashboard(tenants: TenantConfig[]): string {
  const now        = new Date();
  const totalActive = tenants.filter((t) => t.isActive).length;
  const totalTrial  = tenants.filter((t) => t.planTier === "trial").length;

  const rows = tenants
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    .map((t) => renderRow(t, now))
    .join("\n");

  const emptyRow = tenants.length === 0
    ? `<tr><td colspan="8" class="empty">No tenants yet. <a href="/onboarding">Add the first one →</a></td></tr>`
    : "";

  return page(`
    <div class="header">
      <div>
        <div class="title">KAIRA Admin</div>
        <div class="subtitle">Tenant overview &mdash; ${now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</div>
      </div>
      <div class="stats">
        <div class="stat"><span class="stat-val">${tenants.length}</span><span class="stat-lbl">Total</span></div>
        <div class="stat"><span class="stat-val">${totalActive}</span><span class="stat-lbl">Active</span></div>
        <div class="stat"><span class="stat-val">${totalTrial}</span><span class="stat-lbl">Trial</span></div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Plan</th>
            <th>Trial</th>
            <th>Docs&nbsp;this&nbsp;month</th>
            <th>Notifications</th>
            <th>Email&nbsp;provider</th>
            <th>Created</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${emptyRow}
        </tbody>
      </table>
    </div>

    <p class="footer">KAIRA &bull; <a href="/health">health</a> &bull; <a href="/status">api status</a></p>
  `);
}

function renderRow(t: TenantConfig, now: Date): string {
  // Plan badge
  const tierBadge = badge(t.planTier, tierColor(t.planTier));

  // Trial column
  let trialCell: string;
  if (t.planTier !== "trial" || !t.isTrialActive && !t.trialEndDate) {
    trialCell = `<span class="muted">—</span>`;
  } else if (!t.isTrialActive) {
    trialCell = badge("Expired", "red");
  } else if (t.trialLimitReached) {
    trialCell = badge("Limit reached", "red");
  } else if (t.trialEndDate) {
    const daysLeft = Math.ceil((t.trialEndDate.getTime() - now.getTime()) / 86_400_000);
    const color    = daysLeft <= 3 ? "orange" : "green";
    trialCell      = badge(`${daysLeft}d left`, color);
  } else {
    trialCell = badge("Active", "green");
  }

  // Docs this month
  let docsCell: string;
  if (t.planTier === "trial") {
    const pct  = Math.min(100, Math.round((t.monthlyDocCount / TRIAL_DOC_LIMIT) * 100));
    const color = pct >= 100 ? "red" : pct >= 75 ? "orange" : "green";
    docsCell = `
      <div class="doc-count">
        <span class="${color === "red" ? "text-red" : color === "orange" ? "text-orange" : "text-green"}">${t.monthlyDocCount} / ${TRIAL_DOC_LIMIT}</span>
        <div class="bar-track"><div class="bar-fill bar-${color}" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    docsCell = `<span>${t.monthlyDocCount}</span>`;
  }

  // Status badge
  let statusCell: string;
  if (!t.isActive) {
    statusCell = badge("Paused", "gray");
  } else if (t.trialLimitReached) {
    statusCell = badge("Limit reached", "red");
  } else {
    statusCell = badge("Active", "green");
  }

  // Notification provider
  const notifCell = t.notification.provider === "slack"
    ? `<span class="provider slack">Slack</span>`
    : `<span class="provider teams">Teams</span>`;

  // Email provider
  const emailCell = t.providerType === "imap"
    ? `<span class="provider imap">IMAP</span>`
    : `<span class="provider ms">M365</span>`;

  // Created date
  const createdCell = t.createdAt
    ? t.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";

  return `
    <tr>
      <td class="name">${esc(t.name)}<br><span class="tenant-id">${esc(t.id)}</span></td>
      <td>${tierBadge}</td>
      <td>${trialCell}</td>
      <td>${docsCell}</td>
      <td>${notifCell}</td>
      <td>${emailCell}</td>
      <td class="muted">${createdCell}</td>
      <td>${statusCell}</td>
    </tr>`;
}

function badge(text: string, color: "green" | "orange" | "red" | "blue" | "gray" | "purple"): string {
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}

function tierColor(tier: string): "green" | "orange" | "red" | "blue" | "gray" | "purple" {
  switch (tier) {
    case "trial":      return "blue";
    case "starter":    return "green";
    case "growth":     return "purple";
    case "enterprise": return "orange";
    default:           return "gray";
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderError(msg: string): string {
  return page(`<div class="error-box">${esc(msg)}</div>`);
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #0d0d0d;
      color: #d4d4d4;
      font-size: 13px;
      padding: 2rem;
    }
    a { color: #6b9eff; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1.5rem;
    }
    .title {
      font-size: 1.3rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: 0.05em;
    }
    .subtitle { color: #555; margin-top: 0.2rem; font-size: 0.8rem; }

    .stats { display: flex; gap: 1.5rem; }
    .stat {
      text-align: center;
      background: #161616;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 0.6rem 1.2rem;
    }
    .stat-val { display: block; font-size: 1.4rem; font-weight: 700; color: #fff; }
    .stat-lbl { display: block; font-size: 0.72rem; color: #555; text-transform: uppercase; letter-spacing: 0.06em; }

    .card {
      background: #111;
      border: 1px solid #222;
      border-radius: 10px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { background: #161616; }
    th {
      text-align: left;
      padding: 0.65rem 1rem;
      font-size: 0.72rem;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      white-space: nowrap;
      border-bottom: 1px solid #222;
    }
    td {
      padding: 0.7rem 1rem;
      border-bottom: 1px solid #1a1a1a;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #141414; }

    .name { font-weight: 500; color: #e8e8e8; }
    .tenant-id { font-size: 0.7rem; color: #3a3a3a; font-family: monospace; }
    .muted { color: #444; }

    .badge {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }
    .badge-green  { background: #0d2b12; color: #4ade80; }
    .badge-orange { background: #2b1a08; color: #fb923c; }
    .badge-red    { background: #2a0e0e; color: #f87171; }
    .badge-blue   { background: #0a1a3a; color: #60a5fa; }
    .badge-gray   { background: #1a1a1a; color: #555; }
    .badge-purple { background: #1a0a2e; color: #c084fc; }

    .provider {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
    }
    .provider.slack  { background: #1a0a1e; color: #a78bfa; }
    .provider.teams  { background: #0a0f2e; color: #60a5fa; }
    .provider.ms     { background: #0a1a3a; color: #38bdf8; }
    .provider.imap   { background: #0d2010; color: #34d399; }

    .doc-count { min-width: 120px; }
    .text-green  { color: #4ade80; }
    .text-orange { color: #fb923c; }
    .text-red    { color: #f87171; }

    .bar-track {
      height: 4px;
      background: #222;
      border-radius: 2px;
      margin-top: 5px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }
    .bar-green  { background: #4ade80; }
    .bar-orange { background: #fb923c; }
    .bar-red    { background: #f87171; }

    .empty { text-align: center; color: #444; padding: 3rem 1rem; }

    .error-box {
      background: #2a0e0e;
      border: 1px solid #5c1a1a;
      color: #f87171;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      max-width: 480px;
      margin: 4rem auto;
    }

    .footer {
      margin-top: 1.25rem;
      color: #333;
      font-size: 0.78rem;
      text-align: center;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
