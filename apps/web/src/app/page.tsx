import { LandingActions } from '@/components/LandingActions';
import { Icon, type IconName } from '@/components/ui';

const STEPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'globe',
    title: 'Clocks agree',
    body: 'Every device pings the room server dozens of times, keeps the fastest round trips and locks onto a shared room clock to well under a millisecond, tracking drift as it goes.',
  },
  {
    icon: 'music',
    title: 'Playback is scheduled',
    body: 'Play, pause and seek are timestamps in the near future. Each device pre-loads the audio and starts its Web Audio graph at exactly that instant, nudging its playback rate to stay locked.',
  },
  {
    icon: 'target',
    title: 'The room becomes surround',
    body: 'Drag speakers and sound objects on a map of your room. Each phone renders only its own share of the mix, and an acoustic calibration measures latency, level and EQ from where you sit.',
  },
];

// Decorative speaker dots for the hero: [x%, y%, delay s]
const DOTS: [number, number, number][] = [
  [18, 30, 0],
  [78, 22, 0.6],
  [50, 58, 1.2],
  [26, 78, 1.8],
  [84, 72, 2.4],
];

export default function Home() {
  return (
    <>
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 pt-5 sm:px-6">
        <span className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
          <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">
            <Icon name="wave" className="size-5" />
          </span>
          SyncSound
        </span>
        <a href="#how" className="rounded-lg px-3 py-2 text-sm text-ink-300 hover:text-ink-100">
          How it works
        </a>
      </nav>

      <main id="main">
        <section className="relative mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:pt-20">
          <div className="min-w-0">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/70 px-3 py-1 font-mono text-xs text-ink-300">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden /> sample-accurate · no app install
            </p>
            <h1 className="font-display text-[clamp(2.5rem,9vw,5.25rem)] leading-[0.95] font-bold tracking-tight text-balance">
              <span className="sr-only">SyncSound: </span>
              Every phone is <span className="text-accent">a speaker.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-300 text-pretty">
              Open a room, let friends scan the QR code, and every phone, laptop and tablet plays the same audio at the
              same instant. Then drag them around a map of the room to build a surround system out of whatever&rsquo;s
              in people&rsquo;s pockets.
            </p>
            <LandingActions />
          </div>

          <div aria-hidden className="relative mx-auto aspect-square w-full max-w-md overflow-hidden rounded-[2rem] border border-ink-700/70 bg-ink-900/60">
            <div className="absolute inset-0 bg-[linear-gradient(var(--color-ink-800)_1px,transparent_1px),linear-gradient(90deg,var(--color-ink-800)_1px,transparent_1px)] bg-[size:12.5%_12.5%] opacity-60" />
            {DOTS.map(([x, y, d]) => (
              <span key={`${x}-${y}`} className="absolute" style={{ left: `${x}%`, top: `${y}%` }}>
                <span
                  className="absolute -top-10 -left-10 size-20 animate-ring rounded-full border border-accent/60"
                  style={{ animationDelay: `${d}s` }}
                />
                <span className="absolute -top-2.5 -left-1.5 h-5 w-3 rounded-[3px] border border-accent bg-ink-950 shadow-[0_0_14px_var(--color-accent)]" />
              </span>
            ))}
            <span className="absolute bottom-4 left-4 font-mono text-[11px] tracking-widest text-ink-400 uppercase">
              5 devices · Δt 0.4 ms
            </span>
          </div>
        </section>

        <section id="how" aria-labelledby="how-h" className="mx-auto max-w-6xl scroll-mt-6 px-4 pb-16 sm:px-6">
          <h2 id="how-h" className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            How it works
          </h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-2xl border border-ink-700/80 bg-ink-900/70 p-5">
                <span className="font-mono text-xs text-accent">0{i + 1}</span>
                <h3 className="mt-2 flex items-center gap-2 font-display text-lg font-semibold">
                  <Icon name={s.icon} className="size-5 text-accent" />
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-300">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="honest-h" className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="rounded-2xl border border-warn/30 bg-warn/[0.04] p-5">
            <h2 id="honest-h" className="flex items-center gap-2 font-display text-lg font-semibold text-warn">
              <Icon name="warning" className="size-5" /> The honest bit about streaming services
            </h2>
            <ul className="mt-3 grid gap-2 text-sm text-ink-300 md:grid-cols-2">
              <li>
                <strong className="text-ink-100">Spotify and Apple Music are sync-only.</strong> Their audio is DRM-protected,
                so each device plays through the official player under its own Premium / subscription account. We keep
                them in time, but spatial mixing and EQ aren&rsquo;t possible there.
              </li>
              <li>
                <strong className="text-ink-100">DRM video can&rsquo;t be captured.</strong> Netflix, Disney+ and similar sites
                deliver silence to tab capture. Use a local video file or a non-DRM source instead. YouTube is shown
                through its official player and is never downloaded.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-800 py-6 text-center text-xs text-ink-500">
        SyncSound · works best with every device on the same Wi-Fi
      </footer>
    </>
  );
}
