import type { AudioObject, Device, Scene, Vec2 } from '@syncsound/protocol';
import { isRoutedLayout } from './layout';
import { vbapGains } from './vbap';
import { dbToGain } from './loudness';

export const SPEED_OF_SOUND = 343;
/** LFE fold-in level when no bass-capable device participates, dB (split equal-power over participants). */
export const LFE_FOLD_DB = -10;

export interface Speaker {
  id: string;
  pos: Vec2;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** DBAP: g_i ∝ 1/(d_i² + blur²)^(rolloff/2), normalized so Σ g_i² = 1. Returns gains keyed by speaker id. */
export function dbapGains(
  source: Vec2,
  speakers: Speaker[],
  opts: { rolloff?: number; blur?: number } = {},
): Record<string, number> {
  const a = opts.rolloff ?? 1;
  const r2 = (opts.blur ?? 0.5) ** 2;
  const raw = speakers.map((s) => Math.pow(dist(source, s.pos) ** 2 + r2, -a / 2));
  const norm = Math.sqrt(raw.reduce((t, g) => t + g * g, 0));
  const out: Record<string, number> = {};
  speakers.forEach((s, i) => (out[s.id] = raw[i]! / norm));
  return out;
}

export interface DeviceMix {
  /** linear gain per object id for this device (includes object gainDb/mute; excludes LFE objects) */
  objectGains: Record<string, number>;
  /**
   * Linear gain of each object INTO the bass bus (identical on every device; apply before bassGain).
   * LFE objects: dbToGain(gainDb)·!muted. Other objects: the share of their panned power that landed on
   * devices high-passed at the crossover (√Σ g² over non-bass-capable devices), so the lows those devices
   * can't play are re-routed instead of lost or doubled. 0 for everything but LFE when bass isn't managed.
   * Bass bus = lowpass_crossover(Σ_obj bassObjectGains[obj] · obj signal).
   */
  bassObjectGains: Record<string, number>;
  /** linear gain of the bass bus on this device; 0 if not bass-capable (see computeDeviceMix for the no-sub fold-in) */
  bassGain: number;
  /**
   * High-pass for this device's output (main + bass), null = none. Crossover (≥ rolloff) for non-bass-capable
   * devices when bass is managed, else the protective device.eq.highpassHz. It already INCLUDES eq.highpassHz:
   * build the device EQ chain without it (eqToBiquads({ ...eq, highpassHz: null })).
   */
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

const isBassDevice = (d: Device) => d.bassCapable || d.role === 'Sub';

/** Connected, positioned, unmuted devices; if any of those is solo, only the solo ones. */
export function participatingDevices(input: MixInput): Device[] {
  const base = input.devices.filter((d) => d.connected && !d.muted && input.scene.devices[d.id]);
  return base.some((d) => d.solo) ? base.filter((d) => d.solo) : base;
}

/** The devices objects pan over: participants (minus unassigned ones in a standard layout), subs only if all are subs. */
export function pannerDevices(input: MixInput): Device[] {
  const routed = isRoutedLayout(input.scene.layout);
  const parts = participatingDevices(input).filter((d) => !routed || d.role !== 'Full');
  const nonSub = parts.filter((d) => d.role !== 'Sub');
  return nonSub.length ? nonSub : parts;
}

/**
 * Per-device mix from the shared scene.
 * - Participants: connected, positioned (scene.devices), unmuted devices; when any participant is solo, ONLY the
 *   solo devices participate (they also are the only ones panned across). Non-participants get outputGain 0.
 * - Panning: vbapGains over participants except role 'Sub' (a Sub plays the bass bus only: objectGains all 0).
 *   Standard layouts (scene.layout routed) pan over their slots, so an untouched channel plays from its own slot
 *   (folding to its neighbours when empty); unassigned ('Full') devices don't participate there.
 *   Pass sceneAt(scene, roomMs) for the scene as heard while 8D motion is on.
 * - Bass managed (≥ 1 bass-capable participant; role 'Sub' counts as bass-capable): bass-capable devices get
 *   bassGain 1/√nBass and play full range (only their protective HP); others are high-passed at
 *   max(crossoverHz, rolloffHz, eq.highpassHz) and their lost lows go to the bass bus via bassObjectGains.
 * - No bass-capable device: everyone full-range with only the protective HP; LFE objects are folded in at
 *   LFE_FOLD_DB total, i.e. bassGain = dbToGain(−10)/√nParticipants on every participant.
 */
export function computeDeviceMix(input: MixInput, deviceId: string): DeviceMix {
  const { scene } = input;
  const routed = isRoutedLayout(scene.layout);
  const parts = participatingDevices(input).filter((d) => !routed || d.role !== 'Full');
  const dev = parts.find((d) => d.id === deviceId);
  const objectGains: Record<string, number> = {};
  const bassObjectGains: Record<string, number> = {};
  for (const o of scene.objects) {
    if (o.channel !== 'LFE') objectGains[o.id] = 0;
    bassObjectGains[o.id] = 0;
  }
  if (!dev) {
    const self = input.devices.find((d) => d.id === deviceId);
    return {
      objectGains,
      bassObjectGains,
      bassGain: 0,
      highpassHz: self?.eq.highpassHz ?? null,
      delaySec: 0,
      outputGain: 0,
    };
  }
  const panners = pannerDevices(input);
  const bassDevs = parts.filter(isBassDevice);
  const managed = bassDevs.length > 0;
  const smallIds = managed ? panners.filter((d) => !isBassDevice(d)).map((d) => d.id) : [];

  for (const o of scene.objects) {
    const g = o.muted ? 0 : dbToGain(o.gainDb);
    if (o.channel === 'LFE') {
      bassObjectGains[o.id] = g;
      continue;
    }
    const gains = vbapGains(o, panners, scene);
    objectGains[o.id] = (gains[deviceId] ?? 0) * g;
    bassObjectGains[o.id] = g * Math.sqrt(smallIds.reduce((s, id) => s + (gains[id] ?? 0) ** 2, 0));
  }

  const protective = dev.eq.highpassHz ?? null;
  let bassGain: number;
  let highpassHz: number | null;
  if (!managed) {
    bassGain = dbToGain(LFE_FOLD_DB) / Math.sqrt(parts.length);
    highpassHz = protective;
  } else if (isBassDevice(dev)) {
    bassGain = 1 / Math.sqrt(bassDevs.length);
    highpassHz = protective;
  } else {
    bassGain = 0;
    highpassHz = Math.max(scene.crossoverHz, dev.rolloffHz ?? 0, protective ?? 0);
  }
  const delaySec = scene.propagationComp
    ? (propagationDelays(
        scene,
        parts.map((d) => d.id),
      )[deviceId] ?? 0)
    : 0;
  const outputGain = input.masterVolume * dev.volume * dbToGain(dev.trimDb);
  return { objectGains, bassObjectGains, bassGain, highpassHz, delaySec, outputGain };
}

/** delay_i = (d_max − d_i)/c for each positioned device (s), distances to scene.listener. */
export function propagationDelays(scene: Scene, deviceIds: string[]): Record<string, number> {
  const d = deviceIds
    .filter((id) => scene.devices[id])
    .map((id) => [id, dist(scene.devices[id]!, scene.listener)] as const);
  const dmax = Math.max(0, ...d.map(([, x]) => x));
  return Object.fromEntries(d.map(([id, x]) => [id, (dmax - x) / SPEED_OF_SOUND]));
}

export type PresetName = 'stereo' | 'surround51' | 'party' | 'frontStage';

const ROOM_MARGIN = 0.3;
/** keep a point `margin` metres inside the walls */
export const clampToRoom = (p: Vec2, room: Scene['room'], margin = ROOM_MARGIN): Vec2 => ({
  x: Math.max(-room.width / 2 + margin, Math.min(room.width / 2 - margin, p.x)),
  y: Math.max(-room.depth / 2 + margin, Math.min(room.depth / 2 - margin, p.y)),
});

/** First point on a golden-angle spiral around `from` that is at least `gap` m from every `taken` point. */
export function freeSpot(from: Vec2, taken: Vec2[], room: Scene['room'], gap = 0.8): Vec2 {
  // ponytail: fixed 64-step scan, O(64·n); ample for ≤ 32 objects plus a room of speakers
  for (let i = 0; i < 64; i++) {
    const r = 0.45 * Math.sqrt(i);
    const a = i * 2.399963;
    const p = clampToRoom({ x: from.x + r * Math.cos(a), y: from.y + r * Math.sin(a) }, room);
    if (taken.every((t) => Math.hypot(t.x - p.x, t.y - p.y) >= gap)) return p;
  }
  return clampToRoom(from, room);
}

/** Scene patch for a new room size: anything left outside the new walls is pulled back onto them. */
export function resizeRoom(scene: Scene, room: Scene['room']) {
  const inside = (p: Vec2) => clampToRoom(p, room, 0);
  return {
    room,
    listener: inside(scene.listener),
    devices: Object.fromEntries(Object.entries(scene.devices).map(([id, p]) => [id, inside(p)])),
    objects: scene.objects.map((o) => ({ ...o, position: inside(o.position) })),
  };
}
/** azimuth in degrees: 0 = straight ahead (−y), +ve = to the listener's right (+x) */
export const polar = (c: Vec2, azDeg: number, r: number): Vec2 => {
  const a = (azDeg * Math.PI) / 180;
  return { x: c.x + r * Math.sin(a), y: c.y - r * Math.cos(a) };
};
const ITU_AZ: Partial<Record<AudioObject['channel'], number>> = {
  L: -30,
  R: 30,
  C: 0,
  MONO: 0,
  SL: -110,
  SR: 110,
  RL: -150,
  RR: 150,
};
const spread = (from: number, to: number, n: number) =>
  Array.from({ length: n }, (_, k) => from + ((to - from) * (k + 0.5)) / n);

/**
 * Device + object positions for a preset layout (devices ordered as given). Azimuths are around the listener.
 * - stereo: devices 0/1 at −30°/+30° (single device: 0°), the rest spread behind (110°–250°); L/R objects move to ±30°.
 * - surround51: device order L(−30°) R(+30°) C(0°) SL(−110°) SR(+110°) Sub(front-left floor), extras behind;
 *   objects move to the matching ITU positions (LFE object to the sub spot).
 * - party: devices evenly around the room on an ellipse; objects stay.
 * - frontStage: devices on a −60°…+60° arc in front of the listener; objects stay.
 */
export function presetLayout(
  preset: PresetName,
  deviceIds: string[],
  scene: Scene,
): { devices: Record<string, Vec2>; objects: AudioObject[] } {
  const { room, listener } = scene;
  const r = Math.min(2.5, 0.45 * Math.min(room.width, room.depth));
  const at = (az: number) => clampToRoom(polar(listener, az, r), room);
  const subSpot = clampToRoom({ x: -room.width / 2, y: -room.depth / 2 }, room);
  const n = deviceIds.length;
  let pos: Vec2[];
  let objects = scene.objects.map((o) => ({ ...o, position: { ...o.position } }));
  const moveObjects = (chans: AudioObject['channel'][]) =>
    (objects = objects.map((o) =>
      chans.includes(o.channel)
        ? { ...o, position: o.channel === 'LFE' ? subSpot : at(ITU_AZ[o.channel]!) }
        : o,
    ));
  switch (preset) {
    case 'stereo':
      pos = n === 1 ? [at(0)] : [at(-30), at(30), ...spread(110, 250, n - 2).map(at)];
      moveObjects(['L', 'R']);
      break;
    case 'surround51': {
      const main = [at(-30), at(30), at(0), at(-110), at(110), subSpot];
      pos = [...main.slice(0, n), ...spread(150, 210, Math.max(0, n - 6)).map(at)];
      moveObjects(['L', 'R', 'C', 'SL', 'SR', 'LFE']);
      break;
    }
    case 'party': {
      const rx = Math.max(0.1, room.width / 2 - 0.6);
      const ry = Math.max(0.1, room.depth / 2 - 0.6);
      pos = deviceIds.map((_, k) => {
        const a = (2 * Math.PI * k) / n;
        return clampToRoom({ x: rx * Math.sin(a), y: -ry * Math.cos(a) }, room);
      });
      break;
    }
    case 'frontStage':
      pos = deviceIds.map((_, k) => at(n === 1 ? 0 : -60 + (120 * k) / (n - 1)));
      break;
  }
  return { devices: Object.fromEntries(deviceIds.map((id, k) => [id, pos[k]!])), objects };
}

const DEFAULT_LISTENER: Vec2 = { x: 0, y: 1 };
const DEFAULT_ROOM = { width: 8, depth: 6 };
const objAt = (
  id: string,
  label: string,
  channel: AudioObject['channel'],
  position: Vec2,
  gainDb = 0,
): AudioObject => ({
  id,
  label,
  channel,
  position: clampToRoom(position, DEFAULT_ROOM),
  gainDb,
  muted: false,
});
const itu = (az: number) => polar(DEFAULT_LISTENER, az, 2.5);

/**
 * Default objects for a source with N channels (1 mono, 2 stereo, 6 = 5.1 in WAV order L R C LFE SL SR,
 * 8 = 7.1 in WAV order L R C LFE RL RR SL SR, sides at ±90°),
 * at ITU azimuths 2.5 m from the default listener (0, 1), clamped inside the default 8×6 m room.
 * Stereo + upmix adds C (mid, −3 dB), SL/SR (side, −6 dB) and AMB (decorrelated ambience behind, −9 dB); the
 * engine derives those from L/R (channelIndexFor returns null for them). 3–5 channels: first two as L/R.
 */
export function defaultObjectsFor(channels: number, upmix: boolean): AudioObject[] {
  if (channels <= 1) return [objAt('obj-M', 'Mono', 'MONO', itu(0))];
  const L = objAt('obj-L', 'Left', 'L', itu(-30));
  const R = objAt('obj-R', 'Right', 'R', itu(30));
  if (channels >= 8) {
    return [
      L,
      R,
      objAt('obj-C', 'Center', 'C', itu(0)),
      objAt('obj-LFE', 'LFE', 'LFE', { x: -DEFAULT_ROOM.width / 2, y: -DEFAULT_ROOM.depth / 2 }),
      objAt('obj-SL', 'Side L', 'SL', itu(-90)),
      objAt('obj-SR', 'Side R', 'SR', itu(90)),
      objAt('obj-RL', 'Rear L', 'RL', itu(-150)),
      objAt('obj-RR', 'Rear R', 'RR', itu(150)),
    ];
  }
  if (channels >= 6) {
    return [
      L,
      R,
      objAt('obj-C', 'Center', 'C', itu(0)),
      objAt('obj-LFE', 'LFE', 'LFE', { x: -DEFAULT_ROOM.width / 2, y: -DEFAULT_ROOM.depth / 2 }),
      objAt('obj-SL', 'Surround L', 'SL', itu(-110)),
      objAt('obj-SR', 'Surround R', 'SR', itu(110)),
    ];
  }
  if (!upmix) return [L, R];
  return [
    L,
    R,
    objAt('obj-C', 'Center', 'C', itu(0), -3),
    objAt('obj-SL', 'Surround L', 'SL', itu(-110), -6),
    objAt('obj-SR', 'Surround R', 'SR', itu(110), -6),
    objAt('obj-AMB', 'Ambience', 'AMB', itu(180), -9),
  ];
}

const WAV51: Partial<Record<AudioObject['channel'], number>> = { L: 0, R: 1, C: 2, LFE: 3, SL: 4, SR: 5 };
const WAV71: Partial<Record<AudioObject['channel'], number>> = { L: 0, R: 1, C: 2, LFE: 3, RL: 4, RR: 5, SL: 6, SR: 7 };

/**
 * Object channel → source channel index (WAV/WebAudio 5.1 order L0 R1 C2 LFE3 SL4 SR5; 7.1 L0 R1 C2 LFE3 RL4 RR5
 * SL6 SR7; stereo L0 R1; mono 0).
 * null = not a direct source channel (e.g. upmix-derived C/SL/SR/AMB on a stereo source).
 */
export function channelIndexFor(channel: AudioObject['channel'], channels: number): number | null {
  if (channels <= 1) return 0;
  if (channels < 6) return channel === 'L' ? 0 : channel === 'R' ? 1 : null;
  return (channels >= 8 ? WAV71 : WAV51)[channel] ?? null;
}

/**
 * 2-D layout from measured pairwise distances (stress majorization, one point at a time — Gansner et al. 2004):
 * x_i ← mean over measured j of (x_j + d_ij·unit(x_i − x_j)). Starts from `init` (the user's rough layout), so the
 * local optimum it lands in keeps that layout's shape. Ids without a measured distance are returned unchanged.
 * Also returns normalized stress √(Σ(|x_i − x_j| − d_ij)² / Σ d_ij²): ≈ 0 when the distances embed in a plane.
 */
export function smacof2d(
  init: Record<string, Vec2>,
  d: Record<string, Record<string, number>>,
  iterations = 300,
): { positions: Record<string, Vec2>; stress: number } {
  const pos: Record<string, Vec2> = Object.fromEntries(Object.entries(init).map(([id, p]) => [id, { ...p }]));
  const ids = Object.keys(d).filter((id) => pos[id] && Object.keys(d[id]!).some((j) => pos[j]));
  for (let it = 0; it < iterations; it++) {
    for (const i of ids) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const [j, dij] of Object.entries(d[i]!)) {
        const pj = pos[j];
        if (!pj) continue;
        let dx = pos[i]!.x - pj.x;
        let dy = pos[i]!.y - pj.y;
        let r = Math.hypot(dx, dy);
        if (r < 1e-9) [dx, dy, r] = [1e-3, 0, 1e-3]; // coincident start: any direction
        sx += pj.x + (dij * dx) / r;
        sy += pj.y + (dij * dy) / r;
        n++;
      }
      if (n) pos[i] = { x: sx / n, y: sy / n };
    }
  }
  let num = 0;
  let den = 0;
  for (const i of ids)
    for (const [j, dij] of Object.entries(d[i]!)) {
      if (!pos[j] || j <= i) continue;
      num += (dist(pos[i]!, pos[j]) - dij) ** 2;
      den += dij * dij;
    }
  return { positions: pos, stress: den > 0 ? Math.sqrt(num / den) : 0 };
}

/**
 * Rigid 2-D fit (rotation, optional reflection, translation; no scale) of `src` onto `dst` over their shared ids,
 * applied to every point of `src`. Keeps a measured layout facing the way the user placed things (front, left/right).
 * Fewer than 2 shared points: translation only.
 */
export function procrustes2d(src: Record<string, Vec2>, dst: Record<string, Vec2>): Record<string, Vec2> {
  const ids = Object.keys(src).filter((id) => dst[id]);
  if (!ids.length) return src;
  const mean = (m: Record<string, Vec2>) => ({
    x: ids.reduce((a, id) => a + m[id]!.x, 0) / ids.length,
    y: ids.reduce((a, id) => a + m[id]!.y, 0) / ids.length,
  });
  const cs = mean(src);
  const cd = mean(dst);
  // best rotation of (optionally x-mirrored) centred src onto centred dst: θ = atan2(Σ cross, Σ dot)
  const fit = (flip: number) => {
    let a = 0;
    let b = 0;
    for (const id of ids) {
      const x = flip * (src[id]!.x - cs.x);
      const y = src[id]!.y - cs.y;
      const u = dst[id]!.x - cd.x;
      const v = dst[id]!.y - cd.y;
      a += x * u + y * v;
      b += x * v - y * u;
    }
    return { flip, th: ids.length < 2 ? 0 : Math.atan2(b, a), score: Math.hypot(a, b) };
  };
  const plain = fit(1);
  const mirror = fit(-1);
  const best = ids.length >= 3 && mirror.score > plain.score ? mirror : plain;
  const c = Math.cos(best.th);
  const s = Math.sin(best.th);
  return Object.fromEntries(
    Object.entries(src).map(([id, p]) => {
      const x = best.flip * (p.x - cs.x);
      const y = p.y - cs.y;
      return [id, { x: cd.x + c * x - s * y, y: cd.y + s * x + c * y }];
    }),
  );
}
