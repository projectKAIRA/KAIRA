import { useEffect, useRef, useState } from 'react';
import { Input, Textarea, Select, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const serviceOptions = ['New website', 'Redesign', 'Local SEO', 'Care plan / maintenance', 'Not sure yet'];
const budgetOptions = ['Under $1,000', '$1,000 – $2,500', '$2,500 – $5,000', '$5,000+', 'Not sure yet'];

const turnstileSiteKey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || '';

export default function Contact() {
  const [status, setStatus] = useState({ msg: '', ok: null });
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState([]);
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileHost = useRef(null);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileHost.current) return undefined;

    let widgetId;
    let cancelled = false;

    const renderWidget = () => {
      if (cancelled || !window.turnstile || !turnstileHost.current) return;
      turnstileHost.current.replaceChildren();
      widgetId = window.turnstile.render(turnstileHost.current, {
        sitekey: turnstileSiteKey,
        theme: 'light',
        callback: (token) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    };

    const existingScript = document.querySelector('script[data-kaira-turnstile]');
    if (window.turnstile) {
      renderWidget();
    } else if (existingScript) {
      existingScript.addEventListener('load', renderWidget, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.kairaTurnstile = 'true';
      script.addEventListener('load', renderWidget, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
      existingScript?.removeEventListener('load', renderWidget);
      if (widgetId !== undefined && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, []);

  function toggleService(name) {
    setSelected((prev) => (prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setStatus({ msg: 'Sending…', ok: null });

    const form = new FormData(e.currentTarget);
    const payload = {
      name: form.get('name') || '',
      business: form.get('business') || '',
      email: form.get('email') || '',
      phone: form.get('phone') || '',
      website: form.get('website') || '',
      services: selected,
      budget: form.get('budget') || '',
      details: form.get('details') || '',
      turnstileToken,
    };

    if (selected.length === 0) {
      setStatus({ msg: 'Please select at least one service.', ok: false });
      setSubmitting(false);
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setStatus({ msg: 'Please complete the verification before sending.', ok: false });
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || 'Something went wrong. Please email hi@trykaira.ai instead.');
      }
      setStatus({ msg: data.message || "Thanks — we'll be in touch within one business day.", ok: true });
      e.currentTarget.reset();
      setSelected([]);
      setTurnstileToken('');
      if (window.turnstile) window.turnstile.reset();
    } catch (err) {
      setStatus({ msg: err.message, ok: false });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="mesh-bg">
        <div className="mx-auto max-w-2xl px-5 pb-12 pt-16 text-center md:pt-24">
          <h1 className="reveal-words text-4xl font-bold tracking-tight text-ink md:text-6xl">
            Get your <span className="grad-text">free quote.</span>
          </h1>
          <p className="reveal reveal-delay-1 mt-4 text-lg text-ink-soft">
            Tell us a bit about your business. We'll reply within one business day — no pressure, no obligation.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-2xl px-5 pb-20 md:pb-28">
        <form onSubmit={onSubmit} className="reveal glass rounded-2xl p-7 md:p-10" noValidate>
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <Label htmlFor="name">Your name <span aria-hidden="true" className="text-purple">*</span></Label>
              <Input id="name" name="name" required autoComplete="name" placeholder="Jane Smith" />
            </div>
            <div>
              <Label htmlFor="business">Business name <span aria-hidden="true" className="text-purple">*</span></Label>
              <Input id="business" name="business" required autoComplete="organization" placeholder="Smith's Bakery" />
            </div>
            <div>
              <Label htmlFor="email">Email <span aria-hidden="true" className="text-purple">*</span></Label>
              <Input id="email" name="email" type="email" required autoComplete="email" placeholder="jane@smithsbakery.com" />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" type="tel" autoComplete="tel" placeholder="(555) 123-4567" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="website">Current website <span className="font-normal text-ink-muted">(if you have one)</span></Label>
              <Input id="website" name="website" type="url" autoComplete="url" inputMode="url" placeholder="https://www.example.com" />
            </div>

            <fieldset className="sm:col-span-2">
              <legend className="text-sm font-semibold text-ink">What do you need? <span aria-hidden="true" className="text-purple">*</span></legend>
              <div className="mt-3 flex flex-wrap gap-2.5">
                {serviceOptions.map((s) => {
                  const active = selected.includes(s);
                  return (
                    <button
                      type="button"
                      key={s}
                      onClick={() => toggleService(s)}
                      className={
                        `rounded-full px-4 py-2 text-sm font-medium transition-colors duration-150 ` +
                        (active
                          ? 'border border-transparent text-white'
                          : 'border border-black/10 bg-white text-ink-soft hover:border-black/20')
                      }
                      style={active ? { background: 'linear-gradient(115deg,#0071e3,#7c3aed,#ff375f)' } : undefined}
                      aria-pressed={active}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="sm:col-span-2">
              <Label htmlFor="budget">Estimated budget</Label>
              <Select id="budget" name="budget" defaultValue="">
                <option value="">Select a range…</option>
                {budgetOptions.map((b) => <option key={b} value={b}>{b}</option>)}
              </Select>
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="details">Tell us about your project <span aria-hidden="true" className="text-purple">*</span></Label>
              <Textarea id="details" name="details" required rows={5} placeholder="What does your business do? What are you hoping a new website will accomplish?" />
            </div>

            <div className="sm:col-span-2">
              {turnstileSiteKey ? (
                <div ref={turnstileHost} className="flex min-h-[65px] justify-center" aria-label="Security verification" />
              ) : (
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
                  Quote submissions are temporarily unavailable. Please email hi@trykaira.ai.
                </p>
              )}
            </div>
          </div>

          <Button type="submit" size="lg" className="mt-6 w-full" disabled={submitting || !turnstileSiteKey}>
            {submitting ? 'Sending…' : 'Send My Quote Request'}
          </Button>

          {status.msg && (
            <p
              role="status"
              aria-live="polite"
              className="mt-4 text-center text-sm font-medium"
              style={{ color: status.ok === null ? '#6e6e73' : status.ok ? '#34c759' : '#ff375f' }}
            >
              {status.msg}
            </p>
          )}
        </form>
      </section>
    </>
  );
}
