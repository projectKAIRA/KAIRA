import { Link } from 'react-router-dom';

const modules = [
  {
    kicker: 'DESIGN.CORE', title: 'Web Design & Development', tagline: "A website you're proud to send customers to.",
    a: '#0071e3', b: '#5ac8fa',
    points: [
      { t: 'Custom design', b: 'No cookie-cutter templates — every page is built for your business.' },
      { t: 'Mobile-first', b: 'Fluid layouts that feel great on any device your customers use.' },
      { t: 'Fast by default', b: 'Optimized images, lean code, and edge caching for sub-second loads.' },
      { t: 'Content help', b: "Not sure what to say? We'll write it with you — or for you." },
    ],
    stat: { n: '2–4', l: 'weeks · design → launch' },
  },
  {
    kicker: 'SEARCH.SYS', title: 'SEO Fundamentals', tagline: 'Built to be found by the customers searching for you.',
    a: '#7c3aed', b: '#a78bfa',
    points: [
      { t: 'Technical SEO', b: 'Semantic HTML, sitemaps, structured data, and Core Web Vitals.' },
      { t: 'Local visibility', b: 'Google Business Profile, local citations, review strategy.' },
      { t: 'On-page copy', b: 'Headings, meta, and content organized around real search intent.' },
      { t: 'Ongoing (optional)', b: 'Monthly content, tracking, and improvements — as far as you want to go.' },
    ],
    stat: { n: '95+', l: 'Lighthouse target on every page' },
  },
  {
    kicker: 'CARE.LOOP', title: 'Ongoing Maintenance', tagline: 'Your site stays secure, fresh, and up to date — hands-off.',
    a: '#ff375f', b: '#ff9500',
    points: [
      { t: 'Updates', b: 'Dependency updates, security patches, and platform upgrades.' },
      { t: 'Backups', b: 'Daily off-site backups so your site is never one accident away from gone.' },
      { t: 'Monitoring', b: '24/7 uptime + performance monitoring with alerts we act on.' },
      { t: 'Small changes', b: 'Content tweaks, image swaps, and quick copy updates included.' },
    ],
    stat: { n: '24/7', l: 'monitoring · we notice, then fix' },
  },
];

export default function Services() {
  return (
    <>
      <section className="mesh-bg">
        <div className="mx-auto max-w-3xl px-5 pb-12 pt-16 text-center md:pt-24">
          <p className="reveal hud-label mb-4">SERVICES · 3 MODULES</p>
          <h1 className="reveal-words text-4xl font-bold tracking-tight text-ink md:text-6xl">
            Everything you need. <span className="grad-text">Nothing you don't.</span>
          </h1>
          <p className="reveal reveal-delay-1 mt-4 text-lg text-ink-soft">
            Three focused services that work together: design, discovery, and durability.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 md:pb-28">
        <div className="space-y-24">
          {modules.map((m, i) => (
            <div key={m.title} className={`grid items-center gap-10 md:grid-cols-2 md:gap-14 ${i % 2 === 1 ? 'md:[&>*:first-child]:order-2' : ''}`}>
              <div className="reveal">
                <p className="hud-label mb-3" style={{ color: m.a }}>{m.kicker}</p>
                <h2
                  className="text-3xl font-bold leading-tight md:text-5xl"
                  style={{ background: `linear-gradient(115deg, ${m.a}, ${m.b})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}
                >
                  {m.title}
                </h2>
                <p className="mt-3 text-lg text-ink-soft">{m.tagline}</p>
                <ul className="mt-6 space-y-4">
                  {m.points.map((p) => (
                    <li key={p.t} className="flex gap-3">
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 flex-none rounded-full" style={{ background: `linear-gradient(135deg, ${m.a}, ${m.b})` }} />
                      <div><p className="font-semibold text-ink">{p.t}</p><p className="mt-0.5 text-sm text-ink-muted">{p.b}</p></div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="reveal reveal-delay-1">
                <div className="grad-border rounded-3xl p-6" style={{ '--tile-a': m.a, '--tile-b': m.b }}>
                  <div className="relative">
                    <div className="flex items-baseline justify-between border-b border-black/[0.06] pb-4 mb-4">
                      <span className="text-4xl font-bold tracking-tight" style={{ background: `linear-gradient(135deg, ${m.a}, ${m.b})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{m.stat.n}</span>
                    </div>
                    <p className="text-sm text-ink-muted">{m.stat.l}</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-24 text-center reveal">
          <p className="hud-label mb-3">NOT SURE WHAT YOU NEED?</p>
          <h3 className="text-2xl font-bold text-ink md:text-3xl">Start with a free 15-minute chat.</h3>
          <p className="mx-auto mt-3 max-w-lg text-ink-muted">
            Tell us where you are — we'll tell you honestly what would actually move the needle.
          </p>
          <Link
            to="/contact"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#1d1d1f] px-7 py-3 text-sm font-semibold text-white shadow-cta transition-transform duration-150 ease-press hover:scale-[1.03] active:scale-[0.98]"
          >
            Get a Free Quote
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </Link>
        </div>
      </section>
    </>
  );
}
