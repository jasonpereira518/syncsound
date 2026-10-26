import Link from 'next/link';

/** The cone, seen from the front: concentric filled rings with even gaps (the brand's one shape). */
export function ConeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <circle cx="50" cy="50" r="50" fill="var(--color-accent)" />
      <circle cx="50" cy="50" r="39" fill="var(--mark-gap, var(--color-ink-950))" />
      <circle cx="50" cy="50" r="34" fill="var(--color-accent)" />
      <circle cx="50" cy="50" r="23" fill="var(--mark-gap, var(--color-ink-950))" />
      <circle cx="50" cy="50" r="18" fill="var(--color-accent)" />
    </svg>
  );
}

/** The cone mark and wordmark linking home, at the top of app screens that sit on the ground. */
export function BrandLink({ className = '' }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex min-h-11 items-center gap-2.5 self-start font-display text-base font-semibold text-ink-100 transition hover:text-white ${className}`}
    >
      <ConeMark className="size-7" />
      SyncSound
    </Link>
  );
}
