import type { AudioObject, Device, Scene, Vec2 } from '@syncsound/protocol';
import { todo } from './todo';

export const SPEED_OF_SOUND = 343;

export interface Speaker {
  id: string;
  pos: Vec2;
}

/** DBAP: g_i ∝ 1/(d_i² + blur²)^(rolloff/2), normalized so Σ g_i² = 1. Returns gains keyed by speaker id. */
export function dbapGains(
  _source: Vec2,
  _speakers: Speaker[],
  _opts?: { rolloff?: number; blur?: number },
): Record<string, number> {
  return todo('dbapGains');
}

export interface DeviceMix {
  /** linear gain per object id for this device (includes object gainDb/mute; excludes LFE objects) */
  objectGains: Record<string, number>;
  /** linear gain of the bass bus (LFE + lows of all objects below crossover) on this device; 0 if not bass-capable */
  bassGain: number;
  /** high-pass applied to this device's main bus (crossover when bass is managed, or protective rolloff), null = none */
  highpassHz: number | null;
  /** propagation time-alignment delay for this device, s */
  delaySec: number;
  /** final linear output gain: master volume × device volume × trim × mute/solo */
  outputGain: number;
}

export interface MixInput {
  scene: Scene;
  devices: Device[];
  /** room master volume 0..1 */
  masterVolume: number;
}

/**
 * Per-device mix from the shared scene. Only connected devices that have a position in scene.devices take
 * part in panning. Bass management: LFE objects + content below crossoverHz go to bass-capable devices
 * (equal-power split); non-bass-capable devices are high-passed at crossoverHz when at least one bass-capable
 * device exists. With no bass-capable device everyone is full-range (only protective rolloff HPs apply).
 */
export function computeDeviceMix(_input: MixInput, _deviceId: string): DeviceMix {
  return todo('computeDeviceMix');
}

/** delay_i = (d_max − d_i)/c for each positioned device (s). */
export function propagationDelays(_scene: Scene, _deviceIds: string[]): Record<string, number> {
  return todo('propagationDelays');
}

export type PresetName = 'stereo' | 'surround51' | 'party' | 'frontStage';

/** Device + object positions for a preset layout (devices ordered as given). */
export function presetLayout(
  _preset: PresetName,
  _deviceIds: string[],
  _scene: Scene,
): { devices: Record<string, Vec2>; objects: AudioObject[] } {
  return todo('presetLayout');
}

/** Default objects for a source with N channels (1 mono, 2 stereo, 6 = 5.1 in WAV order L R C LFE SL SR). */
export function defaultObjectsFor(_channels: number, _upmix: boolean): AudioObject[] {
  return todo('defaultObjectsFor');
}

/** Map of object channel → source channel index for a given channel count (WAV/WebAudio 5.1 order). */
export function channelIndexFor(_channel: AudioObject['channel'], _channels: number): number | null {
  return todo('channelIndexFor');
}
