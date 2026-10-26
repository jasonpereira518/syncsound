import { describe, expect, it } from 'vitest';
import { defaultEq, defaultScene, type Device, type DeviceRole, type LayoutId, type Scene, type Vec2 } from '@syncsound/protocol';
import { autoSlot, LAYOUT_SLOTS, slotPositions, upmixActive } from './layout';
import { computeDeviceMix, dbapGains, defaultObjectsFor, polar } from './spatial';
import { azimuthOf, orbitAngle, ringGains, sceneAt, vbapGains, wrapDeg } from './vbap';

const dev = (id: string, role: DeviceRole = 'Full'): Device => ({
  id,
  name: id,
  role,
  isHost: false,
  connected: true,
  caps: { userAgent: '', platform: '', deviceClass: 'phone', sampleRate: 48000, baseLatencyMs: null, outputLatencyMs: null, hasOutputTimestamp: true, hasMic: true },
  volume: 1,
  trimDb: 0,
  muted: false,
  solo: false,
  latencyMs: 0,
  calibratedLatencyMs: null,
  eq: defaultEq(),
  bassCapable: false,
  rolloffHz: null,
  stats: null,
  remote: { spotify: 'unconfigured', apple: 'unconfigured' },
  joinedAt: 0,
});
const sumSq = (g: Record<string, number>) => Object.values(g).reduce((s, x) => s + x * x, 0);
const dB = (g: number) => 20 * Math.log10(Math.max(g, 1e-6));

/** one device per slot, placed by slotPositions */
function room(layout: LayoutId, slots: DeviceRole[] = LAYOUT_SLOTS[layout]) {
  const devices = slots.map((s) => dev(s, s));
  const scene: Scene = { ...defaultScene(), layout };
  scene.devices = slotPositions(layout, Object.fromEntries(slots.map((s) => [s, s])), scene);
  return { devices, scene };
}
const at = (scene: Scene, az: number, r = 2.5): Vec2 => polar(scene.listener, az, r);

describe('ringGains', () => {
  it('sine/cosine law between neighbours, Σg² = 1, exact on a speaker', () => {
    const ring = [-30, 30, 0];
    expect(ringGains(-30, ring)).toEqual([1, 0, 0]);
    const mid = ringGains(-15, ring);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2, 12);
    for (let a = -180; a <= 180; a += 7) expect(ringGains(a, [-110, -30, 0, 30, 110]).reduce((s, g) => s + g * g, 0)).toBeCloseTo(1, 12);
  });

  it('holds the nearer side across a wide gap and cross-fades only behind', () => {
    const ring = [-30, 30];
    expect(ringGains(-110, ring)).toEqual([1, 0]); // a surround channel in a stereo room stays left
    const back = ringGains(180, ring);
    expect(back[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(back[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('is continuous: a full sweep in 1° steps never jumps a gain by more than 0.06', () => {
    for (const ring of [[-30, 30], [-30, 0, 30], [-30, 30, -110, 110], [-30, 30, 0, -90, 90, -150, 150]]) {
      let prev = ringGains(-180, ring);
      for (let a = -179; a <= 180; a++) {
        const g = ringGains(a, ring);
        g.forEach((x, i) => expect(Math.abs(x - prev[i]!), `${ring} @${a}`).toBeLessThan(0.06));
        prev = g;
      }
    }
  });
});

describe('vbapGains in standard layouts', () => {
  it('an untouched channel plays from its own slot only; empty slots fold to neighbours', () => {
    const { devices, scene } = room('surround5');
    for (const o of defaultObjectsFor(6, false).filter((o) => o.channel !== 'LFE')) {
      const g = vbapGains(o, devices, scene);
      expect(g[o.channel], o.channel).toBeCloseTo(1, 12);
      expect(sumSq(g)).toBeCloseTo(1, 12);
    }
    const stereo = room('stereo');
    const sl = vbapGains({ channel: 'SL', position: at(stereo.scene, -110) }, stereo.devices, stereo.scene);
    expect(sl.L).toBeCloseTo(1, 12); // nearest front, like the old fold-down
    const c = vbapGains({ channel: 'C', position: at(stereo.scene, 0) }, stereo.devices, stereo.scene);
    expect(c.L).toBeCloseTo(Math.SQRT1_2, 12);
    expect(c.R).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("the default scene's L/R (not exactly at ±30°) still snap to their slots", () => {
    const { devices, scene } = room('surround5');
    const [L, R] = defaultScene().objects;
    expect(vbapGains(L!, devices, scene).L).toBeCloseTo(1, 12);
    expect(vbapGains(R!, devices, scene).R).toBeCloseTo(1, 12);
  });

  it('a dragged sound moves between slots: halfway L↔C is −3 dB each', () => {
    const { devices, scene } = room('lcr');
    const g = vbapGains({ channel: 'STEM', position: at(scene, -15) }, devices, scene);
    expect(g.L).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g.C).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g.R).toBeCloseTo(0, 12);
  });

  it('is far sharper than DBAP: ≥ 20 dB between the speaker a sound sits on and the opposite one', () => {
    const { devices, scene } = room('surround5');
    const g = vbapGains({ channel: 'STEM', position: scene.devices.L! }, devices, scene);
    expect(dB(g.L!) - dB(g.SR!)).toBeGreaterThanOrEqual(20);
    // the old panner on the same spot, for the record (this is what made spatial hard to hear)
    const speakers = devices.map((d) => ({ id: d.id, pos: scene.devices[d.id]! }));
    const old = dbapGains(scene.devices.L!, speakers, { rolloff: scene.rolloff, blur: scene.blur });
    expect(dB(old.L!) - dB(old.SR!)).toBeLessThan(20);
  });

  it('devices sharing a slot split it equal-power; mono plays from every slot', () => {
    const scene: Scene = { ...defaultScene(), layout: 'stereo' };
    const devices = [dev('l1', 'L'), dev('l2', 'L'), dev('r', 'R')];
    scene.devices = slotPositions('stereo', { l1: 'L', l2: 'L', r: 'R' }, scene);
    const g = vbapGains({ channel: 'L', position: at(scene, -30) }, devices, scene);
    expect(g.l1).toBeCloseTo(Math.SQRT1_2, 12);
    expect(g.l2).toBeCloseTo(Math.SQRT1_2, 12);
    expect(g.r).toBeCloseTo(0, 12);
    const five = room('surround5');
    const m = vbapGains(defaultObjectsFor(1, false)[0]!, five.devices, five.scene);
    for (const s of LAYOUT_SLOTS.surround5) expect(m[s], s).toBeCloseTo(1 / Math.sqrt(5), 12);
  });

  it('a sound at the listener spreads over every speaker', () => {
    const { devices, scene } = room('quad');
    const g = vbapGains({ channel: 'STEM', position: scene.listener }, devices, scene);
    for (const s of LAYOUT_SLOTS.quad) expect(g[s]).toBeCloseTo(0.5, 12);
  });
});

describe('vbapGains by position (custom / Everywhere)', () => {
  const scene: Scene = { ...defaultScene(), layout: 'custom' };
  scene.devices = { a: at(scene, -45), b: at(scene, 45), c: at(scene, 180), near: scene.listener };
  const devices = [dev('a'), dev('b'), dev('c'), dev('near')];

  it('pans by direction from the listener; a device on the seat gets an equal share', () => {
    const g = vbapGains({ channel: 'STEM', position: at(scene, -45, 2) }, devices, scene);
    expect(sumSq(g)).toBeCloseTo(1, 12);
    expect(g.near).toBeCloseTo(0.5, 12);
    expect(g.a).toBeCloseTo(Math.sqrt(0.75), 12);
    expect(g.b).toBeCloseTo(0, 12);
    expect(g.c).toBeCloseTo(0, 12);
  });

  it('Everywhere plays the whole mix on every speaker, until 8D is on', () => {
    const party = { ...scene, layout: 'party' as const };
    const g = vbapGains({ channel: 'L', position: at(scene, -30) }, devices, party);
    for (const id of ['a', 'b', 'c', 'near']) expect(g[id]).toBeCloseTo(0.5, 12);
    const moving = vbapGains({ channel: 'L', position: at(scene, 180) }, devices, { ...party, motion: { periodSec: 8, startRoomTime: 0 } });
    expect(moving.c).toBeGreaterThan(0.8);
  });
});

describe('every assigned speaker plays (stereo source)', () => {
  it.each(['stereo', 'lcr', 'quad', 'surround5', 'surround7'] as const)('%s: no assigned slot is silent', (layout) => {
    const { devices, scene } = room(layout);
    scene.upmix = false; // the default; the layout turns the upmix on by itself
    scene.objects = defaultObjectsFor(2, upmixActive(scene));
    for (const d of devices) {
      const m = computeDeviceMix({ scene, devices, masterVolume: 1 }, d.id);
      const loudest = Math.max(...Object.values(m.objectGains));
      expect(loudest, `${layout} ${d.role}`).toBeGreaterThan(0.2);
    }
  });

  it('upmix turns on for layouts with more than the front pair, or when the scene asks', () => {
    expect(upmixActive({ layout: 'stereo', upmix: false })).toBe(false);
    expect(upmixActive({ layout: 'lcr', upmix: false })).toBe(true);
    expect(upmixActive({ layout: 'surround7', upmix: false })).toBe(true);
    expect(upmixActive({ layout: 'party', upmix: false })).toBe(false);
    expect(upmixActive({ layout: 'custom', upmix: true })).toBe(true);
  });
});

describe('autoSlot', () => {
  it('gives every device without a valid slot the emptiest one; subs and valid roles stay', () => {
    const ds = [
      { id: 'a', role: 'L' as const, joinedAt: 1 },
      { id: 'b', role: 'Full' as const, joinedAt: 3 },
      { id: 'c', role: 'SL' as const, joinedAt: 2 }, // not a stereo slot
      { id: 's', role: 'Sub' as const, joinedAt: 4 },
    ];
    expect(autoSlot('stereo', ds)).toEqual({ c: 'R', b: 'L' });
    expect(autoSlot('surround5', ds)).toEqual({ b: 'R' });
    expect(autoSlot('party', ds)).toEqual({});
  });
});

describe('8D orbit', () => {
  const motion = { periodSec: 8, startRoomTime: 1_000 };

  it('angle is a pure function of room time (same on every device)', () => {
    expect(orbitAngle(motion, 1_000)).toBe(0);
    expect(orbitAngle(motion, 3_000)).toBeCloseTo(90, 9);
    expect(orbitAngle(motion, 1_000 + 8_000 * 7 + 4_000)).toBeCloseTo(180, 6);
    expect(orbitAngle(null, 5_000)).toBe(0);
  });

  it('narrows the mix and turns it round the listener; LFE stays', () => {
    const scene: Scene = { ...defaultScene(), motion, objects: defaultObjectsFor(6, false) };
    scene.objects = scene.objects.map((o) => (o.channel === 'LFE' ? o : { ...o, position: at(scene, ({ L: -30, R: 30, C: 0, SL: -110, SR: 110 } as Record<string, number>)[o.channel]!) }));
    const q = sceneAt(scene, 3_000); // +90°
    const az = (ch: string) => azimuthOf(q.objects.find((o) => o.channel === ch)!.position, scene.listener);
    expect(az('C')).toBeCloseTo(90, 9);
    expect(az('L')).toBeCloseTo(90 - 9, 9);
    expect(az('SR')).toBeCloseTo(90 + 33, 9);
    expect(q.objects.find((o) => o.channel === 'LFE')!.position).toEqual(scene.objects.find((o) => o.channel === 'LFE')!.position);
    expect(sceneAt({ ...scene, motion: null }, 3_000)).toEqual({ ...scene, motion: null });
  });

  it('the loudest speaker travels all the way round a 5.0 room', () => {
    const { devices, scene } = room('surround5');
    scene.motion = motion;
    scene.objects = defaultObjectsFor(2, true);
    const visited = new Set<string>();
    for (let t = 0; t < 8_000; t += 100) {
      const heard = sceneAt(scene, motion.startRoomTime + t);
      const power = Object.fromEntries(
        devices.map((d) => {
          const m = computeDeviceMix({ scene: heard, devices, masterVolume: 1 }, d.id);
          return [d.id, Object.values(m.objectGains).reduce((s, g) => s + g * g, 0)];
        }),
      );
      visited.add(Object.entries(power).sort((a, b) => b[1] - a[1])[0]![0]);
    }
    expect([...visited].sort()).toEqual(['C', 'L', 'R', 'SL', 'SR']);
  });

  it('wrapDeg keeps (−180, 180]', () => {
    expect([wrapDeg(190), wrapDeg(-180), wrapDeg(540), wrapDeg(-30)]).toEqual([-170, 180, 180, -30]);
  });
});
