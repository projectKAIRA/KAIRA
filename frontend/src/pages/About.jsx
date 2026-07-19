import { Link } from 'react-router-dom';

const values = [
  { t: 'Local-first', b: "We build for main street. Your website should feel like your business — not a template." },
  { t: 'No jargon', b: 'Plain language, real answers, and clear communication. You should always know what you\'re paying for.' },
  { t: 'Speed matters', b: 'Fast sites convert better. We obsess over performance so your visitors never wait.' },
  { t: 'Long-term partners', b: 'We\'d rather build one great long-term relationship than ten quick projects. Care plans exist for a reason.' },
];

const accents = [['#0071e3', '#5ac8fa'], ['#7c3aed', '#a78bfa'], ['#ff375f', '#ff9500'], ['#34c759', '#5ac8fa']];

export default function About() {
  return (
    <>
      <section className="mesh-bg">
        <div className="mx-auto max-w-3xl px-5 pb-12 pt-16 text-center md:pt-24">
          <p className="reveal hud-label mb-4">ABOUT · THE STUDIO</p>
          <h1 className="reveal-words text-4xl font-bold tracking-tight text-ink md:text-6xl">
            A small studio, <span className="grad-text">obsessed with the details.</span>
          </h1>
          <p className="reveal reveal-delay-1 mt-4 text-lg text-ink-soft">
            Kaira is a boutique web-design practice for local businesses that want to look — and load — like the biggest name on the block.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-5 pb-16 md:pb-20">
        <div className="reveal glass rounded-2xl p-8 md:p-10">
          <p className="text-lg leading-relaxed text-ink-soft md:text-xl">
            After too many years watching great local businesses stuck with slow, ugly, or DIY websites that quietly cost them customers, we built Kaira around one idea:
          </p>
          <p className="mt-4 text-xl font-semibold leading-snug text-ink md:text-2xl">
            Small businesses deserve the same craft, speed, and care that big brands take for granted.
          </p>
          <p className="mt-4 text-lg leading-relaxed text-ink-soft md:text-xl">
            So we keep the roster small on purpose, we obsess over performance and accessibility, and we treat every project like it's the only one we're working on — because that's how we'd want to be treated.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20 md:pb-28">
        <div className="mb-12 text-center">
          <p className="reveal hud-label mb-3">WHAT WE BELIEVE</p>
          <h2 className="reveal-words text-3xl font-bold text-ink md:text-5xl">Four ideas that <span className="grad-text">shape everything we ship.</span></h2>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {values.map((v, i) => {
            const [a, b] = accents[i % 4];
            return (
              <div key={v.t} className={`reveal reveal-delay-${i % 3} grad-border rounded-2xl p-8`} style={{ '--tile-a': a, '--tile-b': b }}>
                <h3 className="text-2xl font-bold" style={{ background: `linear-gradient(120deg, ${a}, ${b})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{v.t}</h3>
                <p className="mt-3 text-ink-soft">{v.b}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-5 pb-24 text-center">
        <p className="reveal hud-label">READY WHEN YOU ARE</p>
        <h2 className="reveal mt-2 text-3xl font-bold text-ink md:text-5xl">
          Let's build <span className="grad-text">something great together.</span>
        </h2>
        <Link to="/contact" className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#1d1d1f] px-7 py-3 text-sm font-semibold text-white shadow-cta transition-transform duration-150 ease-press hover:scale-[1.03] active:scale-[0.98]">
          Get a Free Quote
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </Link>
      </section>
    </>
  );
}
