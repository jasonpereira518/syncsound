'use client';
import { useEffect } from 'react';

/** what rises in as it scrolls into view; siblings stagger in reading order (heading, text, picture) */
const SELECTOR = '.rise, .demo-copy > *, .plan, .ritual-clause > .lead, .tile, .card, .close-form > *, .foot-word';

/**
 * Section entrances, once each: an IntersectionObserver marks elements `is-in`; the hidden state only exists under
 * `html.js` and no-preference motion (landing.css), so without script everything is simply there.
 */
export function Reveal() {
  useEffect(() => {
    document.documentElement.classList.add('js');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
    );
    document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
      const i = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
      el.dataset.reveal = '';
      el.style.setProperty('--d', String(Math.min(i, 4)));
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);
  return null;
}
