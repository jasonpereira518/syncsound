# Limitations

Honest list of what is not done, not verifiable without hardware, or constrained by the platform.

## Platform constraints (by design)

- Spotify / Apple Music are DRM-protected: sync-only (seek-based), no spatial rendering, no EQ, no per-sample scheduling.
- DRM video (Netflix, Disney+, …) tab capture is silent; the app detects and explains this.
- iOS Safari suspends audio when backgrounded; some versions lack `AudioContext.outputLatency`.
- Bluetooth output latency is not reported by browsers; needs acoustic calibration or the manual slider.
