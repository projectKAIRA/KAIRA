import { Link } from 'react-router-dom';

const tiers = [
  {
    name: 'Website Build', price: 'From $1,000', cadence: 'one-time project',
    blurb: 'A complete, custom professional website. Final pricing depends on scope — pages, features, and content.',
    a: '#0071e3', b: '#5ac8fa',
    bullets: [
      'Custom mobile-first design', 'Fast, accessible, SEO-friendly build',
      '1 round of revisions', 'Launch coordination + basic training',
    ],
  },
  {
    name: 'Care Plan', price: 'From $75/mo', cadence: 'monthly maintenance', featured: true,
    blurb: 'Keep your site secure, updated, and fresh — we handle the technical side so you never have to.',
    a: '#7c3aed', b: '#a78bfa',
    bullets: [
      'Software + security updates', 'Daily backups + 24/7 monitoring',
      'Small content updates', 'Priority support',
    ],
  },
  {
    name: 'SEO Boost', price: 'Custom', cadence: 'monthly engagement',
    blurb: 'Ongoing local SEO to climb search results and bring in more nearby customers over time.',
    a: '#ff375f', b: '#ff9500',
    bullets: [
      'Keyword + competitor research', 'On-page + technical SEO',
      'Local + Google Business Profile', 'Monthly reporting',
    ],
  },
];

export default function Pricing() {
  return (
    <>
      <section className="mesh-bg">
        <div className="mx-auto max-w-3xl px-5 pb-12 pt-16 text-center md:pt-24">
          <p className="reveal hud-label mb-4">PRICING · TRANSPARENT</p>
          <h1 className="reveal-words text-4xl font-bold tracking-tight text-ink md:text-6xl">
            No mystery. <span className="grad-text">Just numbers.</span>
          </h1>
          <p className="reveal reveal-delay-1 mt-4 text-lg text-ink-soft">
            Straightforward pricing so you know what you're getting into before we ever start.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 md:pb-28">
        <div className="grid gap-6 md:grid-cols-3">
          {tiers.map((t, i) => (
            <div key={t.name} className={`reveal reveal-delay-${i} grad-border relative flex flex-col rounded-2xl p-8 ${t.featured ? 'md:-my-4' : ''}`} style={{ '--tile-a': t.a, '--tile-b': t.b }}>
              {t.featured && (
                <span className="absolute right-4 top-4 rounded-full border border-black/10 bg-white/90 px-3 py-1 text-[10px] font-semibold tracking-[0.16em] text-ink backdrop-blur">MOST POPULAR</span>
              )}
              <p className="hud-label" style={{ color: t.a }}>TIER · 0{i + 1}</p>
              <h2 className="mt-2 text-2xl font-bold text-ink">{t.name}</h2>
              <p className="mt-1 text-xs text-ink-muted">{t.cadence}</p>
              <p className="mt-6 text-4xl font-bold tracking-tight" style={{ background: `linear-gradient(115deg, ${t.a}, ${t.b})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{t.price}</p>
              <p className="mt-4 text-sm text-ink-muted">{t.blurb}</p>
              <ul className="mt-6 space-y-3">
                {t.bullets.map((b) => (
                  <li key={b} className="flex gap-2 text-sm text-ink-soft">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={t.a} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-none"><polyline points="20 6 9 17 4 12" /></svg>
                    {b}
                  </li>
                ))}
              </ul>
              <Link
                to="/contact"
                className={`relative mt-8 rounded-full px-6 py-3 text-center text-sm font-semibold transition-transform duration-150 ease-press hover:scale-[1.02] active:scale-[0.98] ${t.featured ? 'text-white shadow-cta bg-[#1d1d1f]' : 'border border-black/10 bg-white text-ink hover:bg-black/[0.03]'}`}
              >
                {t.featured ? 'Get Started' : 'Learn More'}
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-16 rounded-2xl border border-black/[0.05] bg-white/70 p-8 text-center reveal">
          <p className="hud-label">HAVE A QUESTION?</p>
          <h3 className="mt-2 text-2xl font-bold text-ink md:text-3xl">Every business is different.</h3>
          <p className="mx-auto mt-3 max-w-lg text-ink-muted">Reach out and we'll put together an honest quote based on what you actually need.</p>
          <Link to="/contact" className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#1d1d1f] px-7 py-3 text-sm font-semibold text-white shadow-cta transition-transform duration-150 ease-press hover:scale-[1.03] active:scale-[0.98]">
            Talk to Us
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </Link>
        </div>
      </section>
    </>
  );
}
