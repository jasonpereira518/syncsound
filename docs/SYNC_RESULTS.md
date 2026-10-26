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
- Slewing never exceeded 1.00 ms/s after convergence (0 steps). On reconnect (server clock jumps +4 s) the client
  re-bursts without resetting (`rebase()`): it re-acquires in 0.3 s with a max error of 1.0 ms afterwards, and its
  drift estimate survives the jump (51.9 → 51.9 ppm).

## 2. Drift control (`drift.test.ts`)

10 simulated minutes. The audio clock runs +80 ppm vs the perf clock, the perf clock runs −50 ppm vs the server, and
the network has σ 5 ms jitter. `getOutputTimestamp` is modeled with ±½ render-quantum jitter and 2 % OS hiccups. The
controller loop runs every 500 ms.

| | value |
|---|---|
| True playback-position error, mean / RMS / p95 / max | **0.11 / 0.54 / 1.50 / 2.16 ms** |
| Rate updates / hard reschedules | 1192 (every tick, PI loop) / **0** |
| Max playbackRate deviation | 0.04 % (inaudible; the limit is 0.2 %) |

R1 replaced the 1–2 ms hysteresis deadband (which left a steady 1.48 ms bias: RMS / p95 / max were
1.59 / 2.45 / 3.40 ms) with a critically damped PI loop whose integral learns the device's clock-rate mismatch.
The remaining p95 is the WAN clock estimate (σ 5 ms jitter here), which the LAN clock master removes between
devices (next section).

### 2c. Pause → resume minutes later (`pauseResume.test.ts`)

Four Wi-Fi devices (output latencies 10 / 40 / 180 / 25 ms, calibrated to ±0.5 ms, σ 3–6 ms jitter, 1 % spikes and
loss) play for a minute, pause, and resume after a long break during which their tabs are in the background. On
resume each tab re-bursts its clock (no reset), the host presses play 2 s later (one case: 0.3 s later, mid-burst),
and playback runs for 60 s. "Spread" is max − min of the four devices' true position errors per probe.

| Pause | Pings while paused | First second after start | 60 s after: error p95 / spread p95 | Clock steps | Reschedules |
|---|---|---|---|---|---|
| 5 min | 1 Hz (299) | max 0.47 ms | 0.63 / 1.19 ms | 0 | 0 |
| 5 min, play pressed mid-burst | 1 Hz | max 0.91 ms, no late start | 0.63 / 1.18 ms | 0 | 0 |
| 30 min | 1 Hz for 5 min, then one a minute (325) | max 0.58 ms | 0.63 / 1.05 ms | 0 | 0 |
| 30 min, devices asleep (perf clock stopped, context suspended) | none (0) | max 1.18 ms; clocks re-acquired 400 ms after waking, map ready after 750 ms | 1.14 / 1.38 ms | 1 (the re-acquisition) | 0 |
| 30 min, AudioContext suspended (iOS) | 1 Hz (1799) | max 0.95 ms; map ready 750 ms after resume | 1.00 / 1.37 ms | 0 | 0 |

The resync bursts moved the mappings by < 1.1 ms in every non-sleep case, so no source was rebuilt; the resumed
sources start at the learned rate, so the post-resume error (p95 0.63 ms) is *better* than the last 20 s before
the pause (p95 1.06 ms, still settling from the cold start). Drift estimates stayed within 0.5 ppm (3.4 ppm after
the sleep, where the history restarts from the carried prior).

### 2d. 60-minute session with clock-rate wander (`longSession.test.ts`)

As §2, for an hour, with the perf clock wandering ±3 ppm over 20 min and the audio clock ±2 ppm over 15 min on
top of the constant mismatch.

| | value |
|---|---|
| True position error, mean / RMS / p95 / max | **0.02 / 0.36 / 0.72 / 1.95 ms** |
| Reschedules / max playbackRate deviation (after 5 min) | **0** / 0.025 % |
| Audio-clock rate vs the true instantaneous rate | mean −0.1 ppm, p95 1.9, max 2.5 (the 256 s window lags the wander by up to ≈ 1.8 ppm) |
| Clock drift estimate vs the true instantaneous drift | max 4.2 ppm (the 8.5 min history lags the wander) |

The 60-minute sim found a latent bug: a late timestamp among the first eight audio-clock observations bent the
least-squares fit by thousands of ppm and the step detector then rejected every good observation for ever
(DECISIONS #61). With the robust initial line the map is within 1.3 ppm (p50) for the whole hour.

### 2e. Tab switches while playing (`resync.test.ts`)

Two devices, 300 s of play; a resync at 120 s (a 1 s tab switch, pings uninterrupted) and a 30 s background spell
followed by a resync at 230 s. Mapping shifts measured by the bursts: 0.05 / 0.01 / 0.36 / 0.02 ms → **0 clock
steps, 0 reschedules, 0 rebuilds**; true error p95 0.56 ms, spread p95 0.81 ms; drift estimates 35.0 and −79.5 ppm
against 35 / −80 true (the history survived both bursts). Before S1 every resync reset the clock and forced a
crossfade reschedule.

### 2f. LAN clock master leaves mid-song (`lanFailover.test.ts`)

Six devices as in §2b. At 90 s the master's tab closes; the server notices after its heartbeat (20 s) and the
lowest remaining id becomes master.

| | value |
|---|---|
| Peers fall back to the server clock after | 2.9 s (`STALE_MS` 3 s) |
| Every peer re-linked to the new master (8 LAN samples + 2 s `READY_HOLD_MS`) after | 22.4 s (heartbeat-dominated) |
| Largest room-time step any device saw | **0.67 ms** (the LAN-vs-server estimate difference) |
| Spread after recovery, p95 / max | 0.39 / 0.48 ms (before: 0.47 / 0.66) |

## 2b. LAN clock master (`lanMaster.test.ts`)

6 devices on home Wi-Fi, 180 simulated seconds, measured after a 10 s settle. The server sits behind a shared WAN
leg (44 ms RTT, 6 ms asymmetry, σ 5 ms jitter, 2 % spikes up to 120 ms). Wi-Fi to the master is 6 ms RTT, σ 2 ms
jitter, 2 % spikes up to 30 ms. Metric: device-to-device spread, i.e. max − min room-time error across all
6 devices at each probe.

| | p50 | p95 | max |
|---|---|---|---|
| Every device syncs to the server over the WAN | 0.98 ms | 1.71 ms | 3.23 ms |
| Peers sync to an in-home master (10 Hz DataChannel pings) and share the master's mapping (re-sent every 500 ms) | **0.20 ms** | **0.39 ms** | **0.65 ms** |

## 3. Offline-render alignment, "all devices play at the same instant" (`alignment.test.ts`)

Each simulated device runs the real `ClockSync` over its own simulated network, then `AudioClockMap` and
`computeStart`. Its output is then **rendered with `node-web-audio-api`'s `OfflineAudioContext`** using
`AudioBufferSourceNode.start(when, offset)`. The renders are mapped onto the true timeline (true clock offset plus
true output latency) and cross-correlated pairwise.

| Case | Max pairwise misalignment |
|---|---|
| 4 devices, output latency 10 / 40 / 180 (BT) / 25 ms, Wi-Fi jitter σ 3–6 ms, calibration error ±0.5 ms | **0.66 ms** |
| Harsh jitter σ 8 / 15 / 5 / 30 ms | 2.53 ms (bound from the error budget: 7 ms) |
| Late joiner (joins 7.3 s after start) | 1.78 ms vs the others |
| Same devices **without** latency compensation (control) | 169.8 ms |

## 4. Acoustic calibration (`calibration.test.ts`, listener-only)

Four synthetic speakers (known biquad responses plus latencies). One mono listener recording: each speaker's 1.1 s
swoosh → chime arriving at scheduled time + latency + propagation + a hidden 12 ms mic input latency, plus −50 dBFS noise. It
goes through the real `buildTuneSlots` → `analyzeRecording` → `solveTune` pipeline (calibration v3).

| Device | True relative latency | Measured | Error | Response error (passband) |
|---|---|---|---|---|
| Phone (300 Hz HP + 4 kHz peak) | 10 ms | 10.02 ms | 0.02 ms | 0.36 dB |
| Laptop (−8 dB low shelf) | 25 ms | 25.01 ms | 0.01 ms | 0.25 dB |
| **Bluetooth speaker** | **195 ms** | **195.01 ms** | **0.01 ms** | 0.54 dB |
| Desktop (flat) | 0 ms | 0 ms | 0 ms | 0.30 dB |

(v2's narrow-band chirps measured the phone 0.25 ms off in the same room.)

- **EQ convergence:** after EQ toward the common target, the mean pairwise RMS difference between device responses
  falls from 1.86 to 0.32 dB (**−83 %**) over 275 Hz–8 kHz. Over 200 Hz–8 kHz it falls from 2.22 to 1.32 dB
  (−41 %); the gap is explained in LIMITATIONS.
- **Loudness:** trims meet at the median (−4.0 … +2.1 dB here); the TRUE K-weighted loudness of every device at the
  listener after EQ + trim then spreads by **0.03 dB**.
- **Safety:** the largest band boost was 3.7 dB (rail: 6 dB), there was no boost below rolloff (checked 20 Hz up),
  and overall gain stayed ≤ 0 dB.
- **Error cases:** a noisy room (broadband SNR 5–7 dB) raises a warning (timing still within 0.02 ms), and an
  unplugged device is reported as not heard.

## 4b. Tune end to end (`tune.test.ts`)

6 × 5 m room with first-order wall + floor reflections; four stereo laptops (speakers ±13 cm, one side-firing so its
floor bounce is louder than the direct sound) plus a laptop driving a Bluetooth speaker across the room (180 ms).
Every device records its own mic (recorder clock ±50 ppm, known to ±20 ppm); clock errors ~N(0, 0.11 ms) per device,
drawn afresh at tune time and again at play time (σ matched to §2b). 6 seeds; scored at the listener's head.

| | p50 | p95 | max |
|---|---|---|---|
| **Arrival spread at the head, any two devices** | 0.19 ms | **0.59 ms** | 0.62 ms |
| Control: same tune aligned at the mic (no head model) | — | 1.55 ms | 1.80 ms |
| Laptop-to-laptop distance error | — | 13.7 cm | 14.4 cm (the stereo half-width) |
| Level at the head vs a mic at the true head (mean removed) | — | 0.49 dB | 0.50 dB |
| Other devices' trims when the listener's own speaker reads 8 dB quiet | — | — | 0.00 dB |

The Bluetooth speaker is timed exactly at the listener and keeps its hand placement. Trying a longer LAN clock
window (256) and a smaller best-fraction (15 %) lowered §2b's device-to-device p95 only from 0.41 to 0.37 ms, so the
filter is unchanged (DECISIONS #54).

## 5. Sync-measurement tool (`syncMeasure.test.ts` + E2E)

- **Simulated:** 4 devices click for 60 s, time-staggered by 250 ms with identical wideband chirps, each with a known
  residual error and 0.4 ms rms jitter. Per-click inter-device errors are recovered from one mixed recording to
  within **0.02 ms** (240/240 clicks; v2's narrow-band chirps: 0.17 ms).
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
