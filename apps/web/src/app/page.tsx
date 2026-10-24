import type { CSSProperties } from 'react';
import Image from 'next/image';
import { LandingActions } from '@/components/LandingActions';
import { CloseCta } from '@/components/landing/CloseCta';
import { LayoutDemo } from '@/components/landing/LayoutDemo';
import { Ritual } from '@/components/landing/Ritual';
import { Reveal } from '@/components/landing/Reveal';
import { Speaker } from '@/components/landing/Speaker';
import './landing.css';

/** headless-simulator results from docs/SYNC_RESULTS.md (sections 1 and 2); labelled as simulated on the page */
const FIGURES = [
  {
    value: '0.69 ms',
    caption: 'How far device clocks stray from the room clock, 95th percentile, on simulated Wi-Fi with jitter and 1% packet loss.',
  },
  { value: '3.4 ms', caption: 'Largest playback-position error over ten simulated minutes of clock drift.' },
  { value: '0', caption: 'Hard restarts in that run. Drift is trimmed with rate nudges of at most 0.06%, too small to hear.' },
];

const FAQ = [
  {
    tab: 'Your files',
    q: 'Can I play my own music?',
    a: 'Yes, and it gets the full treatment: surround placement, per-speaker EQ and level matching. Audio is loaded onto every device before it starts, never streamed live.',
  },
  {
    tab: 'YouTube',
    q: 'Does YouTube work?',
    a: 'Yes. The video plays in YouTube’s official player and its sound is shared from the browser tab. Nothing is downloaded or extracted.',
  },
  {
    tab: 'Spotify',
    q: 'What about Spotify and Apple Music?',
    a: 'They run in Sync-only mode (no spatial/EQ). Their audio is DRM-protected, so each device plays through the official player under its own Premium or subscription account. SyncSound keeps them in time.',
  },
  {
    tab: 'Netflix',
    q: 'Can I share Netflix or Disney+?',
    a: 'No. DRM video gives silence to tab capture. SyncSound notices and tells you instead of failing quietly; use a local video file or a non-DRM source.',
  },
  {
    tab: 'Wi-Fi',
    q: 'Do the devices need to be on the same Wi-Fi?',
    a: 'It works best that way: short round trips keep the clocks tight. Bluetooth speakers pair with a phone or laptop as usual and get their delay measured.',
  },
  {
    tab: 'iPhone',
    q: 'Anything to know about iPhones?',
    a: 'Keep the page open in front: iOS pauses background audio. Each device also needs one tap on “Use this device as a speaker” before the browser allows sound.',
  },
];

/** the cone, seen from the front: concentric filled rings with even gaps (the page's one shape) */
function ConeMark({ className }: { className?: string }) {
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

function Rings() {
  return (
    <span className="rings" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

export default function Home() {
  return (
    <div className="lp">
      <nav className="lp-nav" aria-label="Main">
        <a href="#main" className="lp-brand">
          <ConeMark className="lp-brand-mark" />
          SyncSound
        </a>
        <ul className="lp-links">
          <li>
            <a href="#layouts">Layouts</a>
          </li>
          <li>
            <a href="#how">How it works</a>
          </li>
          <li>
            <a href="#precision">Timing</a>
          </li>
          <li>
            <a href="#sources">What it plays</a>
          </li>
        </ul>
        <a href="#start" className="btn btn-small">
          Set up my home
        </a>
      </nav>

      <main id="main">
        <section className="hero" aria-labelledby="hero-h">
          <div className="hero-copy">
            <h1 id="hero-h" className="hero-h">
              <span className="sr-only">SyncSound: </span>Your home is one speaker.
            </h1>
            <p className="hero-sub">
              SyncSound turns the phones, laptops, tablets and Bluetooth speakers you already own into one stereo or
              surround system, right in the browser. Scan a code on each, tap where it sits, tune once from your seat.
            </p>
            <LandingActions />
          </div>
          <div className="hero-stage">
            <span className="hero-disc" aria-hidden />
            <div className="hero-drift">
              <div className="hero-shot">
                <Speaker view="three-quarter" className="hero-spk-2" sizes="(min-width: 1024px) 22vw, 40vw" priority>
                  <Rings />
                </Speaker>
                <Speaker
                  className="hero-spk"
                  sizes="(min-width: 1024px) 32vw, 56vw"
                  priority
                  alt="A walnut bookshelf speaker beside a second one, both woofers moving on the same beat"
                >
                  <Rings />
                </Speaker>
              </div>
            </div>
          </div>
        </section>

        <section id="layouts" className="sec-demo" aria-labelledby="layouts-h">
          <LayoutDemo />
        </section>

        <section id="how" className="sec-ritual" aria-labelledby="how-h">
          <Ritual />
        </section>

        <section id="precision" className="figs" aria-labelledby="precision-h">
          <div className="figs-head rise">
            <h2 id="precision-h" className="sec-h">
              Timing is the whole trick.
            </h2>
            <p>
              Every device locks to one room clock and starts at a scheduled instant, so you hear one sound, not an
              echo. These numbers come from SyncSound&rsquo;s headless network simulator; real-room tests are next.
            </p>
          </div>
          {FIGURES.map((f, i) => (
            <div key={f.value} className={`fig fig-${i} rise`}>
              <p className="fig-value tabular">{f.value}</p>
              <p className="fig-caption">{f.caption}</p>
            </div>
          ))}
        </section>

        <figure className="band">
          <Image
            src="/landing/room.webp"
            alt="Two walnut speakers on a low sideboard in a dim living room, records stacked between them"
            width={2400}
            height={1350}
            sizes="100vw"
            className="band-img"
          />
          <figcaption>Two speakers on the sideboard, playing as one.</figcaption>
        </figure>

        <section id="devices" className="board" aria-labelledby="devices-h">
          <div className="tile tile-h">
            <h2 id="devices-h" className="sec-h">
              Works with what you own.
            </h2>
          </div>
          <div className="tile tile-delay" data-ui>
            <span className="tile-big tabular">+184 ms</span>
            <p className="tile-name">Delay found</p>
            <p className="tile-line">Measured per speaker, not guessed.</p>
          </div>
          <div className="tile tile-level" data-ui>
            <span className="tile-big tabular">−2.5 dB</span>
            <p className="tile-name">Levels matched</p>
            <p className="tile-line">Every speaker as loud as the next.</p>
          </div>
          <div className="tile tile-cone">
            <Image
              src="/landing/macro-cone.webp"
              alt="Close-up of a woofer cone and its rubber surround"
              width={1400}
              height={1400}
              sizes="(min-width: 1024px) 50vw, 100vw"
            />
            <p className="tile-name">Bluetooth speakers too</p>
            <p className="tile-line">Their 100 to 300 ms of hidden delay is measured with a microphone and taken out.</p>
          </div>
          <div className="tile tile-tweeter">
            <Image
              src="/landing/macro-tweeter.webp"
              alt="Close-up of a silk-dome tweeter in its metal ring"
              width={1400}
              height={1000}
              sizes="(min-width: 1024px) 25vw, 50vw"
            />
            <p className="tile-name">Tone evened out</p>
            <p className="tile-line">Each speaker is measured from your seat and EQ&rsquo;d to match.</p>
          </div>
          <div className="tile tile-corner">
            <Image
              src="/landing/macro-corner.webp"
              alt="The walnut corner of a speaker cabinet with its amber power light"
              width={1400}
              height={1000}
              sizes="(min-width: 1024px) 25vw, 50vw"
            />
            <p className="tile-name">Rooms that remember</p>
            <p className="tile-line">Your home keeps each room&rsquo;s layout and tuning.</p>
          </div>
          <div className="tile tile-chips" data-ui>
            <span className="chips" aria-hidden>
              <span>Phone</span>
              <span>Laptop</span>
              <span>Tablet</span>
              <span>Speaker</span>
            </span>
            <p className="tile-name">Any browser joins</p>
            <p className="tile-line">No app to install. Open the link or scan the code.</p>
          </div>
          <div className="tile tile-group" data-ui>
            <span className="toggle" aria-hidden>
              <span />
            </span>
            <p className="tile-name">Every room at once</p>
            <p className="tile-line">Group play starts the same song in the kitchen and the living room.</p>
          </div>
          <div className="tile tile-adv" data-ui>
            <span className="tile-big">Advanced</span>
            <p className="tile-name">Every control is still there</p>
            <p className="tile-line">Place sound objects, set the crossover, read the sync numbers.</p>
          </div>
        </section>

        <section id="sources" className="faq" aria-labelledby="sources-h">
          <h2 id="sources-h" className="sec-h rise">
            What can it play?
          </h2>
          <div className="cards">
            {FAQ.map((f, i) => (
              <details key={f.tab} name="faq" className="card" open={i === 0} style={{ '--i': i } as CSSProperties}>
                <summary>
                  <span className="card-tab">{f.tab}</span>
                  <span className="card-q">{f.q}</span>
                </summary>
                <p className="card-a">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="close" aria-labelledby="close-h">
          <CloseCta />
        </section>
      </main>

      <footer className="foot">
        <p className="foot-word" aria-label="SyncSound">
          <ConeMark className="foot-mark" />
          <span aria-hidden>SyncSound</span>
        </p>
        <div className="foot-cols">
          <ul>
            <li>
              <a href="#layouts">Layouts</a>
            </li>
            <li>
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="#precision">Timing</a>
            </li>
            <li>
              <a href="#sources">What it plays</a>
            </li>
          </ul>
          <p>Works best with every device on the same Wi-Fi.</p>
          <p>Speaker pictures on this page are 3D renders.</p>
        </div>
        <div className="foot-last">
          <p>© 2026 SyncSound</p>
          <a href="#main" className="btn btn-small">
            Back to top
          </a>
        </div>
      </footer>
      <Reveal />
    </div>
  );
}
