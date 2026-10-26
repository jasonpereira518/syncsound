'use client';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import type { DeviceClass, DeviceRole, ObjectChannel } from '@syncsound/protocol';

// ---------- icons (24px grid, stroke) ----------

const PATHS = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  prev: 'M6 5v14M19 5l-10 7 10 7z',
  next: 'M18 5v14M5 5l10 7-10 7z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6h14v-6',
  phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18.5h2',
  tablet: 'M5.5 3h13A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3zM11 18h2',
  laptop: 'M5 5h14v10H5zM2.5 19h19',
  desktop: 'M3 4h18v12H3zM9 20h6M12 16v4',
  bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
  speaker: 'M7 3h10v18H7zM12 15.5a2.5 2.5 0 1 0 0-.01M12 7.5h.01',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
  wave: 'M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h0',
  bug: 'M9 7a3 3 0 0 1 6 0M7 10h10v5a5 5 0 0 1-10 0zM3 13h4M17 13h4M4 7l3 3M20 7l-3 3M4 20l3-3M20 20l-3-3',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  eq: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  battery: 'M3 8h15v8H3zM21 11v2',
  warning: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  capture: 'M3 5h18v12H3zM8 21h8M12 9v4M10 11h4',
  stage: 'M3 3h18v18H3zM8 8h.01M16 8h.01M12 16h.01M3 12h18',
  devices: 'M4 5h10v14H4zM17 8h4v11h-4zM8 16h2',
  sliders: 'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  more: 'M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM19 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  leave: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-5', label }: { name: IconName; className?: string; label?: string }) {
  const filled = name === 'play' || name === 'pause';
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export const CLASS_ICON: Record<DeviceClass, IconName> = {
  phone: 'phone',
  tablet: 'tablet',
  laptop: 'laptop',
  desktop: 'desktop',
  bluetooth: 'bluetooth',
  unknown: 'speaker',
};

export const ROLE_COLOR: Record<DeviceRole, string> = {
  L: 'var(--color-role-l)',
  R: 'var(--color-role-r)',
  C: 'var(--color-role-c)',
  SL: 'var(--color-role-sl)',
  SR: 'var(--color-role-sr)',
  RL: 'var(--color-role-rl)',
  RR: 'var(--color-role-rr)',
  Sub: 'var(--color-role-sub)',
  Full: 'var(--color-role-full)',
};

export const CHANNEL_COLOR: Record<ObjectChannel, string> = {
  L: ROLE_COLOR.L,
  R: ROLE_COLOR.R,
  C: ROLE_COLOR.C,
  SL: ROLE_COLOR.SL,
  SR: ROLE_COLOR.SR,
  RL: ROLE_COLOR.RL,
  RR: ROLE_COLOR.RR,
  LFE: ROLE_COLOR.Sub,
  MONO: '#e6e9f0',
  AMB: '#3de8ff',
  STEM: '#f0a6ff',
};

// ---------- formatting ----------

export const fmtMs = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} ms`;
export const fmtSigned = (v: number, digits = 1) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
export const fmtTime = (sec: number | null | undefined) => {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// ---------- primitives ----------

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 font-medium',
  ghost: 'text-ink-200 hover:bg-ink-800',
  outline: 'border border-ink-700 text-ink-100 hover:border-ink-500 hover:bg-ink-850',
  danger: 'border border-bad/40 text-bad hover:bg-bad/10',
};

export function Button({
  variant = 'outline',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm transition disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
}

export function IconButton({
  icon,
  label,
  className = '',
  pressed,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
        pressed ? 'bg-accent/15 text-accent' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
      } ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/** A plain column section (no card): small heading row + actions, then a body that scrolls when height-constrained. */
export function Panel({
  title,
  actions,
  children,
  className = '',
  headerClassName = '',
  id,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** e.g. `lg:sr-only` where tabs above already name the panel */
  headerClassName?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={hid} className={`flex min-w-0 flex-col ${className}`}>
      <header className={`mb-2 flex min-h-11 flex-wrap items-center justify-between gap-2 ${headerClassName}`}>
        <h2 id={hid} className="text-sm font-semibold text-ink-200">
          {title}
        </h2>
        {actions && <div className="-mr-2 flex flex-wrap items-center gap-0.5">{actions}</div>}
      </header>
      {/* body scrolls when the panel is height-constrained (desktop shell); px keeps focus rings unclipped */}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'bad' | 'ok' }) {
  const tones = {
    neutral: 'bg-ink-800 text-ink-300',
    accent: 'bg-accent/10 text-accent',
    warn: 'bg-warn/10 text-warn',
    bad: 'bg-bad/10 text-bad',
    ok: 'bg-ok/10 text-ok',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export type SyncStatus = 'ok' | 'warn' | 'bad';
const STATUS_TEXT: Record<SyncStatus, string> = { ok: 'In sync', warn: 'Drifting', bad: 'Out of sync' };
export function StatusDot({ status, label, testid = 'sync-status' }: { status: SyncStatus; label?: string; testid?: string }) {
  const color = status === 'ok' ? 'bg-ok' : status === 'warn' ? 'bg-warn' : 'bg-bad';
  return (
    <span data-testid={testid} data-status={status} className="inline-flex items-center gap-1.5 text-xs text-ink-300">
      <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} aria-hidden />
      {label ?? STATUS_TEXT[status]}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink-100">
          {label}
        </label>
        {description && <p className="text-xs text-ink-400">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:opacity-40 ${
          checked ? 'bg-accent' : 'bg-ink-700'
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full transition-transform ${checked ? 'translate-x-5 bg-accent-ink' : 'translate-x-1 bg-ink-300'}`}
        />
      </button>
    </div>
  );
}

/**
 * Range input that keeps a local draft while dragging and commits on release (pointer/key up, blur).
 * `onLive` (optional) fires on every change, e.g. for throttled scene previews.
 */
export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  onLive,
  format = (v) => String(v),
  withNumber = false,
  disabled,
  hint,
  compact = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  onLive?: (v: number) => void;
  format?: (v: number) => string;
  withNumber?: boolean;
  disabled?: boolean;
  hint?: string;
  /** single row: visually hidden label, value after the slider */
  compact?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const v = draft ?? value;
  const set = (n: number) => {
    if (!Number.isFinite(n)) return;
    setDraft(n);
    onLive?.(Math.min(max, Math.max(min, n)));
  };
  const commit = () => {
    if (draft === null) return;
    onCommit(Math.min(max, Math.max(min, draft)));
    setDraft(null);
  };
  return (
    <div className={compact ? 'flex min-w-0 flex-1 items-center gap-2' : 'min-w-0'}>
      <div className={compact ? 'contents' : 'flex items-baseline justify-between gap-2'}>
        <label htmlFor={id} className={compact ? 'sr-only' : 'text-sm text-ink-200'}>
          {label}
        </label>
        {!withNumber && (
          <output htmlFor={id} className={`font-mono text-xs text-ink-300 tabular ${compact ? 'order-last w-9 shrink-0 text-right' : ''}`}>
            {format(v)}
          </output>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          id={id}
          type="range"
          className="w-full min-w-0"
          min={min}
          max={max}
          step={step}
          value={v}
          disabled={disabled}
          aria-valuetext={format(v)}
          onChange={(e) => set(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        {withNumber && (
          <input
            type="number"
            aria-label={`${label} (number)`}
            className="h-11 w-20 shrink-0 rounded-lg border border-ink-700 bg-ink-850 px-2 text-right font-mono text-sm tabular"
            min={min}
            max={max}
            step={step}
            value={v}
            disabled={disabled}
            onChange={(e) => set(Number(e.target.value))}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        )}
      </div>
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
}

/** WAI-ARIA tabs with roving tabindex + arrow/Home/End keys. Panels use `tabPanelProps`. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  panelPrefix = idPrefix,
  className = '',
  tabClassName = '',
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idPrefix: string;
  /** when a second tablist controls the same panels */
  panelPrefix?: string;
  className?: string;
  tabClassName?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to =
      e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const t = tabs[to];
    if (!t) return;
    onChange(t.id);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className}>
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${panelPrefix}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 px-3 text-sm whitespace-nowrap transition ${
              selected ? 'text-accent' : 'text-ink-400 hover:text-ink-100'
            } ${tabClassName}`}
          >
            {t.icon && <Icon name={t.icon} className="size-5" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const tabPanelProps = (idPrefix: string, id: string) => ({
  role: 'tabpanel' as const,
  id: `${idPrefix}-panel-${id}`,
  'aria-labelledby': `${idPrefix}-tab-${id}`,
});

export const inputClass =
  'h-11 w-full min-w-0 rounded-lg border border-ink-700 bg-ink-850 px-3 text-base text-ink-100 placeholder:text-ink-500 focus:border-accent sm:text-sm';

export const selectClass = 'h-11 shrink-0 rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm disabled:opacity-50';

// ---------- overlays ----------

/** Modal sheet on a native <dialog>: bottom sheet on phones, centred panel from sm up. Esc / backdrop click close it. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  testid,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testid?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      data-testid={testid}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[88dvh] w-full max-w-none rounded-t-xl border border-ink-700 bg-ink-900 p-0 text-ink-100 backdrop:bg-ink-950/70 sm:inset-0 sm:m-auto sm:h-fit sm:max-w-lg sm:rounded-xl"
    >
      <div className="flex max-h-[88dvh] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-800 py-1 pr-1 pl-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </dialog>
  );
}

/** Small popover anchored under its button (popover API: top layer, light dismiss, Esc). */
export function Menu({
  label,
  icon,
  text,
  children,
  testid,
  panelClassName = 'w-56',
}: {
  label: string;
  icon?: IconName;
  text?: string;
  children: ReactNode;
  testid?: string;
  panelClassName?: string;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const w = p.offsetWidth;
    p.style.left = `${Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8))}px`;
    p.style.top = `${Math.max(8, Math.min(b.bottom + 4, window.innerHeight - p.offsetHeight - 8))}px`;
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        popoverTarget={id}
        aria-label={text ? undefined : label}
        title={label}
        aria-expanded={open}
        data-testid={testid}
        className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm transition ${text ? 'min-w-11 sm:px-3' : 'size-11'} ${
          open ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
        }`}
      >
        {icon && <Icon name={icon} />}
        {/* phones: icon only, the text stays as the accessible name */}
        {text && <span className={icon ? 'max-sm:sr-only' : undefined}>{text}</span>}
      </button>
      <div
        ref={pop}
        id={id}
        popover="auto"
        aria-label={label}
        onToggle={(e) => {
          const isOpen = (e.nativeEvent as ToggleEvent).newState === 'open';
          setOpen(isOpen);
          if (isOpen) place();
        }}
        className={`fixed m-0 max-h-[80dvh] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 p-1 text-ink-100 shadow-lg ${panelClassName}`}
      >
        {children}
      </div>
    </>
  );
}

/** A full-width row inside a Menu; closes the menu, then runs. */
export function MenuItem({ onClick, children, testid }: { onClick: () => void; children: ReactNode; testid?: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={(e) => {
        e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
        onClick();
      }}
      className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-ink-200 hover:bg-ink-800 hover:text-ink-100"
    >
      {children}
    </button>
  );
}

/** Fold-out section: a quiet summary row with a chevron. */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  className = '',
  testid,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  testid?: string;
}) {
  return (
    <details className={`group ${className}`} open={defaultOpen} data-testid={testid}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-ink-400 hover:text-ink-100 [&::-webkit-details-marker]:hidden">
        {summary}
        <span aria-hidden className="ml-auto grid size-4 place-items-center transition group-open:rotate-90">
          ›
        </span>
      </summary>
      {children}
    </details>
  );
}
