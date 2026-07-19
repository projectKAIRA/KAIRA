import { Link } from 'react-router-dom';
import { Logo } from './Logo';

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative z-[2] border-t border-black/[0.06] bg-[#f5f5f7]">
      <div
        aria-hidden="true"
        className="h-px w-full opacity-60"
        style={{ background: 'linear-gradient(90deg, transparent, #0071e3 20%, #7c3aed 50%, #ff375f 80%, transparent)' }}
      />
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <p className="flex items-center gap-2 text-lg font-bold tracking-[0.15em] text-ink uppercase">
              <Logo className="h-7 w-7" /> Kaira
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">
              Modern websites, SEO fundamentals, and ongoing maintenance for local businesses ready to stand out online.
            </p>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 text-sm sm:grid-cols-3">
            <div>
              <p className="font-semibold text-ink">Company</p>
              <ul className="mt-3 space-y-2">
                <li><Link to="/about" className="text-ink-muted transition-colors hover:text-ink">About</Link></li>
                <li><Link to="/portfolio" className="text-ink-muted transition-colors hover:text-ink">Work</Link></li>
                <li><Link to="/contact" className="text-ink-muted transition-colors hover:text-ink">Contact</Link></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Services</p>
              <ul className="mt-3 space-y-2">
                <li><Link to="/services" className="text-ink-muted transition-colors hover:text-ink">Web Design</Link></li>
                <li><Link to="/services" className="text-ink-muted transition-colors hover:text-ink">SEO</Link></li>
                <li><Link to="/services" className="text-ink-muted transition-colors hover:text-ink">Maintenance</Link></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Legal</p>
              <ul className="mt-3 space-y-2">
                <li><Link to="/privacy" className="text-ink-muted transition-colors hover:text-ink">Privacy</Link></li>
                <li><Link to="/terms" className="text-ink-muted transition-colors hover:text-ink">Terms</Link></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-black/[0.06] pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-hidden="true">
            <span className="hud-label flex items-center gap-2"><span className="status-dot" /> Design ready</span>
            <span className="hud-label flex items-center gap-2"><span className="status-dot" /> SEO ready</span>
            <span className="hud-label flex items-center gap-2"><span className="status-dot status-dot--violet" /> Maintenance ready</span>
          </div>
          <p className="text-xs text-ink-muted">&copy; {year} KAIRA. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
