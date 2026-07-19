import { Link } from 'react-router-dom';

const projects = [
  { name: 'Harbor & Vine', category: 'Waterfront restaurant · Portland, ME', tags: ['Web Design','Local SEO','Mobile-First'], mock: 'restaurant', accent: '#ff9500' },
  { name: 'Summit Physical Therapy', category: 'Sports rehab clinic · Boulder, CO', tags: ['Web Design','SEO Structure','Accessibility'], mock: 'clinic', accent: '#0071e3' },
  { name: 'Brightside Cleaning Co.', category: 'Home cleaning · Austin, TX', tags: ['Web Design','Lead Generation','Speed'], mock: 'cleaning', accent: '#34c759' },
  { name: 'Oak & Iron Barbershop', category: 'Independent barbershop · Nashville, TN', tags: ['Web Design','Branding','Booking'], mock: 'barber', accent: '#ff375f' },
];

const panelBg = {
  restaurant: 'radial-gradient(60% 50% at 20% 15%, rgba(255,149,0,0.14), transparent 65%), radial-gradient(60% 50% at 90% 90%, rgba(194,65,12,0.10), transparent 65%), linear-gradient(160deg, #fff7ed 0%, #fffbf5 100%)',
  clinic:     'radial-gradient(60% 50% at 20% 15%, rgba(0,113,227,0.14), transparent 65%), radial-gradient(60% 50% at 90% 90%, rgba(90,200,250,0.14), transparent 65%), linear-gradient(160deg, #eff6ff 0%, #f5faff 100%)',
  cleaning:   'radial-gradient(60% 50% at 20% 15%, rgba(52,199,89,0.16), transparent 65%), radial-gradient(60% 50% at 90% 90%, rgba(90,200,250,0.10), transparent 65%), linear-gradient(160deg, #f0fdf4 0%, #f5fdf7 100%)',
  barber:     'radial-gradient(60% 50% at 20% 15%, rgba(255,55,95,0.14), transparent 65%), radial-gradient(60% 50% at 90% 90%, rgba(124,58,237,0.10), transparent 65%), linear-gradient(160deg, #fff5f7 0%, #fff9fb 100%)',
};

export default function Portfolio() {
  return (
    <>
      <section className="mesh-bg">
        <div className="mx-auto max-w-3xl px-5 pb-12 pt-16 text-center md:pt-24">
          <p className="reveal hud-label mb-4">PORTFOLIO · 4 CONCEPTS</p>
          <h1 className="reveal-words text-4xl font-bold tracking-tight text-ink md:text-6xl">
            Work that <span className="grad-text">works the room.</span>
          </h1>
          <p className="reveal reveal-delay-1 mt-4 text-lg text-ink-soft">
            A preview of the kind of sites we build for local businesses — clean, fast, and easy for real customers to use.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 md:pb-28">
        <div className="grid gap-8 md:grid-cols-2">
          {projects.map((p, i) => (
            <article key={p.name} className={`reveal reveal-delay-${i % 2} glass overflow-hidden rounded-2xl transition-transform duration-300 ease-enter hover:-translate-y-1.5`}>
              <div className="relative rounded-3xl border border-black/[0.05] p-6 sm:p-8" style={{ background: panelBg[p.mock] }} aria-hidden="true">
                <span className="absolute right-4 top-4 z-[1] rounded-full border border-black/10 bg-white/85 px-3 py-1 text-[11px] font-semibold tracking-wide text-ink backdrop-blur">CONCEPT PROJECT</span>
                <div className="animate-float relative mx-auto max-w-sm overflow-hidden rounded-xl border border-black/[0.06] bg-white shadow-[0_18px_36px_-14px_rgba(15,23,42,0.20),0_6px_16px_-8px_rgba(15,23,42,0.14)]" style={{ animationDelay: `${i * -1.6}s` }}>
                  <div className="flex items-center gap-1.5 border-b border-black/[0.05] bg-[#f5f5f7] px-3 py-2">
                    <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
                    <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
                    <span className="h-2 w-2 rounded-full bg-[#28c840]" />
                    <span className="ml-2 h-3.5 flex-1 rounded-full border border-black/[0.06] bg-white px-2 text-[7px] leading-[14px] text-ink-muted font-mono">{p.name.toLowerCase().replace(/[^a-z]/g, '')}.com</span>
                  </div>
                  <div className="p-4">
                    {p.mock === 'restaurant' && (
                      <div>
                        <div className="mb-3 h-16 rounded-md" style={{ background: `linear-gradient(160deg, ${p.accent}, #7c2d12 60%, #451a03)`, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)' }} />
                        <p className="text-[8px] tracking-[0.2em] uppercase font-bold" style={{ color: p.accent }}>Waterfront dining</p>
                        <p className="mt-1 text-[13px] font-bold leading-tight text-ink" style={{ fontFamily: 'Georgia, serif' }}>Coastal plates, <em style={{ color: p.accent }}>golden-hour</em> views.</p>
                        <div className="mt-3 space-y-1">
                          <div className="flex items-baseline gap-1 text-[8px] text-ink-soft"><span>Seared dayboat scallops</span><span className="flex-1 border-b border-dotted border-black/15" /><b className="text-ink font-bold">$24</b></div>
                          <div className="flex items-baseline gap-1 text-[8px] text-ink-soft"><span>Charred octopus &amp; tomato</span><span className="flex-1 border-b border-dotted border-black/15" /><b className="text-ink font-bold">$19</b></div>
                          <div className="flex items-baseline gap-1 text-[8px] text-ink-soft"><span>Harbor burger, smoked aioli</span><span className="flex-1 border-b border-dotted border-black/15" /><b className="text-ink font-bold">$16</b></div>
                        </div>
                        <div className="mt-3 inline-block rounded-full bg-ink px-3 py-1 text-[8px] font-bold text-white">Reserve a table</div>
                      </div>
                    )}
                    {p.mock === 'clinic' && (
                      <div>
                        <p className="text-[8px] tracking-[0.2em] uppercase font-bold" style={{ color: p.accent }}>Physical therapy</p>
                        <p className="mt-1 text-[13px] font-bold leading-tight text-ink">Move better. <span style={{ color: p.accent }}>Live better.</span></p>
                        <div className="mt-3 flex gap-1.5">
                          <span className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[7px] text-ink-soft">Sports rehab</span>
                          <span className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[7px] text-ink-soft">Post-op</span>
                          <span className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[7px] text-ink-soft">Chronic pain</span>
                        </div>
                        <div className="mt-3 rounded-lg border border-black/[0.06] bg-[#eff6ff] p-2">
                          <p className="text-[7px] text-ink-muted font-bold tracking-wider">NEXT AVAILABLE</p>
                          <p className="text-[10px] font-semibold text-ink">Tomorrow, 9:40 AM — Dr. Reyes</p>
                        </div>
                        <div className="mt-2.5 flex gap-1">
                          <span className="rounded px-2 py-0.5 text-[7px] font-semibold border" style={{ color: p.accent, borderColor: `${p.accent}30` }}>Sat 8:00</span>
                          <span className="rounded px-2 py-0.5 text-[7px] font-semibold text-white" style={{ background: p.accent }}>Mon 9:40</span>
                          <span className="rounded px-2 py-0.5 text-[7px] font-semibold border" style={{ color: p.accent, borderColor: `${p.accent}30` }}>Mon 2:15</span>
                        </div>
                      </div>
                    )}
                    {p.mock === 'cleaning' && (
                      <div>
                        <p className="text-[8px] tracking-[0.2em] uppercase font-bold" style={{ color: p.accent }}>Home cleaning</p>
                        <p className="mt-1 text-[14px] font-bold leading-tight text-ink">A spotless home by <span style={{ color: p.accent }}>Friday</span>.</p>
                        <div className="mt-3 space-y-1.5">
                          <div className="rounded-md border border-black/[0.08] bg-white px-2 py-1.5 text-[8px] text-ink-muted">Your ZIP code</div>
                          <div className="rounded-md border border-black/[0.08] bg-white px-2 py-1.5 text-[8px] text-ink-muted">Home size — 3 bed / 2 bath</div>
                        </div>
                        <div className="mt-2.5 inline-block rounded-full px-3 py-1 text-[9px] font-bold text-white" style={{ background: p.accent, boxShadow: `0 6px 14px -4px ${p.accent}55` }}>Get an instant quote</div>
                        <p className="mt-2 text-[7px]" style={{ color: p.accent }}>★★★★★ <span className="text-ink-muted">4.9 — 210+ local homes cleaned</span></p>
                      </div>
                    )}
                    {p.mock === 'barber' && (
                      <div>
                        <p className="text-[8px] tracking-[0.2em] uppercase font-bold" style={{ color: p.accent }}>Est. 2026</p>
                        <p className="mt-1 text-[14px] font-bold leading-tight text-ink" style={{ fontFamily: 'Georgia, serif' }}>Classic cuts. <em style={{ color: p.accent }}>Modern craft.</em></p>
                        <div className="mt-3 space-y-1 rounded-md border border-black/[0.06] bg-[#fafafa] p-2">
                          <div className="flex justify-between text-[8px] text-ink-soft"><span>Skin fade + hot towel</span><b className="text-ink font-bold">$38</b></div>
                          <div className="flex justify-between text-[8px] text-ink-soft"><span>Beard sculpt &amp; line-up</span><b className="text-ink font-bold">$22</b></div>
                          <div className="flex justify-between text-[8px] font-bold" style={{ color: p.accent }}><span>The full works</span><span>$55</span></div>
                        </div>
                        <div className="mt-3 block rounded-md px-3 py-1.5 text-center text-[9px] font-bold text-white" style={{ background: p.accent, boxShadow: `0 6px 14px -4px ${p.accent}55` }}>Book a chair →</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="p-6 sm:p-8">
                <p className="text-xs uppercase tracking-widest text-ink-muted">{p.category}</p>
                <h3 className="mt-2 text-2xl font-bold text-ink">{p.name}</h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  {p.tags.map((t) => (
                    <span key={t} className="rounded-full border border-black/10 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-ink-soft">{t}</span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-16 rounded-2xl border border-black/[0.05] bg-white/70 p-8 text-center reveal shadow-[0_10px_30px_-18px_rgba(15,23,42,0.15)]">
          <p className="hud-label">READY WHEN YOU ARE</p>
          <h3 className="mt-2 text-2xl font-bold text-ink md:text-3xl">Your project could be the next one here.</h3>
          <p className="mx-auto mt-3 max-w-lg text-ink-muted">Concepts on this page are illustrative. Every real Kaira site is custom-built for the business it serves.</p>
          <Link to="/contact" className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#1d1d1f] px-7 py-3 text-sm font-semibold text-white shadow-cta transition-transform duration-150 ease-press hover:scale-[1.03] active:scale-[0.98]">
            Start Your Project
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </Link>
        </div>
      </section>
    </>
  );
}
