/**
 * Admin dashboard — GET /admin
 *
 * Password-protected via HTTP Basic Auth (ADMIN_PASSWORD env var).
 * Shows all tenants with plan tier, trial status, monthly doc usage, and
 * active/paused state in a clean HTML table.
 */

import express, { Router, Request, Response } from "express";
import Stripe from "stripe";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { TenantConfig, PLAN_DOC_LIMITS, PlanTier } from "../types/tenant.js";
import { getStripe } from "../services/billing/StripeService.js";
import { config } from "../config/index.js";

export function createAdminRouter(scheduler: TenantScheduler): Router {
  const router   = Router();
  router.use(express.urlencoded({ extended: false }));
  const registry = new TenantRegistry();

  router.get("/", async (req: Request, res: Response) => {
    if (!await checkAuth(req, res)) return;
    const [tenants, blocks] = await Promise.all([
      registry.findAll(),
      registry.getSignupBlocks(50),
    ]);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard(tenants, blocks));
  });

  // ─── GET /admin/tenant/:id — per-tenant detail view ───────────────────────

  router.get("/tenant/:id", async (req: Request, res: Response) => {
    if (!await checkAuth(req, res)) return;

    const tenant = await registry.findById(req.params["id"] as string ?? "");
    if (!tenant) { res.status(404).send(renderError("Tenant not found.")); return; }

    const cancelled = (req.query["cancelled"] as string | undefined) === "1";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderTenantDetail(tenant, cancelled));
  });

  // ─── POST /admin/tenant/:id/cancel — force cancel ─────────────────────────

  router.post("/tenant/:id/cancel", async (req: Request, res: Response) => {
    if (!await checkAuth(req, res)) return;

    const id     = req.params["id"] as string;
    const tenant = await registry.findById(id);
    if (!tenant) { res.status(404).send(renderError("Tenant not found.")); return; }

    // 1. Cancel Stripe subscription if one exists
    if (tenant.stripeSubscriptionId && config.stripe.secretKey) {
      try {
        await getStripe().subscriptions.cancel(tenant.stripeSubscriptionId);
        console.log(`[Admin] Cancelled Stripe subscription ${tenant.stripeSubscriptionId} for tenant "${tenant.name}"`);
      } catch (err) {
        console.error(`[Admin] Failed to cancel Stripe subscription for "${tenant.name}":`, err);
      }
    }

    // 2. Deactivate tenant in DB
    await registry.update(id, {
      isActive:      false,
      isTrialActive: false,
      planTier:      "none",
    });

    // 3. Remove from live scheduler
    if (scheduler.getRuntime(id)) {
      scheduler.removeTenant(id);
    }

    console.log(`[Admin] Force-cancelled tenant "${tenant.name}" (${id})`);
    res.redirect(`/admin/tenant/${id}?cancelled=1`);
  });

  return router;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function checkAuth(req: Request, res: Response): Promise<boolean> {
  const adminPassword = config.admin.password;
  if (!adminPassword) {
    res.status(503).send(renderError("ADMIN_PASSWORD is not set in the environment."));
    return false;
  }
  const authHeader = (Array.isArray(req.headers["authorization"]) ? req.headers["authorization"][0] : req.headers["authorization"]) ?? "";
  const [scheme, encoded] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="KAIRA Admin"');
    res.status(401).send(renderError("Authentication required."));
    return false;
  }
  const password = Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":");
  if (password !== adminPassword) {
    res.setHeader("WWW-Authenticate", 'Basic realm="KAIRA Admin"');
    res.status(401).send(renderError("Incorrect password."));
    return false;
  }
  return true;
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

type SignupBlockRow = Awaited<ReturnType<TenantRegistry["getSignupBlocks"]>>[number];

function renderDashboard(tenants: TenantConfig[], blocks: SignupBlockRow[]): string {
  const now         = new Date();
  const totalActive = tenants.filter((t) => t.isActive).length;
  const totalTrial  = tenants.filter((t) => t.isTrialActive).length;

  const rows = tenants
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
    .map((t) => renderRow(t, now))
    .join("\n");

  const emptyRow = tenants.length === 0
    ? `<tr><td colspan="8" class="empty">No tenants yet. <a href="/onboarding">Add the first one →</a></td></tr>`
    : "";

  // ── Blocked signups table ──────────────────────────────────────────────────
  const blockRows = blocks.map((b) => `
    <tr>
      <td class="name">${esc(b.companyName)}</td>
      <td>${esc(b.email || "—")}</td>
      <td><span class="badge ${b.reason === "email_match" ? "badge-orange" : "badge-red"}">${b.reason === "email_match" ? "Email" : "Company name"}</span></td>
      <td class="muted">${esc(b.matchedTenantName ?? "—")}</td>
      <td class="muted">${b.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
    </tr>
  `).join("");

  const blocksSection = `
    <div style="margin-top:32px;">
      <div class="header" style="margin-bottom:16px;">
        <div>
          <div class="title" style="font-size:1.1rem;">Blocked Signup Attempts</div>
          <div class="subtitle">Duplicate company name or email detected — signup was prevented.</div>
        </div>
        <div class="stats">
          <div class="stat"><span class="stat-val">${blocks.length}</span><span class="stat-lbl">Blocked</span></div>
        </div>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Company name tried</th>
              <th>Email tried</th>
              <th>Reason</th>
              <th>Matched tenant</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            ${blocks.length === 0
              ? `<tr><td colspan="5" class="empty">No blocked attempts yet.</td></tr>`
              : blockRows}
          </tbody>
        </table>
      </div>
    </div>
  `;

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
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${emptyRow}
        </tbody>
      </table>
    </div>

    ${blocksSection}

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
  const docLimit = PLAN_DOC_LIMITS[t.planTier as PlanTier] ?? null;
  if (docLimit !== null) {
    const pct   = Math.min(100, Math.round((t.monthlyDocCount / docLimit) * 100));
    const color = pct >= 100 ? "red" : pct >= 75 ? "orange" : "green";
    docsCell = `
      <div class="doc-count">
        <span class="${color === "red" ? "text-red" : color === "orange" ? "text-orange" : "text-green"}">${t.monthlyDocCount} / ${docLimit}</span>
        <div class="bar-track"><div class="bar-fill bar-${color}" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    docsCell = `<span>${t.monthlyDocCount} / ∞</span>`;
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
      <td class="name">
        <a href="/admin/tenant/${esc(t.id)}" style="color:inherit;text-decoration:none;">
          ${esc(t.name)}
        </a>
        <br><span class="tenant-id">${esc(t.id)}</span>
      </td>
      <td>${tierBadge}</td>
      <td>${trialCell}</td>
      <td>${docsCell}</td>
      <td>${notifCell}</td>
      <td>${emailCell}</td>
      <td class="muted">${createdCell}</td>
      <td>${statusCell}</td>
      <td><a href="/admin/tenant/${esc(t.id)}" style="font-size:11px;color:var(--purple-mid);text-decoration:none;white-space:nowrap;">View →</a></td>
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

function renderTenantDetail(t: TenantConfig, cancelled: boolean): string {
  const now = new Date();

  const planLabel   = t.planTier === "none" ? "No Plan" : t.planTier.charAt(0).toUpperCase() + t.planTier.slice(1);
  const statusBadge = t.isActive
    ? `<span class="badge badge-green">● Active</span>`
    : `<span class="badge badge-gray">● Paused</span>`;

  let trialInfo = "—";
  if (t.isTrialActive && t.trialEndDate) {
    const days = Math.max(0, Math.ceil((new Date(t.trialEndDate).getTime() - now.getTime()) / 86_400_000));
    trialInfo = `${days}d remaining`;
  } else if (t.trialLimitReached) {
    trialInfo = "Limit reached";
  } else if (!t.isTrialActive && t.trialEndDate) {
    trialInfo = "Expired";
  }

  const monitoredEmail  = t.providerType === "microsoft" ? (t.graph?.userEmail ?? "—") : (t.imap?.username ?? "—");
  const providerLabel   = t.providerType === "microsoft" ? "Microsoft 365" : "IMAP";
  const inboxFolder     = t.providerType === "microsoft" ? (t.graph?.inboxFolder ?? "—") : (t.imap?.inboxFolder ?? "—");
  const pollSeconds     = t.providerType === "microsoft" ? t.graph?.pollIntervalSeconds : t.imap?.pollIntervalSeconds;

  const slackConnected  = !!(t.slack?.botToken);
  const teamsConnected  = !!(t.teams?.webhookUrl);
  const activeProvider  = t.notification?.provider ?? "—";

  const slackStatus = slackConnected
    ? (activeProvider === "slack" ? `<span class="badge badge-green">● Active</span>` : `<span class="badge badge-gray">Connected</span>`)
    : `<span class="badge badge-gray">Not connected</span>`;
  const teamsStatus = teamsConnected
    ? (activeProvider === "teams" ? `<span class="badge badge-green">● Active</span>` : `<span class="badge badge-gray">Connected</span>`)
    : `<span class="badge badge-gray">Not connected</span>`;

  const flash = cancelled
    ? `<div class="flash-ok">✓ Tenant cancelled and deactivated successfully.</div>`
    : "";

  const cancelForm = t.isActive ? `
    <div class="danger-zone">
      <div class="danger-title">Danger Zone</div>
      <p class="danger-desc">Force-cancelling will immediately deactivate this tenant, stop all email processing, and cancel their Stripe subscription. This cannot be undone.</p>
      <form method="POST" action="/admin/tenant/${esc(t.id)}/cancel" onsubmit="return confirm('Are you sure you want to force-cancel ${esc(t.name)}? This will immediately stop their service and cancel their Stripe subscription.')">
        <button type="submit" class="btn-cancel">Force Cancel Subscription &amp; Deactivate</button>
      </form>
    </div>` : `
    <div class="danger-zone">
      <div class="danger-title">Danger Zone</div>
      <p class="danger-desc">This tenant is already deactivated.</p>
    </div>`;

  return page(`
    <div class="header">
      <div>
        <a href="/admin" style="font-size:12px;color:var(--text-muted);text-decoration:none;">← All tenants</a>
        <div class="title" style="margin-top:8px;">${esc(t.name)}</div>
        <div class="subtitle">${esc(t.id)}</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        ${statusBadge}
        <span class="badge badge-${tierColor(t.planTier)}">${esc(planLabel)}</span>
      </div>
    </div>

    ${flash}

    <div class="detail-grid">

      <div class="detail-card">
        <div class="detail-card-title">Subscription</div>
        <div class="info-row"><span class="info-label">Plan</span><span class="info-value">${esc(planLabel)}</span></div>
        <div class="info-row"><span class="info-label">Trial</span><span class="info-value">${esc(trialInfo)}</span></div>
        <div class="info-row"><span class="info-label">Docs this month</span><span class="info-value">${t.monthlyDocCount}</span></div>
        <div class="info-row"><span class="info-label">Stripe Customer</span><span class="info-value mono">${t.stripeCustomerId ?? "—"}</span></div>
        <div class="info-row"><span class="info-label">Stripe Subscription</span><span class="info-value mono">${t.stripeSubscriptionId ?? "—"}</span></div>
        <div class="info-row"><span class="info-label">Contact email</span><span class="info-value">${esc(t.contactEmail || "—")}</span></div>
      </div>

      <div class="detail-card">
        <div class="detail-card-title">Monitoring</div>
        <div class="info-row"><span class="info-label">Status</span><span class="info-value">${statusBadge}</span></div>
        <div class="info-row"><span class="info-label">Provider</span><span class="info-value">${esc(providerLabel)}</span></div>
        <div class="info-row"><span class="info-label">Inbox</span><span class="info-value">${esc(monitoredEmail)}</span></div>
        <div class="info-row"><span class="info-label">Folder</span><span class="info-value">${esc(inboxFolder)}</span></div>
        <div class="info-row"><span class="info-label">Poll interval</span><span class="info-value">${pollSeconds ?? "—"}s</span></div>
        <div class="info-row"><span class="info-label">Created</span><span class="info-value">${t.createdAt?.toLocaleDateString("en-US", { dateStyle: "medium" }) ?? "—"}</span></div>
      </div>

      <div class="detail-card">
        <div class="detail-card-title">Notification Channels</div>
        <div class="info-row">
          <span class="info-label">Slack</span>
          <span class="info-value" style="display:flex;gap:8px;align-items:center;">${slackStatus}</span>
        </div>
        ${slackConnected ? `<div class="info-row"><span class="info-label">Bot token</span><span class="info-value mono">${t.slack?.botToken ? t.slack.botToken.slice(0, 12) + "••••••" : "—"}</span></div>` : ""}
        <div class="info-row" style="margin-top:8px;">
          <span class="info-label">Microsoft Teams</span>
          <span class="info-value" style="display:flex;gap:8px;align-items:center;">${teamsStatus}</span>
        </div>
        ${teamsConnected ? `<div class="info-row"><span class="info-label">Webhook</span><span class="info-value mono" style="font-size:10px;word-break:break-all;">${t.teams?.webhookUrl ? t.teams.webhookUrl.slice(0, 40) + "…" : "—"}</span></div>` : ""}
        <div class="info-row" style="margin-top:8px;"><span class="info-label">Active channel</span><span class="info-value">${esc(activeProvider)}</span></div>
      </div>

      <div class="detail-card">
        <div class="detail-card-title">Customer Dashboard</div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">Open the dashboard exactly as this customer sees it.</p>
        <a href="/dashboard?t=${esc(t.id)}" target="_blank" rel="noopener"
           style="display:inline-block;background:var(--purple);color:#fff;font-size:13px;font-weight:600;padding:10px 20px;border-radius:100px;text-decoration:none;">
          Open customer dashboard →
        </a>
      </div>

    </div>

    ${cancelForm}

    <p class="footer" style="margin-top:32px;"><a href="/admin">← Back to all tenants</a></p>
  `, `
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    @media (max-width: 700px) { .detail-grid { grid-template-columns: 1fr; } }
    .detail-card { background: var(--white); border: 1px solid var(--border); border-radius: 16px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    .detail-card-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); margin-bottom: 14px; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-size: 12px; color: var(--ink-muted); }
    .info-value { font-size: 12px; font-weight: 500; color: var(--ink); text-align: right; }
    .mono { font-family: monospace; font-size: 11px; }
    .flash-ok { background: #DCFCE7; border: 1px solid #BBF7D0; color: #15803D; border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 20px; }
    .danger-zone { border: 1px solid #FECACA; border-radius: 16px; padding: 20px; background: #FFF5F5; }
    .danger-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #B91C1C; margin-bottom: 10px; }
    .danger-desc { font-size: 13px; color: var(--ink-muted); margin-bottom: 16px; line-height: 1.6; }
    .btn-cancel { background: #EF4444; color: #fff; border: none; padding: 10px 20px; border-radius: 100px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: 'DM Sans', sans-serif; }
    .btn-cancel:hover { background: #DC2626; }
  `);
}

function renderError(msg: string): string {
  return page(`<div class="error-box">${esc(msg)}</div>`);
}

function page(body: string, extraCss = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --purple:        #8B5CF6;
      --purple-mid:    #A78BFA;
      --purple-light:  #C4B5FD;
      --purple-pale:   #EDE9FE;
      --purple-ghost:  #F5F3FF;
      --ink:           #0D0D14;
      --ink-soft:      #3D3A52;
      --ink-muted:     #7A778F;
      --white:         #FFFFFF;
      --bg:            #F8F7FC;
      --border:        rgba(13,13,20,0.08);
      --border-purple: rgba(139,92,246,0.15);
    }
    body {
      font-family: 'DM Sans', Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      font-size: 13px;
      min-height: 100vh;
    }
    body::before {
      content: "";
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
      opacity: 0.4;
    }

    /* ── Top bar ── */
    .topbar {
      position: relative; z-index: 1;
      height: 4px;
      background: linear-gradient(90deg, var(--purple), var(--purple-mid));
    }

    /* ── Nav ── */
    .nav {
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 32px;
      height: 60px;
      border-bottom: 1px solid var(--border-purple);
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(24px);
    }
    .nav-logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .nav-logo svg { width: 32px; height: 32px; }
    .nav-logo-text { display: flex; flex-direction: column; gap: 2px; line-height: 1; }
    .nav-logo-project { font-family: 'Dancing Script', cursive; font-size: 11px; color: var(--purple-mid); }
    .nav-logo-kaira   { font-size: 13px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: var(--ink); }
    .nav-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
      background: var(--purple-pale); color: var(--purple);
      padding: 3px 12px; border-radius: 100px; border: 1px solid var(--border-purple);
    }

    /* ── Page wrap ── */
    .wrap { position: relative; z-index: 1; padding: 32px; max-width: 1200px; margin: 0 auto; }

    /* ── Header ── */
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 28px; flex-wrap: wrap; gap: 20px;
    }
    .title   { font-size: 1.4rem; font-weight: 700; color: var(--ink); }
    .subtitle { color: var(--ink-muted); margin-top: 4px; font-size: 0.8rem; }

    /* ── Stats ── */
    .stats { display: flex; gap: 12px; }
    .stat {
      text-align: center;
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 20px;
      min-width: 80px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.04);
    }
    .stat-val { display: block; font-size: 1.6rem; font-weight: 700; color: var(--ink); line-height: 1; }
    .stat-lbl { display: block; font-size: 0.68rem; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }

    /* ── Table card ── */
    .card {
      background: var(--white);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(0,0,0,0.04);
    }
    table { width: 100%; border-collapse: collapse; }
    thead { background: var(--purple-ghost); }
    th {
      text-align: left;
      padding: 12px 16px;
      font-size: 0.68rem;
      font-weight: 700;
      color: var(--ink-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
      border-bottom: 1px solid var(--border-purple);
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
      color: var(--ink);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--purple-ghost); }

    .name { font-weight: 600; color: var(--ink); font-size: 13px; }
    .tenant-id { font-size: 10px; color: var(--ink-muted); font-family: monospace; margin-top: 2px; }
    .muted { color: var(--ink-muted); }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-green  { background: #DCFCE7; color: #15803D; }
    .badge-orange { background: #FEF3C7; color: #B45309; }
    .badge-red    { background: #FEE2E2; color: #B91C1C; }
    .badge-blue   { background: #DBEAFE; color: #1D4ED8; }
    .badge-gray   { background: #F3F4F6; color: #6B7280; }
    .badge-purple { background: var(--purple-pale); color: var(--purple); }

    /* ── Provider pills ── */
    .provider {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 100px;
      font-size: 11px;
      font-weight: 600;
    }
    .provider.slack  { background: var(--purple-pale);  color: var(--purple); }
    .provider.teams  { background: #DBEAFE; color: #1D4ED8; }
    .provider.ms     { background: #E0F2FE; color: #0369A1; }
    .provider.imap   { background: #D1FAE5; color: #065F46; }

    /* ── Doc usage bar ── */
    .doc-count { min-width: 110px; }
    .text-green  { color: #15803D; font-weight: 600; font-size: 12px; }
    .text-orange { color: #B45309; font-weight: 600; font-size: 12px; }
    .text-red    { color: #B91C1C; font-weight: 600; font-size: 12px; }
    .bar-track { height: 3px; background: rgba(13,13,20,0.08); border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .bar-fill  { height: 100%; border-radius: 2px; transition: width 0.3s; }
    .bar-green  { background: #22C55E; }
    .bar-orange { background: #F59E0B; }
    .bar-red    { background: #EF4444; }

    .empty { text-align: center; color: var(--ink-muted); padding: 48px 16px; }
    .empty a { color: var(--purple); text-decoration: none; }
    .empty a:hover { text-decoration: underline; }

    /* ── Error ── */
    .error-box {
      background: #FEE2E2;
      border: 1px solid #FECACA;
      color: #B91C1C;
      border-radius: 12px;
      padding: 16px 20px;
      max-width: 480px;
      margin: 64px auto;
      font-size: 14px;
    }

    /* ── Footer ── */
    .footer {
      margin-top: 24px;
      color: var(--ink-muted);
      font-size: 12px;
      text-align: center;
    }
    .footer a { color: var(--ink-muted); text-decoration: none; }
    .footer a:hover { color: var(--purple); }

    a { color: var(--purple); text-decoration: none; }
    a:hover { text-decoration: underline; }
    ${extraCss}
  </style>
</head>
<body>
  <div class="topbar"></div>
  <nav class="nav">
    <a class="nav-logo" href="/">
      <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32">
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
