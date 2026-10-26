'use client';
import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import {
  ArrowRight,
  AudioLines,
  Battery,
  BatteryLow,
  BellRing,
  Bluetooth,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clapperboard,
  Copy,
  Crown,
  Globe,
  Grid3x3,
  House,
  Info,
  Laptop,
  Link2,
  ListMusic,
  LoaderCircle,
  LocateFixed,
  Lock,
  LogOut,
  Mic,
  MicOff,
  Monitor,
  MonitorSmartphone,
  Moon,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  QrCode,
  Redo2,
  RefreshCw,
  ScreenShare,
  Settings2,
  Share,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  SlidersVertical,
  Smartphone,
  Sofa,
  Sparkles,
  Speaker,
  Tablet,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { DeviceClass, DeviceRole, ObjectChannel } from '@syncsound/protocol';

// ---------- icons (lucide, 1.75 stroke; play/pause filled) ----------

/** Semantic names, so call sites never care which glyph library draws them. */
const ICONS = {
  play: Play,
  pause: Pause,
  prev: SkipBack,
  next: SkipForward,
  copy: Copy,
  share: Share,
  phone: Smartphone,
  tablet: Tablet,
  laptop: Laptop,
  desktop: Monitor,
  bluetooth: Bluetooth,
  speaker: Speaker,
  mic: Mic,
  'mic-off': MicOff,
  wave: AudioLines,
  bell: BellRing,
  bug: Bug,
  undo: Undo2,
  redo: Redo2,
  plus: Plus,
  trash: Trash2,
  x: X,
  check: Check,
  'check-circle': CircleCheck,
  'x-circle': CircleX,
  alert: CircleAlert,
  link: Link2,
  upload: Upload,
  music: Music,
  queue: ListMusic,
  eq: SlidersVertical,
  sliders: SlidersHorizontal,
  volume: Volume2,
  mute: VolumeX,
  crown: Crown,
  battery: Battery,
  'battery-low': BatteryLow,
  warning: TriangleAlert,
  info: Info,
  video: Clapperboard,
  capture: ScreenShare,
  stage: Sofa,
  devices: MonitorSmartphone,
  lock: Lock,
  target: LocateFixed,
  resync: RefreshCw,
  grid: Grid3x3,
  edit: Pencil,
  qr: QrCode,
  globe: Globe,
  sparkle: Sparkles,
  home: House,
  leave: LogOut,
  moon: Moon,
  settings: Settings2,
  spinner: LoaderCircle,
  'arrow-right': ArrowRight,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
} satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof ICONS;
const FILLED = new Set<IconName>(['play', 'pause']);

export function Icon({ name, className = 'size-5', label }: { name: IconName; className?: string; label?: string }) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={className}
      strokeWidth={1.75}
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    />
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

// ---------- surfaces ----------

/**
 * Surfaces are tones, never lines. Each nesting level is one step up and carries no border, blur or shadow:
 *   ground   ink-950  page; sunken wells (stage map, charts, QR frame)
 *   bar      ink-900  player bar, bottom nav, wizard footer
 *   panel    ink-850  Panel, sheets, notes on the ground      (rounded-panel)
 *   row      ink-800  tiles, inputs, tonal buttons, notes in a panel (rounded-row / rounded-field)
 *   control  ink-700  chips, hover; ink-600 = hover on a control (rounded-full)
 * A row never sits in a row: a third level is a chip or a button, not a box. Lists use divide-y, never borders.
 */
export const surface = {
  panel: 'rounded-panel bg-ink-850',
  row: 'rounded-row bg-ink-800',
  well: 'rounded-row bg-ink-950',
  bar: 'bg-ink-900',
} as const;

// ---------- primitives ----------

type Variant = 'primary' | 'tonal' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink font-semibold hover:bg-accent-bright',
  tonal: 'bg-ink-800 text-ink-100 hover:bg-ink-700',
  ghost: 'text-ink-200 hover:bg-ink-800 hover:text-ink-100',
  danger: 'bg-bad/10 text-bad hover:bg-bad/15',
};
const SIZE: Record<Size, string> = {
  sm: 'min-h-9 px-3.5 text-sm',
  md: 'min-h-11 px-5 text-sm',
  lg: 'min-h-14 px-7 text-base',
};

export function Button({
  variant = 'tonal',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
}

export function IconButton({
  icon,
  label,
  className = '',
  pressed,
  variant = 'tonal',
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  pressed?: boolean;
  variant?: 'tonal' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const tone = pressed
    ? 'bg-accent/15 text-accent'
    : variant === 'tonal'
      ? 'bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-100'
      : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${
        size === 'sm' ? 'size-9' : 'size-11'
      } ${tone} ${className}`}
      {...rest}
    >
      <Icon name={icon} className={size === 'sm' ? 'size-4' : 'size-5'} />
    </button>
  );
}

export function Panel({
  title,
  icon,
  actions,
  children,
  className = '',
  id,
}: {
  title: string;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={hid} className={`flex min-w-0 flex-col ${surface.panel} p-5 ${className}`}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={hid} className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight">
          {icon && <Icon name={icon} className="size-5 text-ink-400" />}
          {title}
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      {/* body scrolls when the panel is height-constrained (desktop shell); px keeps focus rings unclipped */}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">{children}</div>
    </section>
  );
}

/** A tonal hint row with a leading icon: replaces bordered callouts. */
export function Note({
  icon,
  tone = 'neutral',
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement> & { icon?: IconName; tone?: 'neutral' | 'accent' | 'warn' | 'bad' }) {
  const tones = {
    neutral: { box: 'bg-ink-800 text-ink-200', icon: 'text-ink-300' },
    accent: { box: 'bg-accent/10 text-ink-100', icon: 'text-accent' },
    warn: { box: 'bg-warn/10 text-ink-100', icon: 'text-warn' },
    bad: { box: 'bg-bad/10 text-ink-100', icon: 'text-bad' },
  } as const;
  return (
    <p className={`flex items-start gap-3 rounded-row px-4 py-3 text-sm ${tones[tone].box} ${className}`} {...rest}>
      {icon && <Icon name={icon} className={`mt-0.5 size-4 shrink-0 ${tones[tone].icon}`} />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'bad' | 'ok' }) {
  const tones = {
    neutral: 'bg-ink-700 text-ink-200',
    accent: 'bg-accent/15 text-accent',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/10 text-bad',
    ok: 'bg-ok/15 text-ok',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export type SyncStatus = 'ok' | 'warn' | 'bad';
const STATUS_TEXT: Record<SyncStatus | 'neutral', string> = {
  ok: 'In sync',
  warn: 'Drifting',
  bad: 'Out of sync',
  neutral: 'Offline',
};
const STATUS_DOT: Record<SyncStatus | 'neutral', string> = {
  ok: 'bg-ok ring-ok/20',
  warn: 'bg-warn ring-warn/20',
  bad: 'bg-bad ring-bad/20',
  neutral: 'bg-ink-400 ring-ink-400/20',
};
export function StatusDot({
  status,
  label,
  testid = 'sync-status',
}: {
  status: SyncStatus | 'neutral';
  label?: string;
  testid?: string;
}) {
  return (
    <span data-testid={testid} data-status={status} className="inline-flex items-center gap-2 text-xs text-ink-300">
      <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ring-4 ${STATUS_DOT[status]}`} />
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
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-40 ${
          checked ? 'bg-accent' : 'bg-ink-600'
        }`}
      >
        <span
          className={`inline-block size-5 rounded-full transition-transform ${checked ? 'translate-x-6 bg-ink-950' : 'translate-x-1 bg-ink-300'}`}
        />
      </button>
    </div>
  );
}

/** style var that paints a range input's track amber up to the current value (see globals.css) */
export const rangeFill = (v: number, min: number, max: number) =>
  ({ '--fill': `${max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0}%` }) as CSSProperties;

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
          <output htmlFor={id} className={`text-xs text-ink-300 tabular ${compact ? 'order-last w-9 shrink-0 text-right' : ''}`}>
            {format(v)}
          </output>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <input
          id={id}
          type="range"
          className="w-full min-w-0"
          style={rangeFill(v, min, max)}
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
            className="h-11 w-20 shrink-0 rounded-field bg-ink-800 px-2.5 text-right text-sm text-ink-100 tabular outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
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

type TabVariant = 'segmented' | 'chips' | 'bar';
const TABLIST: Record<TabVariant, string> = {
  segmented: 'gap-1 rounded-full bg-ink-850 p-1',
  chips: 'gap-1.5',
  bar: '',
};
const TAB: Record<TabVariant, { base: string; on: string; off: string }> = {
  segmented: {
    base: 'min-h-9 rounded-full px-4 text-sm',
    on: 'bg-ink-100 font-medium text-ink-950',
    off: 'text-ink-300 hover:text-ink-100',
  },
  chips: {
    base: 'min-h-9 rounded-full px-3.5 text-sm',
    on: 'bg-ink-100 font-medium text-ink-950',
    off: 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100',
  },
  bar: {
    // the dot under the label is the cone motif marking the current section
    base: 'min-h-14 flex-col !gap-1 px-1 text-[11px] after:size-1 after:rounded-full after:content-[""]',
    on: 'font-medium text-ink-100 after:bg-accent',
    off: 'text-ink-400 after:bg-transparent hover:text-ink-100',
  },
};

/** WAI-ARIA tabs with roving tabindex + arrow/Home/End keys. Panels use `tabPanelProps`. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  panelPrefix = idPrefix,
  variant = 'segmented',
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
  variant?: TabVariant;
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
  const look = TAB[variant];
  return (
    <div role="tablist" aria-label={label} className={`${TABLIST[variant]} ${className}`}>
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
            className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap transition ${look.base} ${
              selected ? look.on : look.off
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
  'h-11 w-full min-w-0 rounded-field bg-ink-800 px-3.5 text-base text-ink-100 placeholder:text-ink-400 outline-none transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset sm:text-sm';

/** Native select as a quiet pill with a chevron; every prop (id, value, data-testid…) goes to the <select>. */
export function Select({
  className = '',
  wrapClassName = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return (
    <span className={`relative inline-flex min-w-0 shrink-0 ${wrapClassName}`}>
      <select
        className={`h-9 w-full min-w-0 appearance-none rounded-full bg-ink-800 pr-8 pl-3.5 text-sm font-medium text-ink-100 outline-none transition hover:bg-ink-700 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${className}`}
        {...rest}
      >
        {children}
      </select>
      <Icon name="chevron-down" className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-400" />
    </span>
  );
}
