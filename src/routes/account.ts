/**
 * My Account — email-based dashboard link recovery
 *
 * GET  /account          — email input form
 * POST /account/lookup   — look up tenant by contactEmail, send recovery email
 */

import express, { Request, Response, Router } from "express";
import { TenantRegistry } from "../services/tenant/TenantRegistry.js";
import { getAppToken } from "../services/email/ConfirmationMailer.js";
import { config } from "../config/index.js";

const registry = new TenantRegistry();

export function createAccountRouter(): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  // ─── GET /account ──────────────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPage());
  });

  // ─── POST /account/lookup ──────────────────────────────────────────────────

  router.post("/lookup", async (req: Request, res: Response) => {
    const email = (req.body.email as string | undefined)?.trim().toLowerCase() ?? "";

    if (!email || !email.includes("@")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderPage({ error: "Please enter a valid email address." }));
      return;
    }

    // Always show the "check your inbox" screen — don't reveal whether the account exists.
    const tenant = await registry.findByContactEmail(email).catch(() => null);

    if (tenant) {
      const dashboardUrl = `${config.oauth.baseUrl}/dashboard?t=${encodeURIComponent(tenant.id)}`;
      sendRecoveryEmail(email, tenant.name, dashboardUrl).catch((err: unknown) => {
        console.error("[Account] Recovery email failed:", err);
      });
    } else {
      console.log(`[Account] No tenant found for contactEmail="${email}" — recovery email not sent.`);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPage({ sent: true, email }));
  });

  return router;
}

// ─── Email sender ──────────────────────────────────────────────────────────────

const SENDER         = "support@trykaira.ai";
const GRAPH_SEND_URL = `https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`;

async function sendRecoveryEmail(toEmail: string, companyName: string, dashboardUrl: string): Promise<void> {
  const { clientId, clientSecret, tenantId } = config.graph;
  if (!clientId || !clientSecret || !tenantId || tenantId === "consumers") {
    console.warn("[Account] Azure credentials not configured — skipping recovery email.");
    return;
  }

  const token = await getAppToken();

  const body = {
    message: {
      subject: "Your KAIRA dashboard link",
      body: {
        contentType: "HTML",
        content:     buildRecoveryHtml(companyName, dashboardUrl),
      },
      from: { emailAddress: { address: SENDER } },
      toRecipients: [{ emailAddress: { address: toEmail } }],
    },
    saveToSentItems: true,
  };

  const sendRes = await fetch(GRAPH_SEND_URL, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (sendRes.status !== 202) {
    const text = await sendRes.text();
    throw new Error(`Graph sendMail failed: HTTP ${sendRes.status} — ${text}`);
  }

  console.log(`[Account] Recovery email sent to ${toEmail}.`);
}

// ─── HTML renderers ───────────────────────────────────────────────────────────

function renderPage(opts: { error?: string; sent?: boolean; email?: string } = {}): string {
  const { error, sent, email } = opts;

  const bodyContent = sent
    ? `
      <div style="text-align:center;padding:12px 0 8px;">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;background:#EDE9FE;border-radius:50%;margin-bottom:20px;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M20 4H4C2.9 4 2 4.9 2 6v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" fill="#8B5CF6"/></svg>
        </div>
        <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0D0D14;">Check your inbox</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#4B5563;">
          If <strong>${esc(email ?? "")}</strong> is associated with a KAIRA account,<br>
          we've sent your dashboard link there.
        </p>
        <p style="margin:0;font-size:13px;color:#9CA3AF;">
          Didn't get it? Check your spam folder or
          <a href="/account" style="color:#8B5CF6;text-decoration:none;font-weight:500;">try again</a>.
        </p>
      </div>`
    : `
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#0D0D14;">My Account</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.75;color:#4B5563;">
        Enter the email address you used when signing up for KAIRA and we'll send you a link to your dashboard.
      </p>
      ${error ? `<p style="margin:0 0 16px;font-size:13px;color:#EF4444;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 14px;">${esc(error)}</p>` : ""}
      <form method="POST" action="/account/lookup">
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">Email address</label>
          <input
            type="email"
            name="email"
            required
            placeholder="orders@yourcompany.com"
            style="width:100%;box-sizing:border-box;padding:11px 14px;font-size:14px;border:1.5px solid #E5E7EB;border-radius:10px;outline:none;font-family:'DM Sans',Arial,sans-serif;color:#0D0D14;transition:border-color .15s;"
            onfocus="this.style.borderColor='#8B5CF6'"
            onblur="this.style.borderColor='#E5E7EB'"
          >
        </div>
        <button
          type="submit"
          style="width:100%;padding:13px;background:#8B5CF6;color:#fff;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:600;border:none;border-radius:100px;cursor:pointer;letter-spacing:0.3px;"
        >Send my dashboard link &rarr;</button>
      </form>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Account — KAIRA</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root { --purple: #8B5CF6; --purple-light: #A78BFA; --purple-xlight: #EDE9FE; }
    body {
      margin: 0; padding: 0;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #F5F3FF;
      font-family: 'DM Sans', Arial, sans-serif;
    }
    body::before {
      content: "";
      position: fixed; inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
      pointer-events: none; z-index: 0;
    }
    .card {
      position: relative; z-index: 1;
      background: #fff;
      border-radius: 20px;
      border: 1px solid rgba(139,92,246,0.15);
      box-shadow: 0 4px 32px rgba(139,92,246,0.10);
      padding: 0;
      width: 100%; max-width: 440px;
      overflow: hidden;
    }
    .card-stripe { height: 5px; background: linear-gradient(90deg,#8B5CF6,#A78BFA); }
    .card-logo {
      display: flex; align-items: center; gap: 10px;
      padding: 28px 36px 20px;
      border-bottom: 1px solid rgba(139,92,246,0.10);
      text-decoration: none;
    }
    .logo-text { display: flex; flex-direction: column; }
    .logo-project { font-family: 'Dancing Script', cursive; font-size: 12px; color: #A78BFA; }
    .logo-kaira { font-size: 14px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #0D0D14; }
    .card-body { padding: 32px 36px 36px; }
    @media (max-width: 480px) {
      .card { border-radius: 0; max-width: 100%; min-height: 100vh; }
      .card-body { padding: 24px 20px 28px; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-stripe"></div>
    <a class="card-logo" href="/">
      <svg width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
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
    <div class="card-body">
      ${bodyContent}
    </div>
  </div>
</body>
</html>`;
}

function buildRecoveryHtml(companyName: string, dashboardUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your KAIRA dashboard link</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#F5F3FF;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F3FF;">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0"
             style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid rgba(139,92,246,0.15);box-shadow:0 4px 32px rgba(139,92,246,0.10);">
        <tr><td height="5" style="background:linear-gradient(90deg,#8B5CF6,#A78BFA);font-size:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:36px 40px 32px;">
            <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0D0D14;">Your KAIRA dashboard</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.75;color:#4B5563;">
              Hi ${esc(companyName)}, here's the link to your account dashboard:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#F5F3FF;border:1px solid rgba(139,92,246,0.18);border-radius:12px;margin-bottom:28px;">
              <tr>
                <td style="padding:16px 20px;">
                  <a href="${esc(dashboardUrl)}" style="color:#8B5CF6;font-weight:600;text-decoration:none;word-break:break-all;font-size:14px;">${esc(dashboardUrl)}</a>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center">
                  <a href="${esc(dashboardUrl)}"
                     style="display:inline-block;background:#8B5CF6;color:#fff;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:100px;">
                    Go to my dashboard &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:13px;color:#9CA3AF;text-align:center;">
              Bookmark this link — it's your personal account page.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;background:#FAFAFF;border-top:1px solid rgba(139,92,246,0.12);text-align:center;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;">
              <a href="https://trykaira.ai" style="color:#A78BFA;text-decoration:none;">trykaira.ai</a>
              &nbsp;&bull;&nbsp;
              <a href="mailto:support@trykaira.ai" style="color:#A78BFA;text-decoration:none;">support@trykaira.ai</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
