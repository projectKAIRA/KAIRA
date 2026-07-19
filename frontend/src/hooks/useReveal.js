import { useEffect } from 'react';

/**
 * Hook up all shared scroll effects (reveal, reveal-words, scrub).
 * Runs once per route change.
 */
export function useReveal(dependency) {
  useEffect(() => {
    // Basic reveal — IntersectionObserver adds is-visible when 35% in view
    const reveals = document.querySelectorAll('.reveal:not(.is-visible)');
    const revealIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            revealIO.unobserve(e.target);
          }
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach((el) => revealIO.observe(el));

    // reveal-words — wrap each text node into <span class="w"> segments,
    // leaving inline gradient spans (.grad-text) as a single unit.
    const wordEls = document.querySelectorAll('.reveal-words:not([data-words-ready])');
    wordEls.forEach((el) => {
      el.setAttribute('data-words-ready', '1');
      let wi = 0;
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parts = node.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          parts.forEach((p) => {
            if (p.trim() === '') {
              frag.appendChild(document.createTextNode(p));
            } else {
              const s = document.createElement('span');
              s.className = 'w';
              s.style.setProperty('--wi', String(wi++));
              s.textContent = p;
              frag.appendChild(s);
            }
          });
          node.parentNode.replaceChild(frag, node);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList.contains('grad-text') || node.matches('[style*="background-clip"]')) {
          node.classList.add('w');
          node.style.setProperty('--wi', String(wi++));
          return;
        }
        [...node.childNodes].forEach(walk);
      };
      walk(el);
    });
    const wordIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            wordIO.unobserve(e.target);
          }
        }
      },
      { threshold: 0.35, rootMargin: '0px 0px -40px 0px' }
    );
    document.querySelectorAll('.reveal-words').forEach((el) => wordIO.observe(el));

    return () => {
      revealIO.disconnect();
      wordIO.disconnect();
    };
  }, [dependency]);
}
