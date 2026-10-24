# Design: "Listening room"

Warm dark hi-fi. A dim living room at night: walnut, black felt, one amber light.

## Tokens (`src/app/globals.css` `@theme`, shared by the landing page and the app)
- Ground `ink-950` #0e0c0a; fields `ink-900/850/800/700` (#141210 / #1a1714 / #211d19 / #2e2924), one tone step
  apart. Surfaces are separated by tone, never by lines or shadows.
- Ink `ink-100` #eeeae3 (bone); secondary `ink-300` #bdb3a5; hints `ink-400` #9c9184.
- Accent `accent` #ffb23e (amber) on the primary action, the motif and live levels only; text on it is
  `accent-ink` #1a0f00. `warn` #e9d96a stays clear of amber. `role-*` colours are data (room diagram), not brand.
- Type: Chillax (self-hosted, `src/app/fonts`), one family. Landing steps: small, body, lead, head, display.
  Display 600, tracking −0.03 to −0.035em, leading ~1. JetBrains Mono only for room codes in the app.

## The motif
The speaker cone: a circle and its rings. It appears as the huge amber disc in the hero, the brand mark
(concentric filled rings), the round buttons and slider thumb, the sound dot in the demo, the circle mask on the
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
