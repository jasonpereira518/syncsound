/**
 * One line about the room's tune and the one thing to do about it: the "Tune" verb picks a full run (positions,
 * levels, EQ, timing) when a speaker has never been tuned, a timing-only run when every speaker is tuned but some
 * report their timing may be off, and a full run again when everything is fine. Pure, shared by the setup screen,
 * Now Playing and the tests.
 */
import type { Device, TuneRef } from '@syncsound/protocol';

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
