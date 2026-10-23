# Sync results

> **These numbers are simulated or measured headlessly on one machine.** None were measured acoustically with real
> phones in a real room. That still has to be done; see [HUMAN_TEST_CHECKLIST.md](HUMAN_TEST_CHECKLIST.md).
> Every value below was produced by a test in this repo (`pnpm sim`, `pnpm e2e`). The raw JSON is in
> `packages/sim/results/`.

Targets: < ±10 ms inter-device on good Wi-Fi (Web Audio sources), < ±30 ms in the worst supported case.

## 1. Clock synchronization (`packages/sim/test/clock.test.ts`)

Headless simulator: 8 clients × 120 s, true offsets up to ±10 s, drift ±100 ppm, NTP-style pings (a 25-ping burst, then
1 Hz) run through the real `ClockSync`. The error is |estimated room time − true room time| after convergence.

| Scenario | p50 | p95 | max | Drift estimate error |
|---|---|---|---|---|
| Jitter-free, symmetric RTT 20–80 ms | 0.00 ms | 0.00 ms | 0.15 ms | ≤ 0.01 ppm |
| LAN: RTT 5–40 ms, σ 1 ms jitter, 1 % spikes, 1 % loss | 0.06 ms | 0.20 ms | 0.66 ms | ≤ 2.0 ppm |
| Wi-Fi: RTT 20–80 ms, σ 5 ms jitter, 1 % spikes, 1 % loss | 0.25 ms | 0.69 ms | 1.13 ms | ≤ 5.0 ppm (≤ 0.7 ppm at 300 s) |
| Realistic/harsh: σ 5–30 ms per leg, 1 % spikes ≤ 200 ms, 1 % loss | 0.86 ms | 2.57 ms | 5.90 ms | up to 44.5 ppm (reported, not asserted) |
| Asymmetric path, uplink − downlink = 30 ms | 15.0 ms | 15.0 ms | 15.1 ms | 0.009 ppm |

- The asymmetric case shows the **theoretical NTP bias of asymmetry/2**. No two-way protocol can observe it. It
  ends up inside the acoustic calibration offset, which absorbs it.
- Slewing never exceeded 1.00 ms/s after convergence (0 steps). On reconnect (server clock jumps +4 s) it
  re-converges in 0.5 s, with a max error of 1.4 ms afterwards.

## 2. Drift control (`drift.test.ts`)

10 simulated minutes. The audio clock runs +80 ppm vs the perf clock, the perf clock runs −50 ppm vs the server, and
the network has σ 5 ms jitter. `getOutputTimestamp` is modeled with ±½ render-quantum jitter and 2 % OS hiccups. The
controller loop runs every 500 ms.

| | value |
|---|---|
| True playback-position error, mean / RMS / p95 / max | **0.12 / 0.55 / 1.47 / 2.00 ms** |
| Rate updates / hard reschedules | 1192 (every tick, PI loop) / **0** |
| Max playbackRate deviation | 0.03 % (inaudible; the limit is 0.2 %) |

R1 replaced the 1–2 ms hysteresis deadband (which left a steady 1.48 ms bias: RMS / p95 / max were
1.59 / 2.45 / 3.40 ms) with a critically damped PI loop whose integral learns the device's clock-rate mismatch.
The remaining p95 is the WAN clock estimate (σ 5 ms jitter here), which the LAN clock master removes between
devices (next section).

## 2b. LAN clock master (`lanMaster.test.ts`)

6 devices on home Wi-Fi, 180 simulated seconds, measured after a 10 s settle. The server sits behind a shared WAN
leg (44 ms RTT, 6 ms asymmetry, σ 5 ms jitter, 2 % spikes up to 120 ms). Wi-Fi to the master is 6 ms RTT, σ 2 ms
jitter, 2 % spikes up to 30 ms. Metric: device-to-device spread, i.e. max − min room-time error across all
6 devices at each probe.

| | p50 | p95 | max |
|---|---|---|---|
| Every device syncs to the server over the WAN | 0.98 ms | 1.74 ms | 3.12 ms |
| Peers sync to an in-home master (10 Hz DataChannel pings) and share the master's mapping | **0.21 ms** | **0.41 ms** | **0.93 ms** |

## 3. Offline-render alignment, "all devices play at the same instant" (`alignment.test.ts`)

Each simulated device runs the real `ClockSync` over its own simulated network, then `AudioClockMap` and
`computeStart`. Its output is then **rendered with `node-web-audio-api`'s `OfflineAudioContext`** using
`AudioBufferSourceNode.start(when, offset)`. The renders are mapped onto the true timeline (true clock offset plus
true output latency) and cross-correlated pairwise.

| Case | Max pairwise misalignment |
|---|---|
| 4 devices, output latency 10 / 40 / 180 (BT) / 25 ms, Wi-Fi jitter σ 3–6 ms, calibration error ±0.5 ms | **0.69 ms** |
| Harsh jitter σ 8 / 15 / 5 / 30 ms | 2.50 ms (bound from the error budget: 7 ms) |
| Late joiner (joins 7.3 s after start) | 1.01 ms vs the others |
| Same devices **without** latency compensation (control) | 169.8 ms |

## 4. Acoustic calibration (`calibration.test.ts`)

Four synthetic speakers (known biquad responses plus latencies). One mono listener recording: each speaker's signals
arriving at scheduled time + latency + propagation + a hidden 12 ms mic input latency, plus −50 dBFS noise. It goes
through the real `buildCalibrationSlots` → `analyzeCalibration` pipeline.

| Device | True relative latency | Measured | Error | Response error (passband) |
|---|---|---|---|---|
| Phone (300 Hz HP + 4 kHz peak) | 10 ms | 10.25 ms | 0.25 ms | 0.06 dB |
| Laptop (−8 dB low shelf) | 25 ms | 25.06 ms | 0.06 ms | 0.09 dB |
| **Bluetooth speaker** | **195 ms** | **195.01 ms** | **0.01 ms** | 0.33 dB |
| Desktop (flat) | 0 ms | 0 ms | 0 ms | 0.59 dB |

- **EQ convergence:** after EQ toward the common target, the mean pairwise RMS difference between device responses
  falls from 1.84 to 0.41 dB (**−78 %**) over 280 Hz–8 kHz. Over 200 Hz–8 kHz it falls from 2.22 to 1.37 dB
  (−38 %); the gap is explained in LIMITATIONS.
- **Safety:** the largest band boost was 3.8 dB (rail: 6 dB), there was no boost below rolloff, and overall gain
  stayed ≤ 0 dB.
- **Error cases:** a noisy room (SNR 1–4 dB) raises a warning, and an unplugged device is reported as not heard.

## 5. Sync-measurement tool (`syncMeasure.test.ts` + E2E)

- **Simulated:** 4 devices click simultaneously for 60 s in distinct chirp bands, each with a known residual error
  and 0.4 ms rms jitter. Per-click inter-device errors are recovered from one mixed recording to within **0.17 ms**
  (240/240 clicks).
- **Real browser (headless Chromium, loopback "mic"):** 10/10 clicks detected, **0.03 ms rms** click-timing jitter.
  Each click is scheduled independently through the live clock → audio-clock mapping. Before the
  `AudioClockMap` latency-step fix this measured 9.5 ms rms (see DECISIONS #13).

## 6. End-to-end in real browsers (Playwright, headless Chromium contexts on one machine)

All contexts share one system clock, so `expectedHeardEpochMs` (when each device believes a track position will be
heard) can be compared directly. This checks the whole scheduling pipeline in real browsers: WS clock sync,
`getOutputTimestamp` mapping, `computeStart`, sample-grid snapping. It does not measure acoustics.

| Scenario | Spread across devices |
|---|---|
| 3 contexts, play | **0.11 ms** (0.02–0.25 ms across runs, incl. fresh-clone verify) |
| Seek to 20 s while playing | 0.11 ms |
| Late joiner (4th context) | 0.11 ms |
| 5.1 upload, 2 contexts | < 10 ms (asserted) |
| Device with +100 ms manual latency (starts 100 ms earlier) vs host | 0.007 ms |
| Local video (Mode 2): `<video>` vs room position | 12–14 ms |
| WebRTC capture (Mode 1): guest pipeline-delay estimate | 66 ms (compensated by the buffer) |
| Spotify/Apple **mock** players (sync-only), after 9 s | −29 / +23 ms, mean \|err\| 66–95 ms, 2–3 seeks |

## 7. Class B (sync-only) simulation (`remote.test.ts`)

Mock SDK player: seek latency N(300, 40) ms, ±20 ms position noise, 10 ms quantization, +300 ppm drift, and a
400 ms stall at 5 min.

| Seek latency model | p95 error after 20 s | Seeks in 10 min | Learned seek latency |
|---|---|---|---|
| N(300, 40) ms | 68 ms | 5 | 276 ms |
| U(150, 400) ms | 74 ms | 17 | 286 ms |

As expected, this is clearly worse than Class A (tens of ms vs sub-ms simulated). The UI says so.
