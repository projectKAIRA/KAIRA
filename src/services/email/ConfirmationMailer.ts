import nodemailer from "nodemailer";
import { config } from "../../config/index.js";
import { PlanTier } from "../../types/tenant.js";

const FROM = '"KAIRA" <support@trykaira.ai>';

function getTransporter() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false, // STARTTLS on port 587
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: { ciphers: "SSLv3" },
  });
}

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

export async function sendWelcomeEmail(opts: {
  toEmail: string;
  companyName: string;
  planTier: PlanTier;
  notificationChannel: "Slack" | "Microsoft Teams";
}): Promise<void> {
  if (!config.smtp.user || !config.smtp.pass) {
    console.warn("[ConfirmationMailer] SMTP credentials not configured — skipping welcome email.");
    return;
  }

  const { toEmail, companyName, planTier, notificationChannel } = opts;
  const plan = tierLabel(planTier);

  const html = buildHtml(companyName, plan, notificationChannel);
  const text = buildText(companyName, plan, notificationChannel);

  const transporter = getTransporter();

  await transporter.sendMail({
    from:    FROM,
    to:      toEmail,
    subject: "Welcome to KAIRA — Your inbox is now being monitored",
    text,
    html,
  });

  console.log(`[ConfirmationMailer] Welcome email sent to ${toEmail} for "${companyName}".`);
}

// ─── Templates ────────────────────────────────────────────────────────────────

function buildHtml(companyName: string, plan: string, channel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to KAIRA</title>
  <style>
    body { margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; }
    .wrapper { max-width: 580px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { background: #0d0d0d; padding: 32px 40px; text-align: center; }
    .logo { font-size: 22px; font-weight: 700; letter-spacing: 0.15em; color: #ffffff; }
    .logo-sub { font-size: 11px; color: #666; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 4px; }
    .body { padding: 40px; }
    h1 { font-size: 22px; font-weight: 700; color: #0d0d0d; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.7; color: #444; margin: 0 0 20px; }
    .status-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px 24px; margin: 28px 0; }
    .status-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 14px; border-bottom: 1px solid #dcfce7; }
    .status-row:last-child { border-bottom: none; }
    .status-label { color: #6b7280; }
    .status-value { font-weight: 600; color: #15803d; }
    .next-steps { background: #fafafa; border-radius: 8px; padding: 20px 24px; margin: 28px 0; }
    .next-steps h2 { font-size: 15px; font-weight: 700; color: #0d0d0d; margin: 0 0 14px; }
    .next-steps ol { margin: 0; padding-left: 20px; }
    .next-steps li { font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 8px; }
    .cta { text-align: center; margin: 32px 0 8px; }
    .cta a { display: inline-block; background: #0d0d0d; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px; letter-spacing: 0.02em; }
    .footer { background: #f9f9f9; padding: 24px 40px; text-align: center; border-top: 1px solid #ebebeb; }
    .footer p { font-size: 12px; color: #999; margin: 0 0 6px; line-height: 1.6; }
    .footer a { color: #666; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">K.A.I.R.A</div>
      <div class="logo-sub">Inbox Intelligence Platform</div>
    </div>
    <div class="body">
      <h1>Welcome, ${esc(companyName)}!</h1>
      <p>
        You're all set. KAIRA is now monitoring your inbox and will automatically detect
        incoming purchase orders, RFQs, and inquiries — routing them directly to your
        ${esc(channel)} channel.
      </p>

      <div class="status-box">
        <div class="status-row">
          <span class="status-label">Plan</span>
          <span class="status-value">${esc(plan)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Free trial</span>
          <span class="status-value">14 days active</span>
        </div>
        <div class="status-row">
          <span class="status-label">Notifications</span>
          <span class="status-value">${esc(channel)}</span>
        </div>
        <div class="status-row">
          <span class="status-label">Inbox monitoring</span>
          <span class="status-value">Active</span>
        </div>
      </div>

      <div class="next-steps">
        <h2>What happens next</h2>
        <ol>
          <li>KAIRA polls your inbox on a regular cycle, looking for new emails.</li>
          <li>When a purchase order, RFQ, or inquiry is detected, it extracts the key details using AI.</li>
          <li>A structured alert is posted to your ${esc(channel)} channel so your team can act immediately.</li>
          <li>Your 14-day free trial gives you full access — no charge until the trial ends.</li>
        </ol>
      </div>

      <p>
        If you have any questions or need help getting the most out of KAIRA, just reply to this
        email or reach out at
        <a href="mailto:support@trykaira.ai">support@trykaira.ai</a> — we're here to help.
      </p>

      <div class="cta">
        <a href="https://trykaira.ai">Visit trykaira.ai</a>
      </div>
    </div>
    <div class="footer">
      <p>You're receiving this because you signed up for KAIRA.</p>
      <p><a href="https://trykaira.ai">trykaira.ai</a> &nbsp;&bull;&nbsp; <a href="mailto:support@trykaira.ai">support@trykaira.ai</a></p>
    </div>
  </div>
</body>
</html>`;
}

function buildText(companyName: string, plan: string, channel: string): string {
  return `Welcome to KAIRA, ${companyName}!

You're all set. KAIRA is now monitoring your inbox and will automatically detect incoming purchase orders, RFQs, and inquiries — routing them directly to your ${channel} channel.

YOUR ACCOUNT
  Plan:              ${plan}
  Free trial:        14 days active
  Notifications:     ${channel}
  Inbox monitoring:  Active

WHAT HAPPENS NEXT
  1. KAIRA polls your inbox on a regular cycle, looking for new emails.
  2. When a purchase order, RFQ, or inquiry is detected, it extracts the key details using AI.
  3. A structured alert is posted to your ${channel} channel so your team can act immediately.
  4. Your 14-day free trial gives you full access — no charge until the trial ends.

Questions? Reply to this email or contact us at support@trykaira.ai — we're here to help.

Visit us at https://trykaira.ai

—
KAIRA · Inbox Intelligence Platform
support@trykaira.ai · https://trykaira.ai
`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
