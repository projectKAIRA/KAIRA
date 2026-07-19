import React from 'react';

/**
 * KAIRA "K" monogram — geometric, gradient-filled logo mark.
 * Replaces the original butterfly. Retained the name "Butterfly"
 * only inside imports; exported as `Logo` for clarity.
 */
export function Logo({ className = 'h-9 w-9', badge = false }) {
  const uid = React.useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0071e3" />
          <stop offset="0.5" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#ff375f" />
        </linearGradient>
        <linearGradient id={`${uid}-badge`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f5f5f7" />
        </linearGradient>
      </defs>
      {badge && (
        <rect x="4" y="4" width="92" height="92" rx="22" fill={`url(#${uid}-badge)`} stroke="rgba(0,0,0,0.06)" />
      )}
      <g>
        <rect x="20" y="14" width="15" height="72" rx="3" fill={`url(#${uid}-fill)`} />
        <path d="M 35 46 L 68 14 L 84 14 L 46 50 Z" fill={`url(#${uid}-fill)`} />
        <path d="M 35 54 L 46 50 L 84 86 L 68 86 Z" fill={`url(#${uid}-fill)`} />
      </g>
    </svg>
  );
}

export default Logo;
