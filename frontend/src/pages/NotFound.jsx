import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <section className="mesh-bg">
      <div className="mx-auto max-w-2xl px-5 py-24 text-center md:py-32">
        <p className="hud-label">ERROR · 404</p>
        <h1 className="mt-4 text-6xl font-bold tracking-tight text-ink md:text-8xl">
          <span className="grad-text">Page not found.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-md text-lg text-ink-soft">
          That page doesn't exist — but a fresh, fast, findable website for your business can.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#1d1d1f] px-7 py-3 text-sm font-semibold text-white shadow-cta transition-transform duration-150 ease-press hover:scale-[1.03] active:scale-[0.98]"
        >
          Return Home
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </Link>
      </div>
    </section>
  );
}
