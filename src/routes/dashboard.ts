/**
 * Customer-facing account dashboard.
 *
 * Mounted at /dashboard in app.ts.
 *
 *   GET  /dashboard?t=<tenantId>              — account overview page
 *   POST /dashboard/teams-webhook?t=<tenantId> — save / update Teams webhook URL
 *
 * The tenant UUID acts as an unguessable access token (same pattern as
 * the onboarding session flow). No additional auth layer is needed for V1.
 */

import express, { Request, Response, Router } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { TenantScheduler } from "../services/tenant/TenantScheduler.js";
import { createBillingPortalSession, getPlans } from "../services/billing/StripeService.js";
import { config } from "../config/index.js";
import { PLAN_DOC_LIMITS, PlanTier } from "../types/tenant.js";
import { TrackedPO } from "../types/index.js";

const registry = new TenantRegistry();

export function createDashboardRouter(scheduler: TenantScheduler): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  // ─── GET /dashboard ────────────────────────────────────────────────────────

  router.get("/", async (req: Request, res: Response) => {
    const tenantId = (req.query["t"] as string | undefined)?.trim() ?? "";

    if (!tenantId) {
      res.status(400).send(errorPage("Missing account token. Please use the link from your welcome email."));
      return;
    }

    const tenant = await registry.findById(tenantId);
    if (!tenant) {
      res.status(404).send(errorPage("Account not found. Please check your link or contact support."));
      return;
    }

    const slackConnected   = !!(tenant.slack?.botToken);
    const teamsConnected   = !!(tenant.teams?.webhookUrl);
    const slackAvailable   = !!config.oauth.slack.clientId;
    const activeProvider   = tenant.notification?.provider ?? "slack";

    // Trial days remaining
    let trialDaysLeft: number | null = null;
    if (tenant.isTrialActive && tenant.trialEndDate) {
      const ms = new Date(tenant.trialEndDate).getTime() - Date.now();
      trialDaysLeft = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    }

    const slackConnectUrl  = `/auth/slack?tenantId=${encodeURIComponent(tenantId)}`;
    const switched   = req.query["switched"] as string | undefined;
    const connected  = req.query["slack_connected"] === "1";
    const teamsOk    = req.query["teams_connected"] === "1";
    const slackError = req.query["slack_error"] as string | undefined;
    const teamsError = req.query["teams_error"] as string | undefined;

    const billingError = req.query["billing_error"] as string | undefined;

    const flashSuccess = switched   ? `Switched to ${switched === "slack" ? "Slack" : "Microsoft Teams"} successfully.`
      : connected ? "Slack connected successfully."
      : teamsOk   ? "Teams webhook saved."
      : undefined;
    const flashError = slackError    ? `Slack error: ${slackError}`
      : teamsError   ? "Invalid webhook URL — must start with https://"
      : billingError === "no_subscription" ? "No active subscription found. Please contact support."
      : billingError ? "Could not open billing portal. Please try again or contact support."
      : undefined;

    const billingPortalUrl = `/dashboard/billing-portal?t=${encodeURIComponent(tenantId)}`;

    const runtime = scheduler.getRuntime(tenantId);
    const orders  = runtime ? await runtime.tracker.getAll() : [];

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboard({
      tenant,
      tenantId,
      slackConnected,
      teamsConnected,
      slackAvailable,
      activeProvider,
      trialDaysLeft,
      slackConnectUrl,
      billingPortalUrl,
      flashSuccess,
      flashError,
      orders,
    }));
  });

  // ─── GET /dashboard/billing-portal ────────────────────────────────────────

  router.get("/billing-portal", async (req: Request, res: Response) => {
    const tenantId = (req.query["t"] as string | undefined)?.trim() ?? "";

    if (!tenantId) { res.status(400).send(errorPage("Missing account token.")); return; }

    const tenant = await registry.findById(tenantId);
    if (!tenant) { res.status(404).send(errorPage("Account not found.")); return; }

    if (!tenant.stripeCustomerId) {
      res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&billing_error=no_subscription`);
      return;
    }

    try {
      const returnUrl = `${config.oauth.baseUrl}/dashboard?t=${encodeURIComponent(tenantId)}`;
      const session   = await createBillingPortalSession({
        stripeCustomerId: tenant.stripeCustomerId,
        returnUrl,
      });
      res.redirect(session.url);
    } catch (err) {
      console.error("[Dashboard] Billing portal error:", err);
      res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&billing_error=portal_failed`);
    }
  });

  // ─── POST /dashboard/switch-provider ──────────────────────────────────────

  router.post("/switch-provider", async (req: Request, res: Response) => {
    const tenantId = (req.query["t"] as string | undefined)?.trim() ?? "";
    const provider = (req.body.provider as string | undefined)?.trim() ?? "";

    if (!tenantId) { res.status(400).send(errorPage("Missing account token.")); return; }
    if (provider !== "slack" && provider !== "teams") { res.status(400).send(errorPage("Invalid provider.")); return; }

    const tenant = await registry.findById(tenantId);
    if (!tenant) { res.status(404).send(errorPage("Account not found.")); return; }

    await registry.update(tenantId, { notification: { provider } });

    // Rebuild scheduler runtime so the switch takes effect immediately.
    if (scheduler.getRuntime(tenantId)) {
      scheduler.removeTenant(tenantId);
      const updated = await registry.findById(tenantId);
      if (updated?.isActive) await scheduler.addTenant(updated);
    }

    res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&switched=${provider}`);
  });

  // ─── POST /dashboard/teams-webhook ────────────────────────────────────────

  router.post("/teams-webhook", async (req: Request, res: Response) => {
    const tenantId   = (req.query["t"] as string | undefined)?.trim() ?? "";
    const webhookUrl = (req.body.webhookUrl as string | undefined)?.trim() ?? "";

    if (!tenantId) {
      res.status(400).send(errorPage("Missing account token."));
      return;
    }

    const tenant = await registry.findById(tenantId);
    if (!tenant) {
      res.status(404).send(errorPage("Account not found."));
      return;
    }

    if (!webhookUrl.startsWith("https://")) {
      res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&teams_error=invalid_url`);
      return;
    }

    await registry.update(tenantId, {
      notification: { provider: "teams" },
      teams:        { webhookUrl },
    });

    // Rebuild scheduler runtime so new webhook takes effect immediately.
    if (scheduler.getRuntime(tenantId)) {
      scheduler.removeTenant(tenantId);
      const updated = await registry.findById(tenantId);
      if (updated?.isActive) await scheduler.addTenant(updated);
    }

    res.redirect(`/dashboard?t=${encodeURIComponent(tenantId)}&teams_connected=1`);
  });

  return router;
}

// ─── Render ────────────────────────────────────────────────────────────────────

interface DashboardData {
  tenant:           Awaited<ReturnType<TenantRegistry["findById"]>> & {};
  tenantId:         string;
  slackConnected:   boolean;
  teamsConnected:   boolean;
  slackAvailable:   boolean;
  activeProvider:   string;
  trialDaysLeft:    number | null;
  slackConnectUrl:  string;
  billingPortalUrl: string;
  flashSuccess?:    string;
  flashError?:      string;
  orders:           TrackedPO[];
}

function renderDashboard(d: DashboardData): string {
  const t = d.tenant!;

  // ── Plan badge ─────────────────────────────────────────────────────────────
  const planLabel = t.planTier === "none" ? "No Plan" : t.planTier.charAt(0).toUpperCase() + t.planTier.slice(1);

  let trialBadge = "";
  if (t.isTrialActive && d.trialDaysLeft !== null) {
    const urgency = d.trialDaysLeft <= 3 ? "badge-warn" : "badge-trial";
    trialBadge = `<span class="badge ${urgency}">${d.trialDaysLeft}d left in trial</span>`;
  } else if (t.trialLimitReached) {
    trialBadge = `<span class="badge badge-warn">Trial limit reached</span>`;
  }

  const statusBadge = t.isActive
    ? `<span class="badge badge-active">● Active</span>`
    : `<span class="badge badge-paused">● Paused</span>`;

  // ── Provider label ─────────────────────────────────────────────────────────
  const providerLabel = t.providerType === "microsoft" ? "Microsoft 365" : "IMAP";
  const monitoredEmail = t.graph?.userEmail ?? t.imap?.username ?? "—";

  // ── Notification status ────────────────────────────────────────────────────
  const slackActive  = d.activeProvider === "slack";
  const teamsActive  = d.activeProvider === "teams";

  const slackStatus  = !d.slackConnected ? `<span class="badge badge-off">Not connected</span>`
    : slackActive    ? `<span class="badge badge-active">● Active</span>`
    :                  `<span class="badge badge-paused">Connected</span>`;

  const teamsStatus  = !d.teamsConnected ? `<span class="badge badge-off">Not connected</span>`
    : teamsActive    ? `<span class="badge badge-active">● Active</span>`
    :                  `<span class="badge badge-paused">Connected</span>`;

  // ── Flash messages ─────────────────────────────────────────────────────────
  const flash = d.flashSuccess
    ? `<div class="flash flash-ok">✓ ${d.flashSuccess}</div>`
    : d.flashError
    ? `<div class="flash flash-err">✕ ${d.flashError}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KAIRA — Account</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

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
      --border-soft:  rgba(13,13,20,0.08);
      --green:        #10B981;
      --amber:        #F59E0B;
      --red:          #EF4444;
    }

    body {
      font-family: 'DM Sans', sans-serif;
      background: #F8F7FC;
      color: var(--ink);
      min-height: 100vh;
    }

    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 1000;
      opacity: 0.4;
    }

    /* ── NAV ── */
    .nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(24px);
      border-bottom: 1px solid var(--border);
      padding: 0 2rem;
      height: 60px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .logo { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .logo-butterfly { width: 32px; height: 32px; }
    .logo-text { display: flex; flex-direction: column; line-height: 1; gap: 2px; }
    .logo-project { font-family: 'Dancing Script', cursive; font-size: 11px; font-weight: 500; color: var(--purple-mid); }
    .logo-kaira   { font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; color: var(--ink); letter-spacing: 4px; text-transform: uppercase; }
    .nav-company  { font-size: 0.85rem; color: var(--ink-muted); }

    /* ── LAYOUT ── */
    .page { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }

    .page-header { margin-bottom: 2rem; }
    .page-header h1 { font-size: 1.5rem; font-weight: 600; color: var(--ink); }
    .page-header p  { font-size: 0.9rem; color: var(--ink-muted); margin-top: 0.3rem; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
    @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
    .grid-full { grid-column: 1 / -1; }

    /* ── CARD ── */
    .card {
      background: var(--white);
      border: 1px solid var(--border-soft);
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.04);
    }
    .card-title {
      font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--ink-muted);
      margin-bottom: 1rem;
    }

    /* ── STATUS ROW ── */
    .status-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .status-row:last-child { margin-bottom: 0; }

    /* ── INFO ROWS ── */
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--border-soft); }
    .info-row:last-child { border-bottom: none; padding-bottom: 0; }
    .info-label { font-size: 0.82rem; color: var(--ink-muted); }
    .info-value { font-size: 0.88rem; font-weight: 500; color: var(--ink); }

    /* ── BADGES ── */
    .badge {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.2rem 0.65rem; border-radius: 20px;
      font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em;
    }
    .badge-active { background: rgba(16,185,129,0.1); color: var(--green); }
    .badge-paused { background: rgba(122,119,143,0.1); color: var(--ink-muted); }
    .badge-trial  { background: var(--purple-ghost); color: var(--purple); border: 1px solid var(--border); }
    .badge-warn   { background: rgba(245,158,11,0.1); color: var(--amber); }
    .badge-off    { background: rgba(122,119,143,0.08); color: var(--ink-muted); }
    .badge-plan   { background: var(--purple-pale); color: var(--purple); }

    /* ── BIG PLAN VALUE ── */
    .plan-name { font-size: 1.6rem; font-weight: 700; color: var(--ink); line-height: 1; margin-bottom: 0.4rem; }
    .plan-sub  { font-size: 0.82rem; color: var(--ink-muted); }

    /* ── DOC USAGE BAR ── */
    .usage-bar-wrap { margin-top: 1rem; }
    .usage-label { display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--ink-muted); margin-bottom: 0.4rem; }
    .usage-bar { height: 6px; background: var(--purple-ghost); border-radius: 99px; overflow: hidden; }
    .usage-fill { height: 100%; background: var(--purple); border-radius: 99px; transition: width 0.4s; }

    /* ── BUTTONS ── */
    .btn {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.6rem 1.2rem; border-radius: 100px; border: none;
      font-size: 0.85rem; font-weight: 500; font-family: 'DM Sans', sans-serif;
      cursor: pointer; text-decoration: none; transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-primary { background: var(--ink); color: var(--white); }
    .btn-primary:hover { background: var(--purple); box-shadow: 0 6px 20px rgba(139,92,246,0.3); transform: translateY(-1px); }
    .btn-outline { background: transparent; color: var(--ink-soft); border: 1px solid var(--border-soft); }
    .btn-outline:hover { border-color: var(--purple); color: var(--purple); transform: translateY(-1px); }
    .btn-slack { background: #4A154B; color: var(--white); }
    .btn-slack:hover { background: #611f69; box-shadow: 0 6px 20px rgba(74,21,75,0.3); transform: translateY(-1px); }
    .btn-teams { background: #4B53BC; color: var(--white); }
    .btn-teams:hover { background: #3d44a0; box-shadow: 0 6px 20px rgba(75,83,188,0.3); transform: translateY(-1px); }
    .btn-sm { padding: 0.45rem 0.9rem; font-size: 0.8rem; }

    /* ── INPUT ── */
    .input-row { display: flex; gap: 0.6rem; margin-top: 0.75rem; flex-wrap: wrap; }
    input[type="url"], input[type="text"] {
      flex: 1; min-width: 0;
      padding: 0.6rem 0.9rem; border-radius: 10px;
      border: 1px solid var(--border-soft);
      font-size: 0.85rem; font-family: 'DM Sans', sans-serif;
      color: var(--ink); outline: none; background: var(--white);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus { border-color: var(--purple); box-shadow: 0 0 0 3px rgba(139,92,246,0.1); }
    input::placeholder { color: var(--ink-muted); }

    /* ── SECTION DIVIDER ── */
    .section-divider { display: flex; align-items: center; gap: 0.75rem; margin: 0.9rem 0; }
    .section-divider span { font-size: 0.72rem; color: var(--ink-muted); white-space: nowrap; }
    .section-divider::before, .section-divider::after { content: ""; flex: 1; height: 1px; background: var(--border-soft); }

    /* ── NOTIFICATION CHANNEL ── */
    .channel-row { display: flex; justify-content: space-between; align-items: center; padding: 0.8rem 0; border-bottom: 1px solid var(--border-soft); }
    .channel-row:last-child { border-bottom: none; padding-bottom: 0; }
    .channel-left { display: flex; align-items: center; gap: 0.6rem; }
    .channel-icon { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; }
    .channel-icon-slack { background: rgba(74,21,75,0.08); }
    .channel-icon-teams { background: rgba(75,83,188,0.08); }
    .channel-name  { font-size: 0.88rem; font-weight: 500; color: var(--ink); }
    .channel-right { display: flex; align-items: center; gap: 0.6rem; }

    /* ── FLASH ── */
    .flash {
      padding: 0.75rem 1rem; border-radius: 10px;
      font-size: 0.85rem; font-weight: 500;
      margin-bottom: 1.25rem;
    }
    .flash-ok  { background: rgba(16,185,129,0.08); color: var(--green); border: 1px solid rgba(16,185,129,0.2); }
    .flash-err { background: rgba(239,68,68,0.08);  color: var(--red);   border: 1px solid rgba(239,68,68,0.2); }

    /* ── HINT ── */
    .hint { font-size: 0.75rem; color: var(--ink-muted); margin-top: 0.5rem; line-height: 1.5; }

    /* ── TEAMS WEBHOOK FORM ── */
    .teams-form { margin-top: 0.85rem; }

    /* ── ORDERS TABLE ── */
    .orders-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
    .filter-group { display: flex; gap: 0.4rem; }
    .filter-btn {
      padding: 0.3rem 0.85rem; border-radius: 100px; border: 1px solid var(--border-soft);
      font-size: 0.78rem; font-weight: 500; font-family: 'DM Sans', sans-serif;
      cursor: pointer; background: transparent; color: var(--ink-muted);
      transition: all 0.15s;
    }
    .filter-btn:hover { border-color: var(--purple); color: var(--purple); }
    .filter-btn.active { background: var(--ink); color: #fff; border-color: var(--ink); }
    .orders-count { font-size: 0.78rem; color: var(--ink-muted); }

    .orders-table-wrap { overflow-x: auto; }
    table.orders {
      width: 100%; border-collapse: collapse;
      font-size: 0.84rem;
    }
    table.orders th {
      text-align: left; padding: 0.55rem 0.75rem;
      font-size: 0.68rem; font-weight: 700; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--ink-muted);
      border-bottom: 1px solid var(--border-soft);
      white-space: nowrap;
    }
    table.orders td {
      padding: 0.7rem 0.75rem;
      border-bottom: 1px solid var(--border-soft);
      color: var(--ink);
      vertical-align: middle;
    }
    table.orders tr:last-child td { border-bottom: none; }
    table.orders tr:hover td { background: var(--purple-ghost); }
    .orders-empty { text-align: center; padding: 2.5rem 1rem; color: var(--ink-muted); font-size: 0.88rem; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.18rem 0.6rem; border-radius: 100px;
      font-size: 0.7rem; font-weight: 600;
    }
    .pill-unclaimed { background: rgba(245,158,11,0.1); color: var(--amber); }
    .pill-claimed   { background: rgba(16,185,129,0.1); color: var(--green); }
    .po-number { font-weight: 600; color: var(--ink); }
    .sender-cell { font-size: 0.78rem; color: var(--ink-soft); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .total-cell { font-weight: 500; white-space: nowrap; }
    .date-cell  { color: var(--ink-muted); font-size: 0.78rem; white-space: nowrap; }
    .claimed-by { font-size: 0.82rem; color: var(--ink-soft); }
  </style>
</head>
<body>

  <nav class="nav">
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
    <span class="nav-company">${escHtml(t.name)}</span>
  </nav>

  <div class="page">
    ${flash}

    <div class="page-header">
      <h1>Account Overview</h1>
      <p>Manage your inbox connection, notifications, and plan.</p>
    </div>

    <div class="grid">

      <!-- ── Plan & Trial ── -->
      <div class="card">
        <div class="card-title">Subscription</div>
        <div class="plan-name">${escHtml(planLabel)}</div>
        <div class="plan-sub" style="margin-bottom:0.75rem;">
          ${t.isTrialActive && d.trialDaysLeft !== null
            ? `14-day free trial — <strong>${d.trialDaysLeft} day${d.trialDaysLeft === 1 ? "" : "s"} remaining</strong>`
            : t.trialLimitReached ? "Trial limit reached"
            : "Active subscription"}
        </div>
        <div class="status-row" style="margin-bottom:1rem;">
          <span class="badge badge-plan">${escHtml(planLabel)}</span>
          ${trialBadge}
        </div>
        ${t.stripeCustomerId
          ? `<a class="btn btn-primary" href="${d.billingPortalUrl}" style="display:inline-flex;width:auto;">
               Manage subscription &rarr;
             </a>
             <p class="hint" style="margin-top:0.6rem;">Upgrade, downgrade, or cancel — handled securely by Stripe.</p>`
          : `<p class="hint">No billing on file. <a href="mailto:support@trykaira.ai" style="color:var(--purple);">Contact support</a> to manage your plan.</p>`}
      </div>

      <!-- ── Monitoring Status ── -->
      <div class="card">
        <div class="card-title">Monitoring</div>
        <div class="status-row" style="margin-bottom:0.9rem;">
          ${statusBadge}
        </div>
        <div class="info-row">
          <span class="info-label">Provider</span>
          <span class="info-value">${escHtml(providerLabel)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Inbox</span>
          <span class="info-value" style="font-size:0.8rem;word-break:break-all;">${escHtml(monitoredEmail)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Folder</span>
          <span class="info-value">${escHtml(t.graph?.inboxFolder ?? "inbox")}</span>
        </div>
      </div>

      <!-- ── Doc Usage ── -->
      <div class="card">
        <div class="card-title">Documents This Month</div>
        ${buildUsageBlock(t)}
      </div>

      <!-- ── Notifications (full width) ── -->
      <div class="card grid-full">
        <div class="card-title">Notification Channels</div>

        <!-- Slack -->
        <div class="channel-row">
          <div class="channel-left">
            <div class="channel-icon channel-icon-slack">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#4A154B"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.687 8.834a2.528 2.528 0 0 1-2.521 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.166 0a2.528 2.528 0 0 1 2.521 2.522v6.312zM15.166 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.166 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zM15.166 17.687a2.527 2.527 0 0 1-2.521-2.521 2.526 2.526 0 0 1 2.521-2.521h6.312A2.527 2.527 0 0 1 24 15.166a2.528 2.528 0 0 1-2.522 2.521h-6.312z"/></svg>
            </div>
            <div>
              <div class="channel-name">Slack</div>
              ${d.slackConnected ? `<div class="hint" style="margin-top:1px;">Bot token on file</div>` : `<div class="hint" style="margin-top:1px;">Not connected</div>`}
            </div>
          </div>
          <div class="channel-right">
            ${slackStatus}
            ${d.slackAvailable
              ? `<a class="btn btn-slack btn-sm" href="${d.slackConnectUrl}">${d.slackConnected ? "Reconnect" : "Connect"}</a>`
              : `<span class="hint">Slack not configured</span>`}
            ${d.slackConnected && !slackActive
              ? `<form method="POST" action="/dashboard/switch-provider?t=${encodeURIComponent(d.tenantId)}" style="display:inline;">
                   <input type="hidden" name="provider" value="slack">
                   <button type="submit" class="btn btn-outline btn-sm">Make active</button>
                 </form>`
              : ""}
          </div>
        </div>

        <!-- Teams -->
        <div class="channel-row">
          <div class="channel-left">
            <div class="channel-icon channel-icon-teams">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#4B53BC"><path d="M20.625 5.85h-4.2l-.975-2.1a1.35 1.35 0 0 0-1.2-.75H9.75a1.35 1.35 0 0 0-1.2.75L7.575 5.85H3.375A1.875 1.875 0 0 0 1.5 7.725v10.5A1.875 1.875 0 0 0 3.375 20.1h17.25a1.875 1.875 0 0 0 1.875-1.875V7.725A1.875 1.875 0 0 0 20.625 5.85zM12 16.35a4.35 4.35 0 1 1 0-8.7 4.35 4.35 0 0 1 0 8.7zm0-1.5a2.85 2.85 0 1 0 0-5.7 2.85 2.85 0 0 0 0 5.7z"/></svg>
            </div>
            <div>
              <div class="channel-name">Microsoft Teams</div>
              ${d.teamsConnected ? `<div class="hint" style="margin-top:1px;">Webhook on file</div>` : `<div class="hint" style="margin-top:1px;">Paste your Teams incoming webhook URL below</div>`}
            </div>
          </div>
          <div class="channel-right">
            ${teamsStatus}
            ${d.teamsConnected && !teamsActive
              ? `<form method="POST" action="/dashboard/switch-provider?t=${encodeURIComponent(d.tenantId)}" style="display:inline;">
                   <input type="hidden" name="provider" value="teams">
                   <button type="submit" class="btn btn-outline btn-sm">Make active</button>
                 </form>`
              : ""}
          </div>
        </div>

        <!-- Teams webhook form -->
        <div class="teams-form">
          <form method="POST" action="/dashboard/teams-webhook?t=${encodeURIComponent(d.tenantId)}">
            <div class="input-row">
              <input type="url" name="webhookUrl"
                placeholder="https://outlook.office.com/webhook/…"
                value="${d.teamsConnected ? escHtml(t.teams?.webhookUrl ?? "") : ""}">
              <button type="submit" class="btn btn-teams btn-sm">${d.teamsConnected ? "Update" : "Save"}</button>
            </div>
            <div class="hint">Find this in Teams → channel → Connectors → Incoming Webhook.</div>
          </form>
        </div>

      </div><!-- /notifications card -->

    </div><!-- /grid -->

    <!-- ── Orders Table ─────────────────────────────────────────────────── -->
    <div class="card" style="margin-top:1.25rem;">
      <div class="orders-header">
        <div class="card-title" style="margin-bottom:0;">Purchase Orders</div>
        <div style="display:flex;align-items:center;gap:0.9rem;flex-wrap:wrap;">
          <span class="orders-count" id="orders-count"></span>
          <div class="filter-group">
            <button class="filter-btn active" data-filter="all">All</button>
            <button class="filter-btn" data-filter="unclaimed">Unclaimed</button>
            <button class="filter-btn" data-filter="claimed">Claimed</button>
          </div>
        </div>
      </div>
      ${renderOrdersTable(d.orders)}
    </div>

  </div>

</body>
<script>
(function () {
  var rows    = Array.from(document.querySelectorAll('tr[data-status]'));
  var btns    = Array.from(document.querySelectorAll('.filter-btn'));
  var countEl = document.getElementById('orders-count');

  function setCount(visible) {
    if (countEl) countEl.textContent = visible + ' order' + (visible === 1 ? '' : 's');
  }

  function applyFilter(f) {
    var visible = 0;
    rows.forEach(function (r) {
      var show = f === 'all' || r.dataset.status === f;
      r.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    setCount(visible);
    btns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.filter === f);
    });
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () { applyFilter(b.dataset.filter); });
  });

  applyFilter('all');
})();
</script>
</html>`;
}

function renderOrdersTable(orders: TrackedPO[]): string {
  if (orders.length === 0) {
    return `<div class="orders-table-wrap">
      <div class="orders-empty">No purchase orders yet. They'll appear here as KAIRA processes your inbox.</div>
    </div>`;
  }

  // Sort: unclaimed first, then by receivedAt descending
  const sorted = [...orders].sort((a, b) => {
    if (a.status !== b.status) return a.status === "unclaimed" ? -1 : 1;
    return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  });

  const rows = sorted.map((po) => {
    const poNum    = escHtml(po.purchaseOrder.poNumber ?? "—");
    const sender   = escHtml(po.email.sender ?? "—");
    const total    = po.purchaseOrder.total != null
      ? `${po.purchaseOrder.currency ?? ""}${Number(po.purchaseOrder.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—";
    const received = fmtDate(po.receivedAt);
    const pill     = po.status === "unclaimed"
      ? `<span class="status-pill pill-unclaimed">● Unclaimed</span>`
      : `<span class="status-pill pill-claimed">✓ Claimed</span>`;
    const claimedBy = po.status === "claimed"
      ? `<span class="claimed-by">${escHtml(po.claimedByName ?? po.claimedBy ?? "—")}</span>`
      : `<span style="color:var(--ink-muted);font-size:0.78rem;">—</span>`;

    return `<tr data-status="${po.status}">
      <td><span class="po-number">${poNum}</span></td>
      <td><span class="sender-cell" title="${sender}">${sender}</span></td>
      <td><span class="total-cell">${escHtml(total)}</span></td>
      <td><span class="date-cell">${received}</span></td>
      <td>${pill}</td>
      <td>${claimedBy}</td>
    </tr>`;
  }).join("\n");

  return `<div class="orders-table-wrap">
    <table class="orders">
      <thead>
        <tr>
          <th>PO Number</th>
          <th>Sender</th>
          <th>Total</th>
          <th>Received</th>
          <th>Status</th>
          <th>Claimed By</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return iso;
  }
}

function buildUsageBlock(t: NonNullable<Awaited<ReturnType<TenantRegistry["findById"]>>>): string {
  const limit = PLAN_DOC_LIMITS[t.planTier as PlanTier] ?? null;
  const count = t.monthlyDocCount ?? 0;

  if (!limit) {
    return `<div class="plan-name" style="font-size:2rem;">${count}</div>
            <div class="plan-sub">documents processed this month</div>`;
  }

  const pct = Math.min(100, Math.round((count / limit) * 100));
  const fillColor = pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--purple)";

  return `
    <div class="plan-name" style="font-size:2rem;">${count} <span style="font-size:1rem;font-weight:400;color:var(--ink-muted)">/ ${limit}</span></div>
    <div class="plan-sub">documents processed this month</div>
    <div class="usage-bar-wrap">
      <div class="usage-label">
        <span>${pct}% used</span>
        <span>${limit - count} remaining</span>
      </div>
      <div class="usage-bar">
        <div class="usage-fill" style="width:${pct}%;background:${fillColor};"></div>
      </div>
    </div>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>KAIRA — Error</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'DM Sans', sans-serif; background: #F8F7FC; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .box { background: #fff; border-radius: 16px; padding: 2.5rem; max-width: 400px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    h2 { font-size: 1.1rem; color: #0D0D14; margin-bottom: 0.5rem; }
    p  { font-size: 0.88rem; color: #7A778F; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Something went wrong</h2>
    <p>${escHtml(message)}</p>
  </div>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
