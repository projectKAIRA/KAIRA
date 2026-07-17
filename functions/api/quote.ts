/**
 * Cloudflare Pages Function: POST /api/quote
 * Verifies Cloudflare Turnstile, then emails the lead via Resend.
 *
 * Required environment variables (set in the Cloudflare Pages dashboard):
 *   TURNSTILE_SECRET_KEY — Turnstile secret key
 *   RESEND_API_KEY       — Resend API key
 *   LEAD_TO_EMAIL        — inbox that receives quote requests
 *   LEAD_FROM_EMAIL      — verified Resend sender, e.g. "KAIRA <quotes@yourdomain.com>"
 */

interface Env {
  TURNSTILE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  LEAD_TO_EMAIL: string;
  LEAD_FROM_EMAIL: string;
}

interface QuotePayload {
  name?: string;
  business?: string;
  email?: string;
  phone?: string;
  website?: string;
  services?: string[];
  budget?: string;
  details?: string;
  turnstileToken?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: QuotePayload;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // --- Basic validation ---
  const name = body.name?.trim() ?? '';
  const business = body.business?.trim() ?? '';
  const email = body.email?.trim() ?? '';
  const details = body.details?.trim() ?? '';
  const services = Array.isArray(body.services) ? body.services.map(String).slice(0, 10) : [];

  if (!name || !business || !email || !details || services.length === 0) {
    return json({ error: 'Please fill in all required fields.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (name.length > 200 || business.length > 200 || details.length > 5000) {
    return json({ error: 'One of the fields is too long.' }, 400);
  }
  if (!body.turnstileToken) {
    return json({ error: 'Verification missing. Please try again.' }, 400);
  }

  // --- Verify Turnstile ---
  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: body.turnstileToken,
      remoteip: request.headers.get('CF-Connecting-IP') ?? undefined,
    }),
  });
  const verify = (await verifyRes.json()) as { success: boolean };
  if (!verify.success) {
    return json({ error: 'Verification failed. Please refresh and try again.' }, 403);
  }

  // --- Send lead email via Resend ---
  const phone = body.phone?.trim() || '—';
  const website = body.website?.trim() || '—';
  const budget = body.budget?.trim() || 'Not specified';

  const html = `
    <h2>New quote request — ${esc(business)}</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td><b>Name</b></td><td>${esc(name)}</td></tr>
      <tr><td><b>Business</b></td><td>${esc(business)}</td></tr>
      <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
      <tr><td><b>Phone</b></td><td>${esc(phone)}</td></tr>
      <tr><td><b>Current website</b></td><td>${esc(website)}</td></tr>
      <tr><td><b>Services</b></td><td>${esc(services.join(', '))}</td></tr>
      <tr><td><b>Budget</b></td><td>${esc(budget)}</td></tr>
    </table>
    <h3>Project details</h3>
    <p style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${esc(details)}</p>
  `;

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.LEAD_FROM_EMAIL,
      to: [env.LEAD_TO_EMAIL],
      reply_to: email,
      subject: `New quote request: ${business}`,
      html,
    }),
  });

  if (!sendRes.ok) {
    console.error('Resend error:', sendRes.status, await sendRes.text());
    return json({ error: 'We could not send your request right now. Please email us directly.' }, 502);
  }

  return json({ ok: true });
};
