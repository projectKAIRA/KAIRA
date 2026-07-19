import { useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { Logo } from './Logo';

const links = [
  { href: '/services', label: 'Services' },
  { href: '/portfolio', label: 'Work' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
];

export default function Nav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  return (
    <header className="sticky top-0 z-40 border-b border-black/[0.06] bg-white/70 backdrop-blur-xl backdrop-saturate-150">
      <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <Link to="/" className="flex items-center gap-2.5" data-testid="nav-logo" onClick={() => setOpen(false)}>
          <Logo className="h-9 w-9" />
          <span className="text-lg font-bold tracking-[0.2em] text-ink uppercase">Kaira</span>
          <span className="pill ml-2 hidden sm:inline-flex"><span className="status-dot" /> Accepting projects</span>
        </Link>

        <ul className="hidden items-center gap-8 md:flex">
          {links.map((l) => {
            const active = location.pathname.startsWith(l.href);
            return (
              <li key={l.href}>
                <NavLink
                  to={l.href}
                  className={`nav-link text-sm font-medium transition-colors duration-150 ${
                    active ? 'text-ink' : 'text-ink-soft hover:text-ink'
                  }`}
                  data-testid={`nav-link-${l.label.toLowerCase()}`}
                >
                  {l.label}
                </NavLink>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3">
          <Link
            to="/contact"
            className="hidden rounded-full bg-[#1d1d1f] px-5 py-2 text-sm font-semibold text-white transition-all duration-150 ease-press hover:scale-[1.03] hover:shadow-lg active:scale-[0.98] md:inline-block"
            data-testid="nav-cta"
          >
            Get a Quote
          </Link>

          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-ink md:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
            data-testid="nav-toggle"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </nav>

      {open && (
        <div id="mobile-menu" className="border-t border-black/[0.06] bg-white/95 px-5 pb-5 pt-3 backdrop-blur-xl md:hidden">
          <ul className="flex flex-col gap-1">
            {links.map((l) => (
              <li key={l.href}>
                <NavLink
                  to={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-base font-medium text-ink-soft hover:bg-black/[0.04] hover:text-ink"
                >
                  {l.label}
                </NavLink>
              </li>
            ))}
            <li className="mt-2">
              <Link
                to="/contact"
                onClick={() => setOpen(false)}
                className="block rounded-full bg-[#1d1d1f] px-5 py-2.5 text-center text-base font-semibold text-white"
              >
                Get a Quote
              </Link>
            </li>
          </ul>
        </div>
      )}

      <style>{`
        .nav-link { position: relative; }
        .nav-link::after {
          content: "";
          position: absolute;
          left: 0; right: 0; bottom: -5px;
          height: 1.5px;
          border-radius: 1px;
          background: linear-gradient(90deg, #0071e3, #7c3aed, #ff375f);
          transform: scaleX(0);
          transform-origin: left;
          transition: transform 0.25s cubic-bezier(0.16,1,0.3,1);
        }
        .nav-link:hover::after,
        .nav-link.active::after { transform: scaleX(1); }
      `}</style>
    </header>
  );
}
