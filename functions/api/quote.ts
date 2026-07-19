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

const isJsonRequest = (request: Request) =>
  request.headers.get('Content-Type')?.toLowerCase().includes('application/json') ?? false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const html = (title: string, message: string, status = 200) =>
  new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} — KAIRA</title>
    <style>
      color-scheme: dark;
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090b; color: #f2f4f8; font-family: system-ui, sans-serif; }
      main { width: min(32rem, calc(100% - 2rem)); padding: 2.5rem; border: 1px solid #ffffff18; border-radius: 1.5rem; background: #ffffff0a; text-align: center; }
      h1 { margin: 0 0 1rem; font-size: clamp(2rem, 8vw, 3.5rem); }
      p { color: #b9bec9; line-height: 1.6; }
      a { display: inline-block; margin-top: 1rem; padding: .8rem 1.25rem; border-radius: 999px; background: #7c3aed; color: white; font-weight: 700; text-decoration: none; }
    </style>
  </head>
  <body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/contact">Back to the contact page</a></main></body>
</html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

const respond = (request: Request, body: { error?: string; ok?: boolean }, status = 200) => {
  if (isJsonRequest(request)) return json(body, status);
  return body.ok
    ? html('Request received', 'Thanks! We’ll reply within one business day.', status)
    : html('We couldn’t send that', body.error ?? 'Please try again.', status);
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: QuotePayload;
  try {
    if (isJsonRequest(request)) {
      body = await request.json();
    } else {
      const form = await request.formData();
      body = {
        name: String(form.get('name') ?? ''),
        business: String(form.get('business') ?? ''),
        email: String(form.get('email') ?? ''),
        phone: String(form.get('phone') ?? ''),
        website: String(form.get('website') ?? ''),
        services: form.getAll('services').map(String),
        budget: String(form.get('budget') ?? ''),
        details: String(form.get('details') ?? ''),
        turnstileToken: String(form.get('cf-turnstile-response') ?? ''),
      };
    }
  } catch {
    return respond(request, { error: 'Invalid request.' }, 400);
  }

  // --- Basic validation ---
  const name = body.name?.trim() ?? '';
  const business = body.business?.trim() ?? '';
  const email = body.email?.trim() ?? '';
  const details = body.details?.trim() ?? '';
  const services = Array.isArray(body.services) ? body.services.map(String).slice(0, 10) : [];

  if (!name || !business || !email || !details || services.length === 0) {
    return respond(request, { error: 'Please fill in all required fields.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(request, { error: 'Please enter a valid email address.' }, 400);
  }
  if (name.length > 200 || business.length > 200 || details.length > 5000) {
    return respond(request, { error: 'One of the fields is too long.' }, 400);
  }
  if (!body.turnstileToken) {
    return respond(request, { error: 'Verification missing. Please try again.' }, 400);
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
    return respond(request, { error: 'Verification failed. Please refresh and try again.' }, 403);
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
    return respond(
      request,
      { error: 'We could not send your request right now. Please email us directly.' },
      502,
    );
  }

  return respond(request, { ok: true });
};
