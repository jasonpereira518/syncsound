/**
 * Azimuth panning (2-D VBAP-style): each object plays from the pair of speaker directions around it, sine/cosine law,
 * so a sound at a speaker is that speaker alone and moves sharply from speaker to speaker. Standard layouts pan over
 * their slots (devices sharing a slot split it equal-power); 'custom' pans over each placed device's direction;
 * 'party' plays the whole mix everywhere unless 8D motion is on. Sounds dragged close to the listener spread over
 * every speaker, so crossing the room washes through it instead of jumping.
 */
import type { AudioObject, Device, DeviceRole, LayoutId, Scene, Vec2 } from '@syncsound/protocol';
import { isRoutedLayout, slotAzimuth, slotRadius, type Slot } from './layout';

const DEG = Math.PI / 180;
/** (−180, 180] */
export const wrapDeg = (d: number) => {
  const w = (((d + 180) % 360) + 360) % 360 - 180;
  return w === -180 ? 180 : w;
};

/** degrees: 0 = ahead (−y), +ve = to the listener's right (+x) */
export const azimuthOf = (p: Vec2, listener: Vec2) => Math.atan2(p.x - listener.x, -(p.y - listener.y)) / DEG;

/** devices nearer the listener than this have no usable direction; they take an equal share of everything */
const OMNI_M = 0.25;
/** a standard-layout object within SNAP_IN of its channel's home direction plays from that slot exactly */
const SNAP_IN = 10;
const SNAP_OUT = 20;
/** spread reaches 0 at this fraction of the speaker ring radius */
const SPREAD_EDGE = 0.5;
/** narrowest cross-fade across a gap wider than 180° (e.g. behind a front-only layout), degrees */
const MIN_WINDOW = 60;

/**
 * Power-normalized gains (Σg² = 1) for a direction over a ring of speaker directions (degrees, any order).
 * Between two neighbours ≤ 180° apart: sine/cosine law across the whole gap. Wider gaps (nothing behind you) hold
 * the nearer neighbour and cross-fade only over the middle of the gap, so a surround channel in a stereo room
 * stays on its own side and a sound circling behind passes smoothly between the two.
 */
export function ringGains(az: number, ring: number[]): number[] {
  const n = ring.length;
  const out = ring.map(() => 0);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = 1;
    return out;
  }
  const norm = ring.map((a) => (((a % 360) + 360) % 360));
  const order = norm.map((_, i) => i).sort((a, b) => norm[a]! - norm[b]!);
  const t = ((az % 360) + 360) % 360;
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const j = order[(k + 1) % n]!;
    const from = norm[i]!;
    const gap = k === n - 1 ? norm[j]! + 360 - from : norm[j]! - from;
    let pos = t - from;
    if (pos < 0) pos += 360;
    if (pos > gap) continue;
    if (gap < 1e-9) {
      out[i] = 1;
      return out;
    }
    const win = gap <= 180 ? gap : Math.max(MIN_WINDOW, 360 - gap);
    const x = Math.min(1, Math.max(0, (pos - (gap - win) / 2) / win));
    // exact 0/1 at the ends, so a sound on a speaker is silent everywhere else
    out[i] = x === 1 ? 0 : Math.cos((x * Math.PI) / 2);
    out[j] = x === 0 ? 0 : Math.sin((x * Math.PI) / 2);
    return out;
  }
  return out;
}

/** where a channel lives in a standard layout (null = no home: it pans purely by position) */
function homeAz(channel: AudioObject['channel'], layout: LayoutId): number | null {
  switch (channel) {
    case 'L':
    case 'R':
    case 'C':
    case 'SL':
    case 'SR':
    case 'RL':
    case 'RR':
      return slotAzimuth(channel as Slot, layout);
    case 'MONO':
      return 0;
    case 'AMB':
      return 180;
    default:
      return null;
  }
}

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

interface Group {
  ids: string[];
  az: number | null;
}

/**
 * Gains per device id for one (non-LFE) object over `devices` (the panners: participants, subs excluded).
 * Σg² = 1 whenever any device is given.
 */
export function vbapGains(
  object: Pick<AudioObject, 'channel' | 'position'>,
  devices: Pick<Device, 'id' | 'role'>[],
  scene: Pick<Scene, 'layout' | 'listener' | 'devices' | 'room' | 'motion'>,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!devices.length) return out;
  const { listener } = scene;
  const routed = isRoutedLayout(scene.layout);

  const groups: Group[] = [];
  let radius: number;
  if (routed) {
    const bySlot = new Map<DeviceRole, string[]>();
    for (const d of devices) bySlot.set(d.role, [...(bySlot.get(d.role) ?? []), d.id]);
    for (const [role, ids] of bySlot)
      groups.push({ ids, az: role === 'Sub' || role === 'Full' ? null : slotAzimuth(role, scene.layout) });
    radius = slotRadius(scene.room);
  } else {
    const dists: number[] = [];
    for (const d of devices) {
      const p = scene.devices[d.id];
      const r = p ? Math.hypot(p.x - listener.x, p.y - listener.y) : 0;
      if (p && r >= OMNI_M) {
        const az = azimuthOf(p, listener);
        // devices in (almost) the same direction share it
        const same = groups.find((g) => g.az !== null && Math.abs(wrapDeg(g.az - az)) < 0.5);
        if (same) same.ids.push(d.id);
        else groups.push({ ids: [d.id], az });
        dists.push(r);
      } else groups.push({ ids: [d.id], az: null });
    }
    radius = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 2;
  }

  const ring = groups.filter((g) => g.az !== null);
  const omni = groups.length - ring.length;
  const dist = Math.hypot(object.position.x - listener.x, object.position.y - listener.y);
  let az = dist > 1e-9 ? azimuthOf(object.position, listener) : 0;
  let spread = 1 - smoothstep(dist / (SPREAD_EDGE * radius));

  if (routed) {
    const home = homeAz(object.channel, scene.layout!);
    if (home !== null) {
      const delta = wrapDeg(az - home);
      const a = Math.abs(delta);
      // dead zone around home, then a ramp that meets the true direction at SNAP_OUT (continuous for 8D sweeps)
      const away = Math.min(1, Math.max(0, (a - SNAP_IN) / (SNAP_OUT - SNAP_IN)));
      az = home + delta * away;
      if (object.channel === 'MONO') spread = Math.max(spread, 1 - away); // untouched mono plays from every slot
    }
  } else if (scene.layout === 'party' && !scene.motion) {
    spread = 1; // "Everywhere": every speaker plays the whole mix
  }
  if (!ring.length) spread = 1;

  const v = ringGains(
    az,
    ring.map((g) => g.az!),
  );
  const n = groups.length;
  const dirShare = 1 - omni / n;
  let k = 0;
  for (const g of groups) {
    const p = g.az === null ? 1 / n : dirShare * ((1 - spread) * v[k++]! ** 2 + spread / ring.length);
    const each = Math.sqrt(p / g.ids.length);
    for (const id of g.ids) out[id] = each;
  }
  return out;
}

/** 8D: the mix is squeezed to this fraction of its width so it reads as one sound travelling round the room */
export const ORBIT_WIDTH = 0.3;

/** orbit angle (degrees) at a room time; 0 when the scene is still */
export function orbitAngle(motion: Scene['motion'], roomMs: number): number {
  if (!motion) return 0;
  return wrapDeg((360 * (roomMs - motion.startRoomTime)) / (motion.periodSec * 1000));
}

/**
 * The scene as heard at `roomMs`: with 8D on, every (non-LFE) object is narrowed toward straight ahead by
 * ORBIT_WIDTH and turned by the orbit angle around the listener (distances kept). A pure function of room time,
 * so every device computes the same position without extra messages.
 */
export function sceneAt<S extends Pick<Scene, 'objects' | 'listener' | 'motion'>>(scene: S, roomMs: number): S {
  if (!scene.motion) return scene;
  const turn = orbitAngle(scene.motion, roomMs);
  const { listener } = scene;
  const objects = scene.objects.map((o) => {
    if (o.channel === 'LFE') return o;
    const r = Math.hypot(o.position.x - listener.x, o.position.y - listener.y);
    if (r < 1e-9) return o;
    const a = (turn + ORBIT_WIDTH * wrapDeg(azimuthOf(o.position, listener))) * DEG;
    return { ...o, position: { x: listener.x + r * Math.sin(a), y: listener.y - r * Math.cos(a) } };
  });
  return { ...scene, objects };
}
