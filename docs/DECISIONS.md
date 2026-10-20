# Decisions

| # | Decision | Alternatives | Reason |
|---|----------|--------------|--------|
| 1 | TypeScript 6.0.x | TS 7 (native) | typescript-eslint 8.x peer range is `<6.1`. |
| 2 | Packages export `.ts` source, no build step | tsup/tsc builds per package | Fewer moving parts; Next `transpilePackages`, `tsx` for server, Vitest native TS. |
| 3 | Plain Node `http` + `ws` server | Bun, uWebSockets.js | `ws` is the prompt's default; runs everywhere incl. CI/Docker. |
| 4 | `pnpm -r --parallel` for `pnpm dev` | `concurrently` | No extra dependency. |
| 5 | `apps/web/tsconfig.json` maps `zustand/vanilla` + `zustand/react` via `paths` | rename the checkout dir | TypeScript substitutes `*` of package `exports` patterns into the *whole* absolute path, and this checkout lives under `**Quick Projects`. The mapping is harmless in any other path. |
| 6 | Snap every `AudioBufferSourceNode.start(when, offset)` to the sample grid (`snapToSampleGrid`) | keep sub-sample starts | Chromium linearly interpolates fractional-sample starts → up to −2.4 dB at 11 kHz (found by the loopback-calibration E2E: a "flat" loopback measured 2.7 dB droop; 0.00 dB after the fix). Timing error ≤ 10 µs. |
| 7 | `?loopbackMic=<ms>` test mode records the device's own calibration emissions instead of the mic | fake-mic WAV (can't be time-aligned) | Lets Playwright run the full calibration wizard + real measurement code in a real browser. |
| 8 | Web store split into `store/state.ts` (zustand) + `store/roomStore.ts` (actions) | one file | lib modules write to the store without an import cycle. |
| 9 | Host auto-sends `defaultObjectsFor(channels, upmix)` per (track, channels, upmix), keeping existing positions | manual object setup | 5.1 files would otherwise be half-silent with the default L/R scene. |
| 10 | Spotify PKCE via popup (falls back to full redirect) | redirect only | Keeps the room page (and its AudioContext) alive during sign-in. |
| 11 | `expectedHeardEpochMs = timeOrigin + ctxToPerf(when) + L − (offset − trackOffset)·1000` | brief's formula | The brief double-counted auto latency in fallback mode; unit test checks devices with different latencies agree. |
