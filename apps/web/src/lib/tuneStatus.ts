/**
 * One line about the room's tune and the one thing to do about it: the "Tune" verb picks a full run (positions,
 * levels, EQ, timing) when a speaker has never been tuned, a timing-only run when every speaker is tuned but some
 * report their timing may be off, and a full run again when everything is fine. Pure, shared by the setup screen,
 * Now Playing and the tests.
 */
import type { Device, TuneDeviceState, TuneHint, TuneRef } from '@syncsound/protocol';
import type { TuneSelfStatus } from '../store/types';

export type TuneMode = 'full' | 'quick';

export interface TuneStatusView {
  state: 'none' | 'partial' | 'stale' | 'tuned';
  label: string;
  action: string;
  mode: TuneMode;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function tuneStatus(live: ReadonlyArray<Pick<Device, 'name' | 'syncState'>>, tune: TuneRef | undefined): TuneStatusView {
  const n = live.length;
  const tuned = live.filter((d) => d.syncState === 'tuned').length;
  const stale = live.filter((d) => d.syncState === 'stale');
  const untuned = live.filter((d) => d.syncState === 'untuned');
  if (!tune || (tuned === 0 && stale.length === 0)) return { state: 'none', label: 'Not tuned yet', action: 'Tune the room', mode: 'full' };
  if (untuned.length) return { state: 'partial', label: `${n - untuned.length} of ${plural(n, 'speaker')} tuned`, action: 'Tune', mode: 'full' };
  if (stale.length)
    return {
      state: 'stale',
      label: stale.length === 1 ? `${stale[0]!.name} needs tuning again` : `${plural(stale.length, 'speaker')} need tuning again`,
      action: 'Tune',
      mode: 'quick',
    };
  return { state: 'tuned', label: `Tuned · ${plural(n, 'speaker')}`, action: 'Tune again', mode: 'full' };
}

/** a device's line while the tune's rounds play: what the listener knows so far, and what to do about it */
export function liveTuneText(state: TuneDeviceState | undefined, hint: TuneHint | null | undefined, spreadMs: number | null | undefined): string {
  switch (state) {
    case 'in-sync':
      return 'in sync';
    case 'checking':
      return 'heard, checking again';
    case 'varies':
      return `timing varies by ±${(spreadMs ?? 0).toFixed(1)} ms`;
    case 'too-loud':
      return 'too loud for the microphone: turn it down a little';
    case 'not-heard':
      return hint === 'clock' ? 'its clock moved while it played: it plays again' : 'not heard: turn its volume up and unmute it, it plays again';
    case 'skipped':
      return hint === 'left' ? 'left the room' : hint === 'clock' ? 'skipped: its clock kept moving' : 'skipped: not heard';
    default:
      return 'waiting for its chime';
  }
}

/** what this speaker's own banner says, or null when there's nothing for the person next to it to do */
export function selfTuneLine(st: TuneSelfStatus): string | null {
  if (!st.done) {
    if (st.state === 'too-loud') return 'This speaker is too loud for the tuning microphone. Turn it down a little: it plays again in a few seconds.';
    if (st.state !== 'not-heard') return null;
    return st.hint === 'clock'
      ? "This speaker's clock moved while it played. Keep this screen open: it plays again in a few seconds."
      : "The tune can't hear this speaker. Turn its volume up and unmute it: it plays again in a few seconds.";
  }
  if (st.state !== 'skipped' && st.state !== 'not-heard') return null;
  if (st.hint === 'left') return null;
  return st.hint === 'clock'
    ? "This speaker couldn't be timed (its clock kept moving). Tune again to include it."
    : "The tune couldn't hear this speaker, so it isn't tuned. Turn it up and tune again.";
}
