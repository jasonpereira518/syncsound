# Design: "Listening room"

Warm dark hi-fi. A dim living room at night: walnut, black felt, one amber light.

## Tokens (`src/app/globals.css` `@theme`, shared by the landing page and the app)
- Ground `ink-950` #0e0c0a; fields `ink-900/850/800/700/600` (#161311 / #1e1a16 / #282320 / #342d27 / #453c35),
  lifted so each step is visible (≥ 1.11:1). Surfaces are separated by tone, never by lines, blur or shadows.
- Ink `ink-100` #eeeae3 (bone) for headings; body `ink-200`; secondary `ink-300` #bdb3a5; hints `ink-400` #a89d8f
  (5.8:1 on ink-800). `ink-500` #7b6f62 is for strokes and chart ticks only, never text.
- Accent `accent` #ffb23e (amber) on the primary action, the motif and live levels only; text on it is
  `accent-ink` #1a0f00. `warn` #e9d96a stays clear of amber. `role-*` colours are data (room diagram), not brand.
- Type: Chillax (self-hosted, `src/app/fonts`), one family. Landing steps: small, body, lead, head, display.
  Display 600, tracking −0.03 to −0.035em, leading ~1. JetBrains Mono only for room codes in the app.

## The app (home, join, room)
- **Tone ladder**, one rule for nesting: ground 950 → bar 900 (player bar, bottom nav, wizard footer) → panel 850
  (`rounded-panel` 24px) → row 800 (tiles, inputs, tonal buttons, notes; `rounded-row` 16px / `rounded-field` 12px)
  → control 700 (chips, hover). A row never sits in a row; lists use `divide-y`, never borders. On phones the page is
  the panel. Primitives live in `src/components/ui.tsx` (`surface`, `Panel`, `Note`, `Button`, `IconButton`, `Select`).
- **Amber** marks the one primary action per screen, the play button, the now-playing tile, live progress, focus rings
  and the brand mark. A selected tab or option is a bone pill (`bg-ink-100 text-ink-950`); a pressed toggle (mute,
  lock, snap) is `bg-accent/15 text-accent`. No glows, no ping animations.
- **Icons**: lucide-react behind `Icon name=…` (semantic names), 1.75 stroke, play/pause filled, never under 16px.
  Icons sit in round tiles: the cone again.
- Display type is Chillax 600 with −0.03em tracking; room codes, timecodes and the debug drawer use JetBrains Mono.

## The motif
The speaker cone: a circle and its rings. It appears as the huge amber disc in the hero, the brand mark
(concentric filled rings), the round buttons, icon tiles and slider thumb, the app brand link (`components/Brand.tsx`) and favicon, the sound dot in the demo, the circle mask on the
woofer close-up, the arc cut into the first timing tile, and the sync rings that leave every cone at once.
No second shape.

## Pictures
Offline three.js renders of one walnut bookshelf speaker (`scripts/render-speakers.html`, `pnpm render:speakers`).
Re-render after changing the model; stills live in `public/landing/`, woofer positions in
`src/components/landing/renders.json`.

## Motion
One clock: `--beat` 500 ms (120 BPM) drives every cone pump and ring. Signature: the hero speakers open from the
bottom edge and settle from 1.12 scale. Section parts rise once as they enter (Reveal.tsx). Transform and opacity
only; everything static under `prefers-reduced-motion`.
