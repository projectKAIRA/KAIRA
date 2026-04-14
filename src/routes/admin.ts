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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --purple:      #8B5CF6;
      --purple-mid:  #A78BFA;
      --purple-dim:  rgba(139,92,246,0.15);
      --ink:         #0D0D14;
      --surface:     #13111C;
      --surface-2:   #1A1726;
      --border:      rgba(139,92,246,0.12);
      --text:        #E2DFF0;
      --text-muted:  #6B6884;
    }
    body {
      font-family: 'DM Sans', Arial, sans-serif;
      background: var(--ink);
      color: var(--text);
      font-size: 13px;
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    }

    /* ── Top bar ── */
    .topbar {
      position: relative; z-index: 1;
      height: 4px;
      background: linear-gradient(90deg, var(--purple), var(--purple-mid));
    }
    .nav {
      position: relative; z-index: 1;
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 32px;
      border-bottom: 1px solid var(--border);
      background: rgba(13,13,20,0.85);
      backdrop-filter: blur(20px);
    }
    .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .nav-logo svg { width: 32px; height: 32px; }
    .nav-logo-text { display: flex; flex-direction: column; }
    .nav-logo-project { font-family: 'Dancing Script', cursive; font-size: 10px; color: var(--purple-mid); line-height: 1; }
    .nav-logo-kaira   { font-size: 12px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #fff; line-height: 1; margin-top: 2px; }
    .nav-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
      background: var(--purple-dim); color: var(--purple-mid);
      padding: 3px 10px; border-radius: 100px; border: 1px solid var(--purple-dim);
    }

    /* ── Page wrap ── */
    .wrap { position: relative; z-index: 1; padding: 32px; }

    /* ── Header ── */
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 28px; flex-wrap: wrap; gap: 20px;
    }
    .title { font-size: 1.4rem; font-weight: 700; color: #fff; }
    .subtitle { color: var(--text-muted); margin-top: 4px; font-size: 0.8rem; }

    /* ── Stats ── */
    .stats { display: flex; gap: 12px; }
    .stat {
      text-align: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 20px;
      min-width: 80px;
    }
    .stat-val { display: block; font-size: 1.6rem; font-weight: 700; color: #fff; line-height: 1; }
    .stat-lbl { display: block; font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }

    /* ── Table card ── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { background: var(--surface-2); }
    th {
      text-align: left;
      padding: 12px 16px;
      font-size: 0.68rem;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(139,92,246,0.04); }

    .name { font-weight: 600; color: #fff; font-size: 13px; }
    .tenant-id { font-size: 10px; color: #2e2b40; font-family: monospace; margin-top: 2px; }
    .muted { color: var(--text-muted); }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-green  { background: rgba(74,222,128,0.1);  color: #4ade80; }
    .badge-orange { background: rgba(251,146,60,0.1);  color: #fb923c; }
    .badge-red    { background: rgba(248,113,113,0.1); color: #f87171; }
    .badge-blue   { background: rgba(96,165,250,0.1);  color: #60a5fa; }
    .badge-gray   { background: rgba(255,255,255,0.05); color: #555; }
    .badge-purple { background: rgba(139,92,246,0.15); color: var(--purple-mid); }

    /* ── Provider pills ── */
    .provider {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 600;
    }
    .provider.slack  { background: rgba(167,139,250,0.12); color: #a78bfa; }
    .provider.teams  { background: rgba(96,165,250,0.12);  color: #60a5fa; }
    .provider.ms     { background: rgba(56,189,248,0.12);  color: #38bdf8; }
    .provider.imap   { background: rgba(52,211,153,0.12);  color: #34d399; }

    /* ── Doc usage bar ── */
    .doc-count { min-width: 110px; }
    .text-green  { color: #4ade80; font-weight: 600; font-size: 12px; }
    .text-orange { color: #fb923c; font-weight: 600; font-size: 12px; }
    .text-red    { color: #f87171; font-weight: 600; font-size: 12px; }
    .bar-track { height: 3px; background: rgba(255,255,255,0.06); border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .bar-fill  { height: 100%; border-radius: 2px; transition: width 0.3s; }
    .bar-green  { background: #4ade80; }
    .bar-orange { background: #fb923c; }
    .bar-red    { background: #f87171; }

    .empty { text-align: center; color: var(--text-muted); padding: 48px 16px; }
    .empty a { color: var(--purple-mid); text-decoration: none; }
    .empty a:hover { text-decoration: underline; }

    /* ── Error ── */
    .error-box {
      background: rgba(248,113,113,0.08);
      border: 1px solid rgba(248,113,113,0.25);
      color: #f87171;
      border-radius: 12px;
      padding: 16px 20px;
      max-width: 480px;
      margin: 64px auto;
      font-size: 14px;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 24px;
      color: #2a2736;
      font-size: 12px;
      text-align: center;
    }
    .footer a { color: #3d3956; text-decoration: none; }
    .footer a:hover { color: var(--purple-mid); }

    a { color: var(--purple-mid); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="topbar"></div>
  <nav class="nav">
    <a class="nav-logo" href="/">
      <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M50 55 C40 40, 15 30, 10 15 C8 8, 18 5, 25 12 C32 19, 42 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C60 40, 85 30, 90 15 C92 8, 82 5, 75 12 C68 19, 58 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C38 65, 12 72, 8 88 C6 95, 18 97, 26 88 C34 79, 44 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <path d="M50 55 C62 65, 88 72, 92 88 C94 95, 82 97, 74 88 C66 79, 56 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <circle cx="50" cy="55" r="3" fill="#8B5CF6" opacity="0.6"/>
        <line x1="50" y1="58" x2="50" y2="78" stroke="#8B5CF6" stroke-width="1.5" opacity="0.4" stroke-linecap="round"/>
      </svg>
      <div class="nav-logo-text">
        <span class="nav-logo-project">Project</span>
        <span class="nav-logo-kaira">Kaira</span>
      </div>
    </a>
    <span class="nav-badge">Admin</span>
  </nav>
  <div class="wrap">
    ${body}
  </div>
</body>
</html>`;
}
