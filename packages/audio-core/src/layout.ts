/**
 * Speaker layouts: one model for "which speaker plays what". A standard layout is a list of slots; each device's
 * slot is its `role`. Content channels route to the devices in the matching slot (equal-power split when a slot
 * has several devices), folding down when the slot is empty. 'party' / 'custom' pan by position (DBAP) instead.
 */
import type { Device, DeviceClass, DeviceRole, LayoutId, ObjectChannel, Scene, Vec2 } from '@syncsound/protocol';

export type Slot = Exclude<DeviceRole, 'Sub' | 'Full'>;

export const LAYOUT_SLOTS: Record<LayoutId, Slot[]> = {
  mono: ['C'],
  stereo: ['L', 'R'],
  lcr: ['L', 'C', 'R'],
  quad: ['L', 'R', 'SL', 'SR'],
  surround5: ['L', 'R', 'C', 'SL', 'SR'],
  surround7: ['L', 'R', 'C', 'SL', 'SR', 'RL', 'RR'],
  party: [],
  custom: [],
};

/** standard layouts route by slot; the others pan by position */
export const isRoutedLayout = (layout: LayoutId | undefined): layout is LayoutId =>
  !!layout && LAYOUT_SLOTS[layout].length > 0;

/** "5.1 Surround", "Stereo"… for the UI */
export function layoutLabel(layout: LayoutId, hasSub: boolean): string {
  const base: Record<LayoutId, string> = {
    mono: 'Mono',
    stereo: 'Stereo',
    lcr: 'Left · Centre · Right',
    quad: 'Quad',
    surround5: '5.0 Surround',
    surround7: '7.0 Surround',
    party: 'Everywhere',
    custom: 'Custom',
  };
  if (!hasSub) return base[layout];
  const dot1: Partial<Record<LayoutId, string>> = { stereo: '2.1', lcr: '3.1', quad: '4.1', surround5: '5.1 Surround', surround7: '7.1 Surround' };
  return dot1[layout] ?? `${base[layout]} + Sub`;
}

/** best standard layout for this many full-range speakers (subs are added on top as ".1") */
export function suggestLayout(speakers: number): LayoutId {
  if (speakers <= 1) return 'mono';
  if (speakers === 2) return 'stereo';
  if (speakers === 3) return 'lcr';
  if (speakers === 4) return 'quad';
  if (speakers <= 6) return 'surround5';
  return 'surround7';
}

/** bigger, mains-powered speakers take the front slots; phones go to the surrounds */
const CLASS_RANK: Record<DeviceClass, number> = { desktop: 0, laptop: 1, bluetooth: 2, tablet: 3, unknown: 4, phone: 5 };

/**
 * Slot per device for `layout`: devices already on 'Sub' stay subs; the rest fill slots in layout order by class
 * rank (then join time), and extras double up slots round-robin. Non-routed layouts leave everyone 'Full'.
 */
export function autoAssign(layout: LayoutId, devices: Device[]): Record<string, DeviceRole> {
  const slots = LAYOUT_SLOTS[layout];
  const out: Record<string, DeviceRole> = {};
  const mains = devices
    .filter((d) => d.role !== 'Sub')
    .sort((a, b) => CLASS_RANK[a.caps.deviceClass] - CLASS_RANK[b.caps.deviceClass] || a.joinedAt - b.joinedAt);
  for (const d of devices) if (d.role === 'Sub') out[d.id] = 'Sub';
  mains.forEach((d, k) => (out[d.id] = slots.length ? slots[k % slots.length]! : 'Full'));
  return out;
}

/** ITU-style azimuths, degrees: 0 = ahead (−y), +ve = to the listener's right; 7.x moves the sides to ±90° */
const SLOT_AZ: Record<Slot, number> = { L: -30, R: 30, C: 0, SL: -110, SR: 110, RL: -150, RR: 150 };
const slotAz = (slot: Slot, layout: LayoutId) =>
  layout === 'surround7' && (slot === 'SL' || slot === 'SR') ? Math.sign(SLOT_AZ[slot]) * 90 : SLOT_AZ[slot];

/**
 * Canonical device positions for slot assignments (time alignment + room diagram): each slot on a circle around
 * the listener, devices sharing a slot fanned 0.4 m apart, subs at the front-left corner. 'Full' devices are left out.
 */
export function slotPositions(layout: LayoutId, roles: Record<string, DeviceRole>, scene: Scene): Record<string, Vec2> {
  const { room, listener } = scene;
  const r = Math.min(2.5, 0.45 * Math.min(room.width, room.depth));
  const clamp = (p: Vec2): Vec2 => ({
    x: Math.max(-room.width / 2 + 0.3, Math.min(room.width / 2 - 0.3, p.x)),
    y: Math.max(-room.depth / 2 + 0.3, Math.min(room.depth / 2 - 0.3, p.y)),
  });
  const bySlot = new Map<DeviceRole, string[]>();
  for (const [id, role] of Object.entries(roles)) bySlot.set(role, [...(bySlot.get(role) ?? []), id]);
  const out: Record<string, Vec2> = {};
  for (const [role, ids] of bySlot) {
    if (role === 'Full') continue;
    ids.forEach((id, k) => {
      const fan = (k - (ids.length - 1) / 2) * 0.4;
      if (role === 'Sub') {
        out[id] = clamp({ x: -room.width / 2 + fan, y: -room.depth / 2 });
        return;
      }
      const a = (slotAz(role, layout) * Math.PI) / 180;
      // fan along the circle's tangent
      out[id] = clamp({ x: listener.x + r * Math.sin(a) + fan * Math.cos(a), y: listener.y - r * Math.cos(a) + fan * Math.sin(a) });
    });
  }
  return out;
}

/** where a channel goes when its own slot is empty, in order; the last resort is every routed device */
const FOLD: Partial<Record<ObjectChannel, Slot[][]>> = {
  L: [['L'], ['C']],
  R: [['R'], ['C']],
  C: [['C'], ['L', 'R']],
  SL: [['SL'], ['RL'], ['L']],
  SR: [['SR'], ['RR'], ['R']],
  RL: [['RL'], ['SL'], ['L']],
  RR: [['RR'], ['SR'], ['R']],
  MONO: [['C'], ['L', 'R']],
  STEM: [['C'], ['L', 'R']],
  AMB: [['SL', 'SR', 'RL', 'RR'], ['L', 'R']],
};

/**
 * Routed gains for one object channel: equal-power (Σ g² = 1) across the devices in the first non-empty slot
 * group of the channel's fold-down chain. `devices` = routed participants (subs and unassigned excluded).
 */
export function routedGains(channel: ObjectChannel, devices: Pick<Device, 'id' | 'role'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!devices.length || channel === 'LFE') return out;
  let target = devices;
  for (const group of FOLD[channel] ?? []) {
    const hit = devices.filter((d) => (group as DeviceRole[]).includes(d.role));
    if (hit.length) {
      target = hit;
      break;
    }
  }
  const g = 1 / Math.sqrt(target.length);
  for (const d of target) out[d.id] = g;
  return out;
}
