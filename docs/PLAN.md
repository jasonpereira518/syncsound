# Plan

## Approach

1. **M0 scaffold** — pnpm monorepo, strict TS, ESLint/Prettier, Vitest, Playwright, CI, demo asset generator.
2. **Contracts** — `packages/protocol` (zod) and `packages/audio-core` public API (types + signatures) written
   by the lead before any parallel work, so all four workstreams code against the same interfaces.
3. **Parallel workstreams** (subagents, disjoint directories, no dependency installs, no commits):
   - (a) `apps/server`: transport-free `Room`, `RoomManager`, ws adapter, HTTP uploads/assets, rate limiting.
   - (b) `audio-core` timing: `ClockSync` (NTP-style, lowest-RTT-quartile median, drift regression, slewing),
     `AudioClockMap`, scheduler (`computeStart`), `DriftController`, `RemoteSyncController` + `packages/sim`
     network/clock simulator.
   - (c) `audio-core` DSP/spatial: DBAP gains, `computeDeviceMix`, biquads/LR4 crossover, FFT, log sweep +
     inverse filter, chirp detection, fractional-octave smoothing, EQ fitter, loudness, WAV I/O + sim
     calibration tests and offline-render alignment.
   - (d) `apps/web`: landing, room page, join gate, player, stage (SVG, pointer events), devices, calibration
     wizard, debug drawer, audio engine, WebRTC mesh, source adapters.
4. **Integration** by lead: wire web ↔ server ↔ audio-core, run full suite, E2E, fix.
5. **M1–M8** acceptance in order (see PROGRESS.md), committing each.
6. Finish: fresh-clone `pnpm verify`, self-review against spec §1–13, SYNC_RESULTS, HUMAN_TEST_CHECKLIST.

## Key designs

- **Clock**: per-sample `rtt=(t3-t0)-(ts_send-ts_recv)`, `offset=((ts_recv-t0)+(ts_send-t3))/2`. Window of 64,
  keep lowest-RTT 25%, median offset; drift via least squares of filtered offsets vs time; output offset slews at
  ≤ 1 ms/s unless error > 50 ms (step).
- **Audio clock**: `getOutputTimestamp()` gives `(contextTime, performanceTime)` at the speaker, so the mapping
  already contains browser-reported output latency; fallback is `currentTime` + `baseLatency + outputLatency`.
- **Schedule**: `when = roomToCtx(startRoomTime) - compensation`; late < 50 ms → start now at offset+lateness.
- **Drift**: every 500 ms; |e|<2 ms none, 2–30 ms playbackRate ±≤0.2%, >30 ms reschedule w/ 15 ms crossfade.
- **Calibration**: listener records; speakers emit per-device chirp (distinct band) + log sweep + pink noise in
  time slots at scheduled room times. Arrival − schedule − propagation → relative latency (input latency cancels).
  Sweep → IR → 1/6-oct magnitude → EQ toward common target (≤ +6 dB, no boost below rolloff, limiter).
- **Spatial**: DBAP `g_i ∝ 1/(d_i²+r²)^(a/2)`, Σg²=1; LR4 crossover 100 Hz; LFE + lows to bass-capable devices.
- **Video**: Mode 1 tab capture → WebRTC mesh → fixed target buffer; Mode 2 local file → scheduled audio +
  clock-driven `<video>`; YouTube IFrame + capture. RMS-based silent (DRM) detection.
- **Class B**: Spotify Web Playback SDK / MusicKit JS adapters + mock adapter; `RemoteSyncController` re-seeks
  with hysteresis and learned seek latency.
