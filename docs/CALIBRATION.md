# Calibration, EQ and spatial math

All of this lives in `packages/audio-core` (pure TypeScript, unit-tested) and is exercised end to end by
`packages/sim/test/calibration.test.ts` and the loopback-mic E2E.

## Tune (calibration v3)

One tap on any laptop ("the listener") tunes the room. Target: **p95 < 1 ms between any two devices at the
listener's head**. Laptops first; phones later.

### Run

1. The listener opens its mic, settles 1.5 s, waits for its clocks to settle (`clockSettled`, below) and sends
   `CALIBRATION_START` with `recorders: 'all'`. The server refuses a second run while one is active
   (`calibration_busy`), stamps `startRoomTime = now + max(lead, 3.5 s)` and broadcasts the plan. The LAN clock
   master pins its mapping for the whole run (`holdMapping`): every device then times the run on one snapshot of the
   WAN estimate, so its movement cancels between every emitter and every recorder.
2. Every other device with a usable mic opens it as soon as the plan arrives (never a Bluetooth-headset mic, which
   would flip the headset into its hands-free profile) and records until the plan ends. No mic / no permission →
   it still plays, it just isn't ranged.
3. Each device plays **one 1.1 s swoosh → chime** (`tuneSignalParts`) in its own 1.55 s slot (`buildTuneSlots`): a
   0.6 s exponential sweep, 20 Hz–20 kHz, −12 dBFS peak (30 ms fade-in; above 14 kHz tapered to −10 dB at 20 kHz,
   which takes the shrill edge off without touching the 1–12 kHz arrival band), landing on a 0.5 s bell chime (C6
   with its G6 fifth and two harmonics, integer ratios, −16.5 dBFS peak). Nothing else plays: the Bluetooth wobble
   readout comes from the manual sync check. Emissions are scheduled lazily (~1 s ahead) with only the browser-reported part of the
   compensation, so the measurement captures the unreported residual (e.g. Bluetooth) and any output step from
   opening a mic is already in the audio-clock mapping.
4. Every recorder maps sample index → room time through `frozenRoomMap`: the audio clock's long-baseline rate
   (256 s window, ≈ 3 ppm after a minute) times the room clock's drift slope, frozen 300 ms before the first slot
   and anchored at the first recorded sample — never a finite difference over the live clocks, whose pending slew
   (1 ms/s) would read as up to ±1000 ppm (0.3 ms per slot). It analyzes locally (`analyzeRecording`). Only
   numbers travel: one row per emitter, `{emitterId, mMs, levelDb, snrDb, clipped}`, via `CALIBRATION_ROWS` to the
   listener. A recorder whose clocks moved mid-run (see validity) marks its rows invalid.

### Preconditions and validity

- **Settled clocks** (`clockSettled`): the listener waits, up to 30 s, until its room clock has converged and
  wasn't just re-acquired (≥ 3 s), the in-room clock link is up when there is a master, and no slew is pending
  (≤ 0.3 ms) — else the run errors ("The room clock hasn't settled yet"). It also waits, up to 20 s, for the drift
  fit (SE ≤ 30 ppm), the network (jitter ≤ 3 ms) and the audio clock's long-baseline rate (SE ≤ 15 ppm) — else it
  proceeds with the warning "The clocks were still settling". A tune started within ~30 s of joining typically
  waits 10–20 s ("Letting the clocks settle…"). A recorder that fails a hard criterion sends invalid rows.
- **Validity** (`runValidity`): every device snapshots its clock path, `ClockSync` reset count, audio-clock step
  count and a frozen copy of its mapping at the freeze (recorders, the listener) or its first emission. At the end
  the run is invalid if any changed, or if the live mapping moved more than 1 ms from the frozen one (a slew or a
  step during the run). The listener discards and retries once, then errors. A recorder's rows carry
  `emissionValid`; a device that only emitted reports a fault with `CALIBRATION_ROWS { emissionValid: false }`.
  Faulted devices are left untimed, with a named warning ("X wasn't timed: the clock path changed during the run").
- **One run at a time**: the server answers a second `CALIBRATION_START` with `calibration_busy` until the result
  arrives, the listener cancels (`CALIBRATION_CANCEL` → `CALIBRATION_CANCELLED` to all, which stops every chime
  and recording) or leaves, or the recording's end plus 5 s has passed.

### Arrival (per recorder, per emitter)

```
y        = matched filter (cross-correlation with the SWOOSH only: the chime's tonal autocorrelation would put
           near-peak sidelobes before the direct path) over [slot − 400 ms, slot + 1000 ms]
arrival  = firstArrival(y): band envelope 1–12 kHz (raised-cosine edges, zero phase), strongest peak P, then the
           EARLIEST local peak within 5 ms before P that is ≥ P − 12 dB (a louder reflection never wins), parabolic
m        = arrival (room time) − scheduled                                  → mMs
response = whole signal deconvolved (regularized inverse) around the arrival → 1/24-oct grid, 1/6-oct smoothing
levelDb  = loudnessDb(response): K-weighted (≈ BS.1770 +4 dB shelf at 1.7 kHz) power mean, 200 Hz–8 kHz
```

Every device plays the same signal, so search windows must not reach the next slot's earliest arrival: the 1.55 s
slot covers arrival offsets from −0.4 to +1.0 s. A late device's response segment (signal + IR window + 50 ms) may
reach into the next slot's start; that is the same signal, so it deconvolves a whole slot later, far outside the
IR window (unit test: 300 ms late, next device on time, response within 0.5 dB). The slot is kept short on purpose:
the recorders' ±20 ppm rate error accumulates between slots and costs ranging (a 2 s slot moved the sim's worst
distance error from 0.144 to 0.150 m). "Heard" needs envelope peak/median ≥ 20 dB (noise alone ≈ 12 dB).

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
4. **Timing, from the listener row only.** The run stores, per heard device, its raw arrival at the listener's mic
   relative to the earliest device of the run (`Device.tuneArrivalMs` = `M(L,i) − min`), the run's id
   (`Device.tuneId`), and in the room's `scene.tune` the mic position, the positions the arrivals were measured at
   and the run's id. The server derives the compensation (`deriveCalibratedLatency`, re-evaluated on every scene
   edit, join, result and profile restore):

   `cal_i = A_i − |q_i − mic|/c − (|p_i − L| − |q_i − L|)/c`, minus the minimum → `calibratedLatencyMs`

   with `q_i` the device's position at tune time, `p_i` its position now and `L` the listener now (the listener's
   own path is the 0.1 m prior). `propagationDelays()` then delays nearer speakers by `(d_max − d_i,head)/c`. The
   first term is the device's latency as the tune measured it: at the mic every distance error cancels exactly, and
   every constant — Wi-Fi path asymmetry, unreported Bluetooth latency, mic latency, speaker DSP — is absorbed. The
   second term moves exactly as the engine's propagation delay moves when the picture is edited, so a layout
   change, a drag or an auto-placement never changes when a tuned device's sound reaches the head
   (`tuneInvariant.test.ts`: 0.000 ms change; the previous frozen value missed by p95 2.96 ms after a 1 m drag).
   Only the short mic→head step depends on geometry.
5. **Loudness.** The listener's level per device, corrected by 1/r from mic to head and by each device's EQ level
   shift, → `loudnessTrims` / `volumeHints`: everyone meets at the **median** — loud devices are cut, soft ones
   boosted by up to +6 dB (`MAX_BOOST_DB`); a device still short after that gets "turn it up by ~X dB". With two
   or more other devices the median is theirs: the listener's own level rests on a near-field prior (its speaker
   0.1 m from its mic), so a misread listener can never pull everyone else down.

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

Nothing re-tunes on its own (it would pause music and open a mic unattended). Instead every device carries a
**tune identity** and the room shows a **sync state** per device:

| `syncState` | Meaning | Timing used |
|---|---|---|
| `tuned` | `tuneId` is the room's current run and the device reported nothing since | derived compensation |
| `stale` | tuned, but the device reported its timing may be off (`tuneStale`: a new output route, a clock-path change, an audio-output step) | derived compensation, flagged "needs tuning again" on every screen |
| `untuned` | never tuned, tuned in an earlier run, or not heard / not timed in the current one | none (0 + the manual nudge) |

- **Every run is a new tune.** Arrivals are relative to the earliest device *of that run*, so a value from another
  run cannot be compared; devices the run did not hear (or could not time) become `untuned` and the host sees
  "N speakers, 1 needs tuning". A quick (timing-only) run keeps positions, levels, EQ and the previous ranging.
- **The picture is free.** Layout changes keep ranged devices where the tune measured them (`placeForLayout`) and
  move only hand-placed ones to their slot; either way the derived compensation follows the edit (step 4), so
  nothing has to be re-tuned after rearranging the stage. A **speaker that physically moved** needs a new tune: its
  arrival was measured where it was (sim: 2.9 ms off per metre until the next tap). The listener icon is where the
  sound is aimed; moving it re-aims the engine's delays (the tune puts it 0.4 m behind the tuning laptop).
- **Late joiners** in a laid-out room take the next free slot and its canonical spot (nobody else moves) and are
  `untuned` until the next tune.
- **Route changes.** A device whose output route changes, or whose clock path changes (LAN clock master ↔ server
  clock), reports `tuneStale` to the room (so the host sees "needs tuning again (output changed)") and raises the
  "audio delay changed" banner with a one-tap quick tune. A known Bluetooth output restores its remembered
  `{ tuneId, tuneArrivalMs }` at once, which counts only while that tune is still the room's; a new output clears
  the timing, the level trim and the EQ (they belonged to the previous output).
- **Profiles** carry `tuneArrivalMs` / `tuneId` / `tuneStale` (never the derived value); a legacy profile with only
  `calibratedLatencyMs` joins `untuned`.
- A tune started from any screen shows its progress, result, warnings and error there (`TuneStatus`).

## Frequency response and EQ

- **IR** = recording ⊛ regularized inverse of the whole tune signal (`calibrationInverse`: X*/(|X|² + λ), λ tiny in
  20 Hz–19 kHz and large outside, half-octave edges; a Farina inverse would turn the chime into tones inside the IR
  window), windowed around the peak (16384 samples at 48 kHz, with tapered pre-roll). The swoosh's second-harmonic
  image lands 60 ms before the peak, outside the 43 ms pre-roll.
- **Response** = |FFT(IR)| on a 1/24-octave grid, smoothed to 1/6 octave. Rolloff is the −6 dB point below the
  300 Hz–3 kHz mean. Bass-capable means rolloff ≤ 80 Hz.
- **Target** = a gentle house curve (+3 dB below ~150 Hz, −1 dB/oct above 2 kHz) at the devices' **common**
  passband level, so different devices converge toward each other rather than each toward "flat".
- **Fit:** greedy peaking-band placement at the largest smoothed deviation, then joint gain refinement, up to 8
  bands, Q 0.5–6.
- **Rails:** max boost +6 dB, max cut −12 dB, no net boost below the device's rolloff, a protective high-pass at
  the rolloff, negative preamp to keep overall gain ≤ 0 dB, and a limiter (`DynamicsCompressorNode`, −3 dB,
  20:1) at the end of every device chain. The loudness trim sits **before** the limiter (`DeviceMix.trimGain`;
  volume after it, `volumeGain`), so a +6 dB boost is limited (≈ −0.8 dBFS ceiling incl. the node's makeup gain),
  never clipped.
- **Loudness:** the response's K-weighted power mean (200 Hz–8 kHz: above any crossover, through the treble where
  small speakers differ most) at the listener, 1/r-corrected to the head and corrected by each device's EQ level
  shift. Trims meet at the median: −24…+6 dB.
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
