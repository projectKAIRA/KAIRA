import { config } from "../../config/index.js";
import { PlanTier } from "../../types/tenant.js";

const SENDER = "support@trykaira.ai";
const GRAPH_SEND_URL = `https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`;

// ─── App-only access token (client credentials) ───────────────────────────────

let _cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAppToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.value;
  }

  const { tenantId, clientId, clientSecret } = config.graph;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  console.log(`[ConfirmationMailer] Fetching app token — tenantId="${tenantId}", clientId="${clientId}"`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         "https://graph.microsoft.com/.default",
      grant_type:    "client_credentials",
    }),
  });

  const data = await res.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(`Token fetch failed: ${data.error} — ${data.error_description}`);
  }

  _cachedToken = {
    value:     data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  console.log("[ConfirmationMailer] App token acquired.");
  return _cachedToken.value;
}

// ─── Send via Graph API ───────────────────────────────────────────────────────

export async function sendWelcomeEmail(opts: {
  toEmail: string;
  companyName: string;
  planTier: PlanTier;
  notificationChannel: "Slack" | "Microsoft Teams";
  tenantId: string;
}): Promise<void> {
  const { toEmail, companyName, planTier, notificationChannel, tenantId } = opts;

  console.log(`[ConfirmationMailer] Preparing welcome email → ${toEmail} (company: "${companyName}", plan: ${planTier})`);

  const { clientId, clientSecret, tenantId: azureTenantId } = config.graph;
  if (!clientId || !clientSecret || !azureTenantId || azureTenantId === "consumers") {
    console.warn("[ConfirmationMailer] Azure app credentials not configured (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID) — skipping.");
    return;
  }

  const plan         = tierLabel(planTier);
  const token        = await getAppToken();
  const dashboardUrl = `${config.oauth.baseUrl}/dashboard?t=${encodeURIComponent(tenantId)}`;

  const body = {
    message: {
      subject: "Welcome to KAIRA — Your inbox is now being monitored",
      body: {
        contentType: "HTML",
        content:     buildHtml(companyName, plan, notificationChannel, dashboardUrl),
      },
      from: {
        emailAddress: { address: SENDER },
      },
      toRecipients: [
        { emailAddress: { address: toEmail } },
      ],
    },
    saveToSentItems: true,
  };

  console.log(`[ConfirmationMailer] POST ${GRAPH_SEND_URL}`);

  const res = await fetch(GRAPH_SEND_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    console.log(`[ConfirmationMailer] Email accepted by Graph API (202) for ${toEmail}.`);
    return;
  }

  // Any non-202 is an error — log the full response body.
  const responseText = await res.text();
  throw new Error(`Graph sendMail failed: HTTP ${res.status} — ${responseText}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tierLabel(tier: PlanTier): string {
  const labels: Record<PlanTier, string> = {
    none:       "Custom",
    trial:      "Trial",
    starter:    "Starter",
    growth:     "Growth",
    pro:        "Pro",
    enterprise: "Enterprise",
  };
  return labels[tier] ?? "Starter";
}

function buildHtml(companyName: string, plan: string, channel: string, dashboardUrl: string): string {
  // Status rows use <table> cells instead of flexbox — flexbox is stripped by
  // Outlook (Word rendering engine), which causes label+value to run together.
  const statusRow = (label: string, value: string, badge = false) => `
    <tr>
      <td style="padding:10px 0;font-size:14px;color:#6B7280;border-bottom:1px solid #EDE9FE;font-family:'DM Sans',Arial,sans-serif;">${label}</td>
      <td style="padding:10px 0;font-size:14px;text-align:right;border-bottom:1px solid #EDE9FE;">
        ${badge
          ? `<span style="display:inline-block;background:#F5F3FF;color:#8B5CF6;border-radius:20px;padding:3px 12px;font-size:12px;font-weight:600;font-family:'DM Sans',Arial,sans-serif;">${value}</span>`
          : `<span style="font-weight:600;color:#0D0D14;font-family:'DM Sans',Arial,sans-serif;">${value}</span>`
        }
      </td>
    </tr>`;

  const stepRow = (n: number, text: string) => `
    <tr>
      <td width="28" style="padding:6px 12px 6px 0;vertical-align:top;">
        <span style="display:inline-block;width:24px;height:24px;background:#EDE9FE;border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:700;color:#8B5CF6;font-family:'DM Sans',Arial,sans-serif;">${n}</span>
      </td>
      <td style="padding:6px 0;font-size:14px;color:#4B5563;line-height:1.65;font-family:'DM Sans',Arial,sans-serif;">${text}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Welcome to Project Kaira</title>
  <!--[if !mso]><!-->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <!--<![endif]-->
  <style>
    body { margin:0; padding:0; background:#F5F3FF; }
    @media only screen and (max-width:600px) {
      .wrapper { width:100% !important; border-radius:0 !important; }
      .body-pad { padding:28px 20px !important; }
      .footer-pad { padding:20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F5F3FF;font-family:'DM Sans',Arial,Helvetica,sans-serif;">

  <!-- Outer centering table -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F3FF;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card wrapper -->
        <table class="wrapper" width="560" cellpadding="0" cellspacing="0" border="0"
               style="background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(139,92,246,0.15);box-shadow:0 4px 32px rgba(139,92,246,0.10);">

          <!-- ── Purple accent stripe ── -->
          <tr>
            <td height="5" style="background:linear-gradient(90deg,#8B5CF6,#A78BFA);font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <!-- ── Logo header ── -->
          <tr>
            <td align="center" style="padding:36px 40px 28px;background:#ffffff;">

              <!-- Butterfly SVG + wordmark, side by side -->
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                <tr>
                  <td valign="middle" style="padding-right:10px;">
                    <!-- Butterfly SVG — inline so it renders without external fetches -->
                    <svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M50 55 C40 40, 15 30, 10 15 C8 8, 18 5, 25 12 C32 19, 42 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
                      <path d="M50 55 C60 40, 85 30, 90 15 C92 8, 82 5, 75 12 C68 19, 58 38, 50 55Z" stroke="#A78BFA" stroke-width="2" fill="none" stroke-linecap="round"/>
                      <path d="M50 55 C38 65, 12 72, 8 88 C6 95, 18 97, 26 88 C34 79, 44 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                      <path d="M50 55 C62 65, 88 72, 92 88 C94 95, 82 97, 74 88 C66 79, 56 65, 50 55Z" stroke="#C4B5FD" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                      <circle cx="50" cy="55" r="3" fill="#8B5CF6" opacity="0.6"/>
                      <line x1="50" y1="58" x2="50" y2="78" stroke="#8B5CF6" stroke-width="1.5" opacity="0.4" stroke-linecap="round"/>
                    </svg>
                  </td>
                  <td valign="middle">
                    <div style="font-family:'Dancing Script',Georgia,cursive;font-size:14px;font-weight:500;color:#A78BFA;letter-spacing:0.5px;line-height:1;">Project</div>
                    <div style="font-family:'DM Sans',Arial,sans-serif;font-size:16px;font-weight:700;color:#0D0D14;letter-spacing:4px;text-transform:uppercase;line-height:1;margin-top:3px;">Kaira</div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- ── Divider ── -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px;background:rgba(139,92,246,0.12);font-size:0;line-height:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- ── Body ── -->
          <tr>
            <td class="body-pad" style="padding:36px 40px;">

              <h1 style="margin:0 0 14px;font-size:22px;font-weight:700;color:#0D0D14;font-family:'DM Sans',Arial,sans-serif;">
                Welcome, ${esc(companyName)}!
              </h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.75;color:#4B5563;font-family:'DM Sans',Arial,sans-serif;">
                You're all set. KAIRA is now monitoring your inbox and will automatically
                detect incoming purchase orders, RFQs, and inquiries — routing them directly
                to your <strong style="color:#0D0D14;">${esc(channel)}</strong> channel.
              </p>

              <!-- ── Status card ── -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:#FAFAFF;border:1px solid rgba(139,92,246,0.18);border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:6px 20px 2px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${statusRow("Plan",             esc(plan),    true)}
                      ${statusRow("Free trial",       "14 days active", true)}
                      ${statusRow("Notifications",    esc(channel), true)}
                      ${statusRow("Inbox monitoring", "Active",     true)}
                    </table>
                    <!-- Remove border from last row -->
                    <style>table tr:last-child td { border-bottom:none !important; }</style>
                  </td>
                </tr>
              </table>

              <!-- ── What happens next ── -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:#FAFAFF;border:1px solid rgba(139,92,246,0.12);border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:20px 20px 14px;">
                    <p style="margin:0 0 14px;font-size:13px;font-weight:700;color:#0D0D14;letter-spacing:0.06em;text-transform:uppercase;font-family:'DM Sans',Arial,sans-serif;">What happens next</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${stepRow(1, "KAIRA polls your inbox on a regular cycle, looking for new emails.")}
                      ${stepRow(2, "When a purchase order, RFQ, or inquiry is detected, it extracts the key details using AI.")}
                      ${stepRow(3, `A structured alert is posted to your <strong>${esc(channel)}</strong> channel so your team can act immediately.`)}
                      ${stepRow(4, "Your 14-day free trial gives you full access — no charge until the trial ends.")}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- ── Dashboard link ── -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:#F5F3FF;border:1px solid rgba(139,92,246,0.18);border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0;font-size:13px;line-height:1.7;color:#4B5563;font-family:'DM Sans',Arial,sans-serif;">
                      You can always view your plan, update your Slack or Teams connection, and manage your account here:<br>
                      <a href="${esc(dashboardUrl)}" style="color:#8B5CF6;font-weight:600;text-decoration:none;word-break:break-all;">${esc(dashboardUrl)}</a>
                    </p>
                    <p style="margin:8px 0 0;font-size:12px;color:#9CA3AF;font-family:'DM Sans',Arial,sans-serif;">Bookmark this link — it's your personal account page.</p>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 32px;font-size:14px;line-height:1.75;color:#6B7280;font-family:'DM Sans',Arial,sans-serif;">
                If you have any questions or need help, just reply to this email or reach out at
                <a href="mailto:support@trykaira.ai" style="color:#8B5CF6;text-decoration:none;font-weight:500;">support@trykaira.ai</a> — we're here to help.
              </p>

              <!-- ── CTA button ── -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <a href="${esc(dashboardUrl)}"
                       style="display:inline-block;background:#8B5CF6;color:#ffffff;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:100px;letter-spacing:0.3px;">
                      Go to your dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;text-align:center;color:#9CA3AF;font-family:'DM Sans',Arial,sans-serif;">
                Bookmark this link — it's your personal account page.
              </p>

            </td>
          </tr>

          <!-- ── Footer ── -->
          <tr>
            <td class="footer-pad" style="padding:24px 40px;background:#FAFAFF;border-top:1px solid rgba(139,92,246,0.12);text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;color:#9CA3AF;line-height:1.6;font-family:'DM Sans',Arial,sans-serif;">
                You're receiving this because you signed up for Project Kaira.
              </p>
              <p style="margin:0;font-size:12px;color:#9CA3AF;font-family:'DM Sans',Arial,sans-serif;">
                <a href="https://trykaira.ai" style="color:#A78BFA;text-decoration:none;">trykaira.ai</a>
                &nbsp;&bull;&nbsp;
                <a href="mailto:support@trykaira.ai" style="color:#A78BFA;text-decoration:none;">support@trykaira.ai</a>
              </p>
            </td>
          </tr>

        </table>
        <!-- /card -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
