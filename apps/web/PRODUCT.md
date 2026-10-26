# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
People who want sound in more than one place at home without buying a speaker system: they already own phones,
laptops, tablets and Bluetooth speakers. Two moments: setting up a home once (owner), and a guest joining a room by
link or QR with no install. (Inferred from the R5 Home flow and repo docs; not interviewed.)

## Product Purpose
SyncSound turns the devices already in a home into one synchronized stereo or surround system in the browser. A host
opens a room; every device plays the same audio at the same instant and renders only its own share of the spatial
mix. Success: a stranger can scan, place and tune their speakers in a few minutes and hear one sound, not an echo.

## Positioning
No app and no new hardware: any browser device becomes a speaker, scheduled against a shared room clock with
per-device latency, level and EQ calibration measured acoustically from the listener's seat.

## Operating Context
Same Wi-Fi network; a phone in hand as the remote; devices placed around a living room. Flow: set up my home → scan
the code on each device → tap where it sits in the room → tune once from your seat. Bluetooth adds 100–300 ms of
unreported latency, compensated by the acoustic calibration.

## Capabilities and Constraints
- Layouts: stereo, 3.1, 5.1, 7.1 (`packages/audio-core/src/layout.ts`), drag-to-place sound objects, Advanced view.
- Sources: local files (full spatial + EQ); YouTube in its own tab via the official player, with tab capture for audio.
- Spotify and Apple Music are "Sync-only mode (no spatial/EQ)": driven through official SDKs, never captured.
- DRM video (Netflix, Disney+) yields silence to tab capture; the product detects and explains it.
- Never download or extract YouTube streams; never circumvent DRM.
- AudioContext needs a user gesture; iOS suspends background audio.

## Brand Commitments
Name: SyncSound. Voice: plain, exact, honest about limits ("the honest bit about streaming services").

## Evidence on Hand
- `docs/SYNC_RESULTS.md`: simulated/headless numbers only (e.g. clock sync p95 0.69 ms on simulated Wi-Fi, drift
  error max 3.40 ms, 0 hard reschedules). Must be labelled simulated wherever shown.
- No real-room acoustic measurements yet, no customers, testimonials, press or usage statistics. Do not fabricate them.

## Product Principles
1. Use what people already own; never ask for an install before the first sound.
2. Honest limits over silent failure: say what a source cannot do.
3. One sound, not an echo: timing precision is the product.
4. Setup is a short ritual (scan, place, tune), not a settings screen.
