# Calibration, EQ and spatial math

All of this lives in `packages/audio-core` (pure TypeScript, unit-tested) and is exercised end to end by
`packages/sim/test/calibration.test.ts` and the loopback-mic E2E.

## Tune (calibration v3)

One tap on any laptop ("the listener") tunes the room. Target: **p95 < 1 ms between any two devices at the
listener's head**. Laptops first; phones later.

### Run

1. The listener opens its mic, settles 1.5 s, and sends `CALIBRATION_START` with `recorders: 'all'`. The server
   stamps `startRoomTime = now + max(lead, 3.5 s)` and broadcasts the plan.
2. Every other device with a usable mic opens it as soon as the plan arrives (never a Bluetooth-headset mic, which
   would flip the headset into its hands-free profile) and records until the plan ends. No mic / no permission →
   it still plays, it just isn't ranged.
3. Each device plays **one 0.7 s Farina sweep, 20 Hz–20 kHz, −12 dBFS**, in its own 1.55 s slot
   (`buildTuneSlots`). Emissions are scheduled lazily (~1 s ahead) with only the browser-reported part of the
   compensation, so the measurement captures the unreported residual (e.g. Bluetooth) and any output step from
   opening a mic is already in the audio-clock mapping.
4. Every recorder maps sample index → room time through its audio clock (`ctxToRoom(startCtx + idx/sr)`, so ppm
   error is included) and analyzes locally (`analyzeRecording`). Only numbers travel: one row per emitter,
   `{emitterId, mMs, levelDb, snrDb, clipped}`, via `CALIBRATION_ROWS` to the listener. A recorder whose clock
   source or audio clock moved mid-run marks its rows invalid.

### Arrival (per recorder, per emitter)

```
y        = matched filter (cross-correlation with the sweep) over [slot − 400 ms, slot + 1000 ms]
arrival  = firstArrival(y): band envelope 1–12 kHz (raised-cosine edges, zero phase), strongest peak P, then the
           EARLIEST local peak within 5 ms before P that is ≥ P − 12 dB (a louder reflection never wins), parabolic
m        = arrival (room time) − scheduled                                  → mMs
response = deconvolved IR around the arrival → 1/24-oct grid, 1/6-oct smoothing → levelDb = 300 Hz–3 kHz mean
```

Every device plays the same sweep, so windows must not reach the next slot's earliest arrival: the 1.55 s slot
covers arrival offsets from −0.4 to +1.0 s. "Heard" needs envelope peak/median ≥ 20 dB (noise alone ≈ 12 dB).

### Solve (listener, `solveTune`)

Model: `M(r,e) = ε_e + λ_r + d(e,r)/c` — ε_e is the emitter's timing error (unreported output latency + its clock
error), λ_r the recorder's (input latency + its clock-map offset), d the distance; `d(i,i) = s ≈ 0.1 m` for a
laptop's own speaker → mic.

1. **Distances (BeepBeep).** `d_ij = c/2·(M(i,j) + M(j,i) − M(i,i) − M(j,j)) + (s_i + s_j)/2` — all clock offsets
   and latencies cancel. Devices that play through Bluetooth (each recorder reports it; also the device's caps) are
   never ranged. Every other pair must pass a gain-free co-location test on direct-path levels D (no reverb):
   `(D_ii − D_ji) + (D_jj − D_ij) ≥ 20·log10(d²/s²) − 10 dB`.
2. **Positions.** Stress majorization (`smacof2d`) on the measured distances, started from the user's layout, then a
   rigid fit (`procrustes2d`, reflection allowed) back onto it so front and left/right stay where the user put them.
   Devices without distances keep their hand placement (and are flagged).
3. **Head.** `listener = polar(mic, 180°, 0.4 m)` — the head sits ~0.4 m behind the tuning laptop. Draggable.
4. **Timing, from the listener row only.** `cal_i = M(L,i) − |p_i − mic|/c`, minus the minimum → stored as
   `calibratedLatencyMs` (slower devices start earlier). `propagationDelays()` then delays nearer speakers by
   `(d_max − d_i,head)/c`. At the mic every distance error cancels exactly; only the short mic→head step depends on
   geometry. Every constant — Wi-Fi path asymmetry, unreported Bluetooth latency, mic latency, speaker DSP — is
   absorbed.
5. **Loudness.** The listener's level per device, corrected by 1/r from mic to head, → `loudnessTrims` /
   `volumeHints` (after each device's EQ level shift).

A quick tune is the same run with only the listener recording: positions are reused, timing re-solved.

### Error budget (p95, any two devices, at the head)

| Source | Target |
|---|---|
| Acoustic arrival | ≤ 0.15 ms |
| Clock error frozen into the tune + a fresh one at play time (LAN master) | ≤ 0.4 ms |
| Mic → head geometry | ≤ 0.2 ms |
| Playback scheduling / drift loop | ≤ 0.2 ms |

Not budgeted (LIMITATIONS): laptop L/R speaker spread (±0.4 ms off-axis), Bluetooth latency jumps between tunes
(detected → re-tune prompt), headphones (no mic can hear them).

### Staying in tune

Nothing re-tunes on its own (it would pause music and open a mic unattended). A device whose clock path changes
(LAN clock master ↔ server clock) or whose output route changes raises the "audio delay changed" banner with a
one-tap quick tune; a known Bluetooth output restores its remembered value at once.

## Frequency response and EQ

- **IR** = recorded sweep ⊛ inverse filter (time-reversed sweep with a −6 dB/oct envelope), windowed around the
  peak (16384 samples at 48 kHz, with tapered pre-roll).
- **Response** = |FFT(IR)| on a 1/24-octave grid, smoothed to 1/6 octave. Rolloff is the −6 dB point below the
  300 Hz–3 kHz mean. Bass-capable means rolloff ≤ 80 Hz.
- **Target** = a gentle house curve (+3 dB below ~150 Hz, −1 dB/oct above 2 kHz) at the devices' **common**
  passband level, so different devices converge toward each other rather than each toward "flat".
- **Fit:** greedy peaking-band placement at the largest smoothed deviation, then joint gain refinement, up to 8
  bands, Q 0.5–6.
- **Rails:** max boost +6 dB, max cut −12 dB, no net boost below the device's rolloff, a protective high-pass at
  the rolloff, negative preamp to keep overall gain ≤ 0 dB, and a limiter (`DynamicsCompressorNode`, −3 dB,
  20:1) at the end of every device chain.
- **Loudness:** the sweep response's 300 Hz–3 kHz level at the listener (1/r-corrected to the head), corrected by
  each device's EQ level shift. Trims bring everyone down to the quietest device (≤ 0 dB).
- **No mic:** `classPresetEq(deviceClass)` gives conservative high-pass/shelving per phone/tablet/laptop/Bluetooth.

## Sync check

Every device plays a 100 ms wideband chirp (300 Hz–20 kHz) through **full** playback compensation and the real
playback chain, once per period, device *i* at `i·250 ms` (exact on the room timeline, so subtracted). The listener
finds each click with the same first-arrival estimator, subtracts each device's expected offset at its mic
(`expectedArrivalMs`: playback aligns at the head, not the mic), and reports per click `raw_i − mean_j raw_j`, so
its own latency cancels. Result: histogram plus per-device mean/std/p95.

## Spatial rendering (per device)

- **DBAP:** `g_i ∝ 1/(d_i² + blur²)^(rolloff/2)`, normalized so `Σ g_i² = 1` over participating devices
  (connected, positioned, unmuted; solo restricts the set).
- **Main bus** = Σ_objects `objectGains[o]` · object.
- **Bass bus** = LR4 lowpass @ `crossoverHz` of Σ `bassObjectGains[o]` · object (LFE objects, plus the
  re-routed lows of power that landed on high-passed devices), × `bassGain` = 1/√(number of bass-capable devices).
  Non-bass-capable devices are LR4 high-passed at the crossover; a `Sub` role plays only the bass bus. With no
  bass-capable device, everyone is full range and LFE folds in at −10 dB.
- **Gains** change via `setTargetAtTime` (τ ≈ 30 ms), so dragging an object makes no zipper noise.
- **Upmix** (stereo → surround, optional): C = mid at −3 dB; SL/SR = side, low-passed at 7 kHz and delayed
  12/17 ms for decorrelation; AMB = side.
