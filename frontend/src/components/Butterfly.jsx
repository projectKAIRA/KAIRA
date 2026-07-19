import { useEffect, useRef } from 'react';

/**
 * A small ambient butterfly that drifts around the viewport as the user
 * scrolls. Kept deliberately subtle: fixed size ~44px, translucent,
 * pointer-events disabled, hidden on small screens and for users who
 * prefer reduced motion.
 *
 * Colors match the K logo gradient: #0071e3 → #7c3aed → #ff375f.
 */
export default function Butterfly() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) {
      el.style.display = 'none';
      return;
    }

    let raf;
    let x = window.innerWidth * 0.85;
    let y = window.innerHeight * 0.3;
    let prevX = x;
    let prevY = y;

    const tick = (now) => {
      const t = now / 1000;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const doc = document.documentElement;
      const maxScroll = Math.max(1, doc.scrollHeight - vh);
      const p = Math.min(1, Math.max(0, window.scrollY / maxScroll));

      // Target path: weaves gently side to side as the page scrolls,
      // with a slow time-based wander so it never sits perfectly still.
      const tx =
        vw * (0.5 + 0.36 * Math.sin(p * Math.PI * 3 + t * 0.12)) +
        Math.sin(t * 0.7) * 14;
      const ty =
        vh * (0.18 + 0.55 * p + 0.06 * Math.sin(p * Math.PI * 5)) +
        Math.cos(t * 0.9) * 10;

      // Heavy easing gives the lazy, swirling drift instead of tracking.
      x += (tx - x) * 0.035;
      y += (ty - y) * 0.035;

      // Tilt slightly into the direction of travel.
      const vx = x - prevX;
      const vy = y - prevY;
      prevX = x;
      prevY = y;
      const angle = Math.max(-28, Math.min(28, vx * 4 + vy * 1.5));

      // Flap faster while moving, laze while hovering.
      const speed = Math.hypot(vx, vy);
      const flapDur = Math.max(0.35, 0.9 - speed * 0.12);
      el.style.setProperty('--flap', `${flapDur}s`);
      el.style.transform = `translate3d(${x - 22}px, ${y - 22}px, 0) rotate(${angle}deg)`;

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-[35] hidden opacity-70 will-change-transform md:block"
    >
      <style>{`
        @keyframes kaira-flap-l { 0%,100% { transform: rotateY(18deg); } 50% { transform: rotateY(70deg); } }
        @keyframes kaira-flap-r { 0%,100% { transform: rotateY(-18deg); } 50% { transform: rotateY(-70deg); } }
        .kaira-wing-l { transform-origin: 50% 50%; animation: kaira-flap-l var(--flap, 0.9s) ease-in-out infinite; }
        .kaira-wing-r { transform-origin: 50% 50%; animation: kaira-flap-r var(--flap, 0.9s) ease-in-out infinite; }
      `}</style>
      <svg
        width="44"
        height="44"
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ perspective: '200px', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="kaira-bfly" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0071e3" />
            <stop offset="0.5" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#ff375f" />
          </linearGradient>
        </defs>
        <g className="kaira-wing-l">
          <path
            d="M 47 46 C 36 30, 16 22, 9 30 C 2 38, 15 52, 30 54 C 38 55, 44 52, 47 46 Z"
            fill="url(#kaira-bfly)"
            fillOpacity="0.35"
            stroke="url(#kaira-bfly)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path
            d="M 46 55 C 38 63, 30 78, 36 84 C 42 89, 51 78, 50 65 C 49.7 61, 48 57, 46 55 Z"
            fill="url(#kaira-bfly)"
            fillOpacity="0.35"
            stroke="url(#kaira-bfly)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </g>
        <g className="kaira-wing-r">
          <path
            d="M 53 46 C 64 30, 84 22, 91 30 C 98 38, 85 52, 70 54 C 62 55, 56 52, 53 46 Z"
            fill="url(#kaira-bfly)"
            fillOpacity="0.35"
            stroke="url(#kaira-bfly)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path
            d="M 54 55 C 62 63, 70 78, 64 84 C 58 89, 49 78, 50 65 C 50.3 61, 52 57, 54 55 Z"
            fill="url(#kaira-bfly)"
            fillOpacity="0.35"
            stroke="url(#kaira-bfly)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </g>
        <path d="M 48 38 C 45 31, 40 26, 36 24" stroke="url(#kaira-bfly)" strokeWidth="2" strokeLinecap="round" />
        <path d="M 52 38 C 55 31, 60 26, 64 24" stroke="url(#kaira-bfly)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="35.5" cy="23.5" r="2" fill="#7c3aed" />
        <circle cx="64.5" cy="23.5" r="2" fill="#7c3aed" />
        <path d="M 50 39 C 52.5 47, 52.5 63, 50 71 C 47.5 63, 47.5 47, 50 39 Z" fill="url(#kaira-bfly)" />
      </svg>
    </div>
  );
}
