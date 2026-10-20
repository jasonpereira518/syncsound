# Calibration, EQ and spatial math

All of this lives in `packages/audio-core` (pure TypeScript, unit-tested) and is exercised end to end by
`packages/sim/test/calibration.test.ts` and the loopback-mic E2E.

## Plan

The listening device asks the server for a run (`CALIBRATION_START`). The server assigns
`startRoomTime = now + max(lead, 1.5 s)` and broadcasts the plan. For device *i*, in its own time slots:

| Signal | Length | Purpose |
|---|---|---|
| log chirp in a device-unique band (`chirpBand(i)`, ~500 Hz–8 kHz) | 400 ms | arrival time → latency; "which speaker is which" |
| Farina exponential sweep 40 Hz–16 kHz | 2 s | impulse response → frequency response |
| pink noise | 1 s | loudness |

Slots are separated by `maxLatencyMs (500) + 200 ms` guards, so even Bluetooth-delayed arrivals never overlap.
Speakers emit with **only** the browser-reported part of their compensation, so the measurement captures the
unreported residual (e.g. Bluetooth).

## Latency

The recording's first sample is mapped to room time via the listener's audio-clock map. For a device:

```
arrival      = matched-filter peak of its chirp (FFT cross-correlation, envelope, parabolic sub-sample)
rawLatency   = arrival − scheduled − distance/343        (includes the listener's input latency)
relative_i   = rawLatency_i − min_j rawLatency_j         → stored as calibratedLatencyMs
```

The listener's own input latency and clock error are common to every device, so they cancel. Devices then start
`relative_i` earlier; everyone aligns to the fastest device.

**Propagation alignment** (toggle on the stage): `delay_i = (d_max − d_i)/c`. This is subtracted from the
compensation, so nearer speakers wait and all wavefronts reach the listener together.

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
- **Loudness:** pink-noise RMS minus the noise floor (power subtraction), corrected by each device's EQ level
  shift. Trims bring everyone down to the quietest device (≤ 0 dB).
- **No mic:** `classPresetEq(deviceClass)` gives conservative high-pass/shelving per phone/tablet/laptop/Bluetooth.

## Sync measurement

All devices emit their device-unique chirp **simultaneously**, once per second, through **full** playback
compensation (scheduled with a 1.5 s lookahead, like real playback). The listener separates devices by matched
filter and reports, per click, `raw_i − mean_j raw_j`, so listener latency cancels. The result is a histogram
plus per-device mean/std/p95.

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
