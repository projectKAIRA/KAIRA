import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './home.css';

const marquee = ['Cafés','Barbershops','Dentists','Plumbers','Bakeries','Realtors','Studios','Salons','Roofers','Boutiques','Law Firms','Gyms','Contractors','Clinics','Florists'];
const stats = [
  { n: 1000, prefix: '$', l: 'Websites from' },
  { n: 0.4,  suffix: 's',  decimals: 1, l: 'Median load time' },
  { n: 95,   suffix: '+',  l: 'Lighthouse scores' },
  { n: 24,   suffix: '/7', l: 'Care & monitoring' },
];
const tiles = [
  { name: 'Websites',  tag: 'Custom. Considered. Quick.', body: 'Mobile-first sites built like products — sharp typography, buttery motion, and copy that turns visitors into customers.', a: '#0071e3', b: '#5ac8fa' },
  { name: 'Local SEO', tag: 'Findable, from day one.',    body: 'Technical foundations, clean structure, and local search signals so the right customers land on the right page.',   a: '#34c759', b: '#a7f3d0' },
  { name: 'Care Plans',tag: 'Set it and forget it.',      body: 'Updates, security, backups, monitoring, and content tweaks handled monthly — from $75.',                              a: '#ff375f', b: '#ffb37a' },
];
const steps = [
  { n: '01', title: 'Discovery',      body: 'A friendly call to understand your business, customers, and what a win looks like.' },
  { n: '02', title: 'Design & Build', body: 'We design, build, and share progress along the way. No surprises, no jargon.' },
  { n: '03', title: 'Launch',         body: 'Your site goes live — fast, polished, and ready to be found on Google.' },
  { n: '04', title: 'Grow',           body: 'Optional SEO and care plans keep improving your site month after month.' },
];

// ---------------- Utilities: Count-up, Bento activate, Tilt ----------------
function CountUp({ target, decimals = 0, suffix = '' }) {
  const ref = useRef(null);
  const [text, setText] = useState(() => {
    if (decimals === 0 && target >= 1000) return '0';
    return (0).toFixed(decimals);
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.disconnect();
        const start = performance.now();
        const dur = 1400;
        const ease = (t) => 1 - Math.pow(1 - t, 3);
        const step = (now) => {
          const t = Math.min(1, (now - start) / dur);
          const v = target * ease(t);
          const formatted = decimals === 0 && target >= 1000
            ? Math.round(v).toLocaleString('en-US')
            : v.toFixed(decimals);
          setText(formatted);
          if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [target, decimals]);
  return <span ref={ref} className="count">{text}{suffix}</span>;
}

function useBentoActive(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          el.classList.add('is-active');
          const gauge = el.querySelector('.gauge-fill');
          if (gauge) gauge.style.strokeDashoffset = '8';
          obs.unobserve(el);
        }
      }
    }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}

// Tilt effect for the hero frame
function useTilt(ref, baseRX = 4, baseRY = -6, strength = 8) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(1200px) rotateX(${(baseRX + -y * strength).toFixed(2)}deg) rotateY(${(baseRY + x * strength).toFixed(2)}deg) translateZ(0)`;
    };
    const leave = () => { el.style.transform = `rotateX(${baseRX}deg) rotateY(${baseRY}deg)`; };
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    return () => {
      el.removeEventListener('mousemove', move);
      el.removeEventListener('mouseleave', leave);
    };
  }, [ref, baseRX, baseRY, strength]);
}

// Cursor spotlight in the hero
function useSpotlight(hostRef, spotRef) {
  useEffect(() => {
    const host = hostRef.current, spot = spotRef.current;
    if (!host || !spot) return;
    const move = (e) => {
      const r = host.getBoundingClientRect();
      spot.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      spot.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    };
    host.addEventListener('pointermove', move, { passive: true });
    return () => host.removeEventListener('pointermove', move);
  }, [hostRef, spotRef]);
}

// Magnetic CTA
function MagneticButton({ to, children, ...rest }) {
  const ref = useRef(null);
  const innerRef = useRef(null);
  useEffect(() => {
    const el = ref.current, inner = innerRef.current;
    if (!el || !inner) return;
    const RANGE = 90, STRENGTH = 0.35;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      if (Math.hypot(dx, dy) > RANGE) {
        inner.style.setProperty('--mx', '0px');
        inner.style.setProperty('--my', '0px');
        return;
      }
      inner.style.setProperty('--mx', (dx * STRENGTH).toFixed(2) + 'px');
      inner.style.setProperty('--my', (dy * STRENGTH).toFixed(2) + 'px');
    };
    const reset = () => {
      inner.style.setProperty('--mx', '0px');
      inner.style.setProperty('--my', '0px');
    };
    window.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('pointerleave', reset);
    return () => {
      window.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', reset);
    };
  }, []);
  return (
    <Link ref={ref} to={to} className="k-btn k-btn-primary k-magnetic" {...rest}>
      <span ref={innerRef} className="k-mag-inner">{children}</span>
    </Link>
  );
}

// Hero showcase rotator (3 fake client sites)
function HeroShowcase() {
  const [i, setI] = useState(0);
  const frameRef = useRef(null);
  useTilt(frameRef, 4, -6, 8);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % 3), 3800);
    return () => clearInterval(id);
  }, []);
  const urls = ['bellascafe.com', 'ridgelinedental.com', 'oakandiron.co'];
  return (
    <div className="k-showcase reveal reveal-delay-2" data-testid="hero-showcase">
      <div className="k-showcase-glow" aria-hidden="true" />
      <div className="k-float k-float-a" aria-hidden="true"><div className="score">98</div><div className="score-label">Lighthouse<br />Performance</div></div>
      <div className="k-float k-float-b" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
        <div><b>0.4s</b><span>First paint</span></div>
      </div>
      <div className="k-float k-float-c" aria-hidden="true">
        <div className="pill-tag">SEO</div>
        <div><b>#1</b><span>on Google Maps</span></div>
      </div>

      <div className="k-frame" ref={frameRef}>
        <div className="k-window-bar" aria-hidden="true">
          <span className="dot d-r" /><span className="dot d-y" /><span className="dot d-g" />
          <div className="k-url">{urls[i]}</div>
        </div>
        <div className="k-frame-body">
          {/* Café */}
          <div className={`k-slide ${i === 0 ? 'is-active' : ''}`}>
            <div className="cafe">
              <div className="cafe-nav">
                <span className="cafe-logo">bella's</span>
                <span className="cafe-links"><i>Menu</i><i>Story</i><i>Visit</i></span>
                <span className="cafe-cta">Reserve</span>
              </div>
              <div className="cafe-hero">
                <div className="cafe-hero-img" />
                <div className="cafe-hero-copy">
                  <p className="cafe-eyebrow">Est. 2012 · Portland, OR</p>
                  <h4 className="cafe-title">Slow mornings, <em>strong espresso.</em></h4>
                  <p className="cafe-sub">House-roasted beans, warm sourdough, and a pastry case that never disappoints.</p>
                  <div className="cafe-btns"><span className="cafe-btn primary">Order online</span><span className="cafe-btn ghost">View menu →</span></div>
                </div>
              </div>
              <div className="cafe-menu">
                <div className="cafe-menu-item"><span>Cortado</span><span className="dots" /><b>$4</b></div>
                <div className="cafe-menu-item"><span>Almond croissant</span><span className="dots" /><b>$5</b></div>
                <div className="cafe-menu-item"><span>Avocado toast</span><span className="dots" /><b>$12</b></div>
              </div>
            </div>
          </div>
          {/* Dental */}
          <div className={`k-slide ${i === 1 ? 'is-active' : ''}`}>
            <div className="dental">
              <div className="dental-nav">
                <span className="dental-logo"><span className="dl-dot" /> Ridgeline</span>
                <span className="dental-links"><i>Services</i><i>Team</i><i>New patients</i></span>
                <span className="dental-cta">Book visit</span>
              </div>
              <div>
                <h4 className="dental-title">Modern dentistry, <span>zero anxiety.</span></h4>
                <p className="dental-sub">Same-day crowns · Emergency care · Weekend hours</p>
                <div className="dental-card">
                  <div className="dental-card-head"><span className="dc-badge">Next available</span><span className="dc-time">Tomorrow · 9:40 AM</span></div>
                  <div className="dental-card-body">
                    <span className="dc-pill">Sat 8:00</span>
                    <span className="dc-pill">Sat 10:30</span>
                    <span className="dc-pill active">Mon 9:40</span>
                    <span className="dc-pill">Mon 2:15</span>
                  </div>
                  <div className="dental-book">Book instantly →</div>
                </div>
                <div className="dental-stats">
                  <div><b>4.9★</b><span>642 reviews</span></div>
                  <div><b>12yr</b><span>in the neighborhood</span></div>
                  <div><b>$0</b><span>emergency exams</span></div>
                </div>
              </div>
            </div>
          </div>
          {/* Barber */}
          <div className={`k-slide ${i === 2 ? 'is-active' : ''}`}>
            <div className="barber">
              <div className="barber-nav">
                <span className="barber-logo">OAK &amp; IRON</span>
                <span className="barber-links"><i>Menu</i><i>Book</i><i>Shop</i></span>
                <span className="barber-cta">Book chair</span>
              </div>
              <div>
                <h4 className="barber-title">Classic cuts. <em>Modern craft.</em></h4>
                <p className="barber-sub">Six chairs. Twenty-three years. One neighborhood.</p>
                <div className="barber-services">
                  <div className="barber-item"><span>Skin fade + hot towel</span><b>$38</b></div>
                  <div className="barber-item"><span>Beard sculpt &amp; line-up</span><b>$22</b></div>
                  <div className="barber-item highlight"><span>The full works</span><b>$55</b></div>
                </div>
                <div className="barber-cta-big">Reserve a chair →</div>
              </div>
            </div>
          </div>
        </div>
        <div className="k-frame-dots" aria-hidden="true">
          {[0,1,2].map((n) => <span key={n} className={`d ${i === n ? 'is-active' : ''}`} />)}
        </div>
      </div>
    </div>
  );
}

// -------------------------------- Page --------------------------------
export default function Home() {
  const heroRef = useRef(null);
  const spotRef = useRef(null);
  useSpotlight(heroRef, spotRef);

  const speedRef = useRef(null), careRef = useRef(null);
  useBentoActive(speedRef);
  useBentoActive(careRef);

  return (
    <div className="kaira-landing" data-testid="landing-root">
      {/* HERO */}
      <section className="k-hero" ref={heroRef} data-testid="hero-section">
        <div className="k-hero-bg" aria-hidden="true">
          <div className="blob blob-a" />
          <div className="blob blob-b" />
          <div className="blob blob-c" />
          <div className="grid-mask" />
          <div className="k-spotlight" ref={spotRef} />
        </div>

        <div className="k-container k-hero-grid">
          <div className="k-hero-copy">
            <p className="k-eyebrow reveal" data-testid="hero-eyebrow">
              <span className="k-dot" /> Now booking Spring '26 projects
            </p>
            <h1 className="k-h1 reveal-words" data-testid="hero-title">
              Websites that make your business look <span className="grad-text">inevitable.</span>
            </h1>
            <p className="k-lead reveal reveal-delay-2" data-testid="hero-lead">
              Beautifully simple, ridiculously fast websites for local businesses —
              designed, built, and cared for by people who obsess over the details.
            </p>
            <div className="k-cta reveal reveal-delay-3">
              <MagneticButton to="/contact" data-testid="hero-cta-primary">
                Get a free quote
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </MagneticButton>
              <Link to="/portfolio" className="k-btn k-btn-ghost" data-testid="hero-cta-secondary">See our work</Link>
            </div>
            <p className="k-note reveal reveal-delay-3" data-testid="hero-note">
              From $1,000 · Care plans from $75/mo · Reply within 1 business day
            </p>
          </div>
          <HeroShowcase />
        </div>
      </section>

      {/* MARQUEE */}
      <section className="k-marquee" aria-label="Businesses we build for" data-testid="marquee-section">
        <p className="k-tiny">Loved by main street. Built for main street.</p>
        <div className="k-marquee-track" aria-hidden="true">
          {[...marquee, ...marquee].map((m, idx) => (
            <span key={idx} className="k-marquee-item">{m}<span className="dotSep">·</span></span>
          ))}
        </div>
      </section>

      {/* BENTO */}
      <section className="k-bento" aria-label="What makes a Kaira site" data-testid="bento-section">
        <div className="k-container">
          <p className="k-kicker reveal">Under the hood</p>
          <h2 className="k-h2 reveal-words">Every site ships with <span className="grad-text">the whole package.</span></h2>

          <div className="k-bento-grid">
            <div className="bt bt-speed reveal" ref={speedRef} data-testid="bento-speed">
              <div className="bt-head">
                <span className="bt-eyebrow">Speed</span>
                <h3>Sub-second by default.</h3>
                <p>Every page ships with image compression, code-splitting, and edge caching baked in.</p>
              </div>
              <div className="bt-gauge" aria-hidden="true">
                <svg viewBox="0 0 200 120">
                  <defs>
                    <linearGradient id="gauge-g" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stopColor="#ff375f"/>
                      <stop offset="0.5" stopColor="#ff9500"/>
                      <stop offset="1" stopColor="#34c759"/>
                    </linearGradient>
                  </defs>
                  <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#e5e5ea" strokeWidth="14" fill="none" strokeLinecap="round"/>
                  <path className="gauge-fill" d="M 20 100 A 80 80 0 0 1 180 100" stroke="url(#gauge-g)" strokeWidth="14" fill="none" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset="100"/>
                </svg>
                <div className="gauge-value"><b>0.4s</b><span>First paint</span></div>
              </div>
            </div>

            <div className="bt bt-map reveal reveal-delay-1" data-testid="bento-seo">
              <span className="bt-eyebrow">Local SEO</span>
              <h3>Show up on the map.</h3>
              <div className="bt-map-art" aria-hidden="true">
                <div className="map-grid" />
                <div className="map-pin"><span/></div>
                <div className="map-pulse" />
              </div>
            </div>

            <div className="bt bt-care reveal reveal-delay-2" ref={careRef} data-testid="bento-care">
              <span className="bt-eyebrow">Care</span>
              <h3>Sleeps, so you don't have to.</h3>
              <div className="bt-shield" aria-hidden="true">
                <svg viewBox="0 0 120 140" fill="none">
                  <defs>
                    <linearGradient id="shield-g" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#0071e3"/>
                      <stop offset="1" stopColor="#7c3aed"/>
                    </linearGradient>
                  </defs>
                  <path d="M60 8 L108 28 V72 C108 100 87 122 60 132 C33 122 12 100 12 72 V28 Z" fill="url(#shield-g)" fillOpacity="0.12" stroke="url(#shield-g)" strokeWidth="2"/>
                  <path className="check" d="M40 70 L55 85 L82 55" stroke="url(#shield-g)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" pathLength="100" strokeDasharray="100" strokeDashoffset="100"/>
                </svg>
              </div>
              <p className="bt-foot">Updates · Backups · Monitoring · Support</p>
            </div>

            <div className="bt bt-devices reveal" data-testid="bento-devices">
              <div className="bt-devices-art" aria-hidden="true">
                <div className="dev-laptop"><div className="dev-screen"/><div className="dev-hinge"/></div>
                <div className="dev-phone" />
              </div>
              <span className="bt-eyebrow">Every screen</span>
              <h3>Looks sharp phone to widescreen.</h3>
            </div>

            <div className="bt bt-palette reveal reveal-delay-1" data-testid="bento-design">
              <span className="bt-eyebrow">Custom design</span>
              <h3>No cookie-cutter templates.</h3>
              <div className="bt-swatches" aria-hidden="true">
                <div className="sw" style={{ background: '#0071e3' }} />
                <div className="sw" style={{ background: '#7c3aed' }} />
                <div className="sw" style={{ background: '#ff375f' }} />
                <div className="sw" style={{ background: '#34c759' }} />
                <div className="sw" style={{ background: '#ff9500' }} />
                <div className="sw" style={{ background: '#1d1d1f' }} />
              </div>
            </div>

            <div className="bt bt-turn reveal reveal-delay-2" data-testid="bento-turnaround">
              <span className="bt-eyebrow">Turnaround</span>
              <h3><span className="grad-text stat-num"><CountUp target={14} suffix=" days" /></span></h3>
              <p>Typical time from kickoff to a live, indexable site.</p>
              <div className="bt-timeline" aria-hidden="true">
                <span/><span/><span/><span/>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* STATEMENT */}
      <section className="k-statement" data-testid="statement-section">
        <div className="k-container narrow">
          <h2 className="k-h2 reveal-words">Your storefront never sleeps. <span className="grad-text">Make it worth showing up to.</span></h2>
          <p className="k-sub reveal">72% of local customers check your website before they visit. We make sure the first impression is the one that closes the deal.</p>
        </div>
      </section>

      {/* STATS */}
      <section className="k-stats" data-testid="stats-section">
        <div className="k-container">
          <div className="k-stats-grid">
            {stats.map((s, i) => (
              <div key={i} className={`k-stat reveal reveal-delay-${Math.min(i, 3)}`} data-testid={`stat-${i}`}>
                <p className="n">
                  {s.prefix && <span className="pfx">{s.prefix}</span>}
                  <CountUp target={s.n} decimals={s.decimals ?? 0} suffix={s.suffix ?? ''} />
                </p>
                <p className="l">{s.l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAMILY */}
      <section className="k-family" aria-labelledby="family-heading" data-testid="family-section">
        <div className="k-container">
          <p className="k-kicker reveal">The Kaira family</p>
          <h2 id="family-heading" className="k-h2 reveal-words">Three services. <span className="grad-text">One quiet obsession.</span></h2>
          <p className="k-sub reveal">Websites, SEO, and care — designed to work together so your business shows up, stands out, and keeps improving.</p>

          <div className="k-family-grid">
            {tiles.map((t, i) => (
              <Link key={t.name} to="/services" className={`k-tile reveal reveal-delay-${Math.min(i, 3)}`} style={{ '--a': t.a, '--b': t.b }} data-testid={`tile-${t.name.toLowerCase().replace(' ','-')}`}>
                <div className="k-tile-art" aria-hidden="true">
                  {t.name === 'Websites' && (
                    <svg viewBox="0 0 200 140" fill="none">
                      <defs><linearGradient id="wg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={t.a}/><stop offset="1" stopColor={t.b}/></linearGradient></defs>
                      <rect x="20" y="18" width="160" height="104" rx="14" fill="url(#wg1)" fillOpacity="0.15" stroke="url(#wg1)" strokeWidth="1.5"/>
                      <rect x="20" y="18" width="160" height="18" rx="14" fill="url(#wg1)" fillOpacity="0.28"/>
                      <rect x="34" y="50" width="90" height="8" rx="4" fill="url(#wg1)"/>
                      <rect x="34" y="66" width="130" height="4" rx="2" fill="url(#wg1)" fillOpacity="0.6"/>
                      <rect x="34" y="76" width="110" height="4" rx="2" fill="url(#wg1)" fillOpacity="0.4"/>
                      <rect x="34" y="92" width="40" height="14" rx="7" fill="url(#wg1)"/>
                    </svg>
                  )}
                  {t.name === 'Local SEO' && (
                    <svg viewBox="0 0 200 140" fill="none">
                      <defs><linearGradient id="wg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={t.a}/><stop offset="1" stopColor={t.b}/></linearGradient></defs>
                      <circle cx="100" cy="70" r="46" stroke="url(#wg2)" strokeWidth="1.5" fill="url(#wg2)" fillOpacity="0.08"/>
                      <ellipse cx="100" cy="70" rx="46" ry="20" stroke="url(#wg2)" strokeWidth="1.5" fill="none"/>
                      <ellipse cx="100" cy="70" rx="20" ry="46" stroke="url(#wg2)" strokeWidth="1.5" fill="none"/>
                      <circle cx="100" cy="70" r="6" fill="url(#wg2)"/>
                      <g transform="translate(138,32)">
                        <path d="M0 14 C0 6, 6 0, 14 0 C22 0, 28 6, 28 14 C28 24, 14 34, 14 34 S0 24, 0 14 Z" fill="url(#wg2)"/>
                        <circle cx="14" cy="14" r="5" fill="#fff"/>
                      </g>
                    </svg>
                  )}
                  {t.name === 'Care Plans' && (
                    <svg viewBox="0 0 200 140" fill="none">
                      <defs><linearGradient id="wg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={t.a}/><stop offset="1" stopColor={t.b}/></linearGradient></defs>
                      <path d="M100 25 L140 45 V80 C140 100 122 115 100 120 C78 115 60 100 60 80 V45 Z" fill="url(#wg3)" fillOpacity="0.14" stroke="url(#wg3)" strokeWidth="1.5"/>
                      <path d="M82 78 L95 91 L120 66" stroke="url(#wg3)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <p className="k-tile-tag">{t.tag}</p>
                <h3 className="k-tile-name" style={{ background: `linear-gradient(120deg, ${t.a}, ${t.b})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{t.name}</h3>
                <p className="k-tile-body">{t.body}</p>
                <span className="k-tile-more">
                  Learn more
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* PROCESS */}
      <section className="k-process" data-testid="process-section">
        <div className="k-container">
          <p className="k-kicker reveal">How it works</p>
          <h2 className="k-h2 reveal-words">Four steps. <span className="grad-text">Zero surprises.</span></h2>
          <ol className="k-steps">
            {steps.map((s, i) => (
              <li key={s.n} className={`k-step reveal reveal-delay-${Math.min(i, 3)}`} data-testid={`step-${s.n}`}>
                <div className="k-step-num">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="k-timeline reveal">Typical timeline · <b>2–4 weeks from kickoff to launch</b></p>
        </div>
      </section>

      {/* PRICE */}
      <section className="k-price" data-testid="price-section">
        <div className="k-container narrow">
          <div className="k-price-card reveal">
            <div>
              <p className="k-tiny">Starting from</p>
              <p className="k-price-big">$1,000<span>/site</span></p>
              <p className="k-price-sub">Plus care from $75/mo. Custom pricing for SEO.</p>
            </div>
            <Link to="/pricing" className="k-btn k-btn-primary" data-testid="price-cta">
              See pricing
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </Link>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="k-final" data-testid="final-cta">
        <div className="k-final-bg" aria-hidden="true">
          <div className="blob blob-a" />
          <div className="blob blob-c" />
        </div>
        <div className="k-container">
          <h2 className="k-h2 reveal-words">Ready to look like the biggest <span className="grad-text">small business in town?</span></h2>
          <p className="k-sub reveal">Tell us about your business. We'll come back with a free, no-pressure quote within one business day.</p>
          <Link to="/contact" className="k-btn k-btn-primary large reveal reveal-delay-2" data-testid="final-cta-btn">
            Start your quote
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </Link>
          <p className="k-tiny reveal reveal-delay-3">No pressure · No obligation · Reply in 1 business day</p>
        </div>
      </section>
    </div>
  );
}
