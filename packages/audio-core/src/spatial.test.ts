import { describe, expect, it } from 'vitest';
import { defaultEq, defaultScene, type Device, type Scene } from '@syncsound/protocol';
import { dbToGain } from './loudness';
import { mulberry32 } from './signals';
import {
  channelIndexFor,
  computeDeviceMix,
  dbapGains,
  defaultObjectsFor,
  freeSpot,
  LFE_FOLD_DB,
  presetLayout,
  propagationDelays,
  resizeRoom,
  SPEED_OF_SOUND,
  type Speaker,
} from './spatial';

const mkDevice = (id: string, over: Partial<Device> = {}): Device => ({
  id,
  name: id,
  role: 'Full',
  isHost: false,
  connected: true,
  caps: {
    userAgent: '',
    platform: '',
    deviceClass: 'phone',
    sampleRate: 48000,
    baseLatencyMs: null,
    outputLatencyMs: null,
    hasOutputTimestamp: true,
    hasMic: true,
  },
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
  ...over,
});

const sumSq = (g: Record<string, number>) => Object.values(g).reduce((s, x) => s + x * x, 0);

describe('dbapGains', () => {
  it('normalizes power Σg² = 1 for random layouts; single → 1; empty → {}', () => {
    const rnd = mulberry32(42);
    const p = () => ({ x: rnd() * 8 - 4, y: rnd() * 6 - 3 });
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rnd() * 8);
      const speakers: Speaker[] = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, pos: p() }));
      expect(sumSq(dbapGains(p(), speakers, { rolloff: 0.5 + rnd() * 2, blur: 0.1 + rnd() }))).toBeCloseTo(
        1,
        10,
      );
    }
    expect(dbapGains({ x: 3, y: 3 }, [{ id: 'a', pos: { x: 0, y: 0 } }])).toEqual({ a: 1 });
    expect(dbapGains({ x: 0, y: 0 }, [])).toEqual({});
  });

  it('is left/right mirror symmetric', () => {
    const speakers: Speaker[] = [
      { id: 'L', pos: { x: -2, y: -1 } },
      { id: 'R', pos: { x: 2, y: -1 } },
      { id: 'BL', pos: { x: -1.5, y: 2 } },
      { id: 'BR', pos: { x: 1.5, y: 2 } },
    ];
    const a = dbapGains({ x: -0.7, y: 0.4 }, speakers);
    const b = dbapGains({ x: 0.7, y: 0.4 }, speakers);
    expect(a.L).toBeCloseTo(b.R!, 12);
    expect(a.BL).toBeCloseTo(b.BR!, 12);
    expect(dbapGains({ x: 0, y: 0 }, speakers).L).toBeCloseTo(dbapGains({ x: 0, y: 0 }, speakers).R!, 12);
  });

  it('is continuous: 1 cm steps (straight through two speakers) never change a gain by more than 0.02', () => {
    const speakers: Speaker[] = [
      { id: 'a', pos: { x: -2, y: -1 } },
      { id: 'b', pos: { x: 2, y: -1 } },
      { id: 'c', pos: { x: 0, y: 2 } },
    ];
    let prev = dbapGains({ x: -3.5, y: -1 }, speakers);
    let maxStep = 0;
    for (let k = 1; k <= 700; k++) {
      const g = dbapGains({ x: -3.5 + k * 0.01, y: -1 }, speakers);
      for (const id of Object.keys(g)) maxStep = Math.max(maxStep, Math.abs(g[id]! - prev[id]!));
      prev = g;
    }
    expect(maxStep).toBeLessThan(0.02);
  });

  it("moving an object toward a device increases that device's gain", () => {
    const speakers: Speaker[] = [
      { id: 'a', pos: { x: -2, y: -1 } },
      { id: 'b', pos: { x: 2, y: -1 } },
      { id: 'c', pos: { x: 0, y: 2 } },
    ];
    // drag from the room centre straight onto device a
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const g = dbapGains({ x: -2 * t, y: -1 * t }, speakers).a!;
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });
});

describe('computeDeviceMix', () => {
  const scene = (devices: Scene['devices'], over: Partial<Scene> = {}): Scene => ({
    ...defaultScene(),
    devices,
    objects: [
      ...defaultScene().objects,
      { id: 'obj-LFE', label: 'LFE', channel: 'LFE', position: { x: 0, y: -2 }, gainDb: 0, muted: false },
    ],
    ...over,
  });
  const pos = {
    phone: { x: -2, y: -1 },
    laptop: { x: 2, y: -1 },
    desk: { x: 0, y: 2 },
    sub: { x: -3, y: -2 },
  };

  it('routes LFE only to bass-capable devices and high-passes small devices when bass is managed', () => {
    const devices = [
      mkDevice('phone', { rolloffHz: 200 }),
      mkDevice('laptop', { rolloffHz: 90 }),
      mkDevice('desk', { bassCapable: true, eq: { ...defaultEq(), highpassHz: 30 } }),
      mkDevice('sub', { role: 'Sub' }),
    ];
    const input = { scene: scene(pos), devices, masterVolume: 1 };
    const m = Object.fromEntries(devices.map((d) => [d.id, computeDeviceMix(input, d.id)]));
    for (const id of ['phone', 'laptop', 'desk', 'sub'])
      expect(m[id]!.objectGains['obj-LFE']).toBeUndefined();
    expect(m.phone!.bassGain).toBe(0);
    expect(m.laptop!.bassGain).toBe(0);
    expect(m.desk!.bassGain).toBeCloseTo(Math.SQRT1_2, 12);
    expect(m.sub!.bassGain).toBeCloseTo(Math.SQRT1_2, 12);
    expect(m.phone!.highpassHz).toBe(200); // max(crossover 100, rolloff 200)
    expect(m.laptop!.highpassHz).toBe(100); // crossover
    expect(m.desk!.highpassHz).toBe(30); // full range, protective HP only
    expect(m.sub!.highpassHz).toBeNull();
    // sub = lows only
    expect(Object.values(m.sub!.objectGains).every((g) => g === 0)).toBe(true);
    // LFE enters the bass bus at its object gain; redirected lows = power share on high-passed devices
    expect(m.desk!.bassObjectGains['obj-LFE']).toBe(1);
    for (const o of ['obj-L', 'obj-R']) {
      const small = m.phone!.objectGains[o]! ** 2 + m.laptop!.objectGains[o]! ** 2;
      expect(m.desk!.bassObjectGains[o]).toBeCloseTo(Math.sqrt(small), 12);
      // panned power over non-sub participants is 1
      expect(small + m.desk!.objectGains[o]! ** 2).toBeCloseTo(1, 12);
    }
  });

  it('falls back to full range + LFE fold-in when nothing is bass-capable', () => {
    const devices = [
      mkDevice('phone', { rolloffHz: 200, eq: { ...defaultEq(), highpassHz: 180 } }),
      mkDevice('laptop', { rolloffHz: 90 }),
    ];
    const input = { scene: scene({ phone: pos.phone, laptop: pos.laptop }), devices, masterVolume: 1 };
    const p = computeDeviceMix(input, 'phone');
    const l = computeDeviceMix(input, 'laptop');
    expect(p.highpassHz).toBe(180);
    expect(l.highpassHz).toBeNull();
    expect(p.bassGain).toBeCloseTo(dbToGain(LFE_FOLD_DB) / Math.SQRT2, 12);
    expect(p.bassGain ** 2 + l.bassGain ** 2).toBeCloseTo(dbToGain(LFE_FOLD_DB) ** 2, 12);
    expect(p.bassObjectGains['obj-L']).toBe(0);
    expect(p.bassObjectGains['obj-LFE']).toBe(1);
  });

  it('applies mute, solo, volume, trim and master to outputGain and renormalizes panning', () => {
    const base = [mkDevice('phone'), mkDevice('laptop', { volume: 0.5, trimDb: -6 }), mkDevice('desk')];
    const run = (devices: Device[]) => {
      const input = {
        scene: scene({ phone: pos.phone, laptop: pos.laptop, desk: pos.desk }),
        devices,
        masterVolume: 0.8,
      };
      return Object.fromEntries(devices.map((d) => [d.id, computeDeviceMix(input, d.id)]));
    };
    const all = run(base);
    expect(all.laptop!.outputGain).toBeCloseTo(0.8 * 0.5 * dbToGain(-6), 12);
    const muted = run(base.map((d) => (d.id === 'desk' ? { ...d, muted: true } : d)));
    expect(muted.desk!.outputGain).toBe(0);
    expect(muted.phone!.objectGains['obj-L']! ** 2 + muted.laptop!.objectGains['obj-L']! ** 2).toBeCloseTo(
      1,
      12,
    );
    const solo = run(base.map((d) => (d.id === 'laptop' ? { ...d, solo: true } : d)));
    expect(solo.phone!.outputGain).toBe(0);
    expect(solo.desk!.outputGain).toBe(0);
    expect(solo.laptop!.outputGain).toBeGreaterThan(0);
    expect(solo.laptop!.objectGains['obj-L']).toBeCloseTo(1, 12);
    // disconnected or unpositioned devices are silent
    const off = run(base.map((d) => (d.id === 'phone' ? { ...d, connected: false } : d)));
    expect(off.phone!.outputGain).toBe(0);
    // muted objects are silent everywhere
    const input = {
      scene: { ...scene({ phone: pos.phone }), objects: [{ ...defaultScene().objects[0]!, muted: true }] },
      devices: [mkDevice('phone')],
      masterVolume: 1,
    };
    expect(computeDeviceMix(input, 'phone').objectGains['obj-L']).toBe(0);
  });

  it('time-aligns by propagation: farthest device gets 0 delay', () => {
    const s = scene({ near: { x: 0, y: 0 }, far: { x: 0, y: -3 } }); // listener (0, 1): 1 m and 4 m
    const d = propagationDelays(s, ['near', 'far', 'ghost']);
    expect(d.far).toBe(0);
    expect(d.near).toBeCloseTo(3 / SPEED_OF_SOUND, 12);
    expect(d.ghost).toBeUndefined();
    const devices = [mkDevice('near'), mkDevice('far')];
    expect(computeDeviceMix({ scene: s, devices, masterVolume: 1 }, 'near').delaySec).toBeCloseTo(
      3 / SPEED_OF_SOUND,
      12,
    );
    expect(
      computeDeviceMix({ scene: { ...s, propagationComp: false }, devices, masterVolume: 1 }, 'near')
        .delaySec,
    ).toBe(0);
  });
});

describe('layouts and channel maps', () => {
  it('presets keep every device inside the room', () => {
    const s = defaultScene();
    const ids = Array.from({ length: 8 }, (_, i) => `d${i}`);
    for (const p of ['stereo', 'surround51', 'party', 'frontStage'] as const) {
      const { devices, objects } = presetLayout(p, ids, s);
      expect(Object.keys(devices)).toEqual(ids);
      for (const v of [...Object.values(devices), ...objects.map((o) => o.position)]) {
        expect(Math.abs(v.x)).toBeLessThanOrEqual(s.room.width / 2);
        expect(Math.abs(v.y)).toBeLessThanOrEqual(s.room.depth / 2);
      }
    }
    const st = presetLayout('stereo', ['a', 'b'], s).devices;
    expect(st.a!.x).toBeCloseTo(-st.b!.x, 12);
    expect(st.a!.y).toBeLessThan(s.listener.y);
  });

  it('freeSpot keeps clear of taken points and inside the room', () => {
    const room = { width: 8, depth: 6 };
    expect(freeSpot({ x: 1, y: 1 }, [], room)).toEqual({ x: 1, y: 1 });
    const taken = [{ x: 0, y: -1.5 }, { x: 0.3, y: -1.2 }, { x: -2, y: -1.5 }];
    const p = freeSpot({ x: 0, y: -1.5 }, taken, room);
    for (const t of taken) expect(Math.hypot(t.x - p.x, t.y - p.y)).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(3);
  });

  it('resizeRoom pulls outside items onto the new walls and leaves inside items alone', () => {
    const s: Scene = {
      ...defaultScene(),
      listener: { x: -3, y: 2.5 },
      devices: { a: { x: 3.5, y: 0 }, b: { x: 0.2, y: -0.4 } },
    };
    s.objects = [{ id: 'o', label: 'L', channel: 'L', gainDb: 0, muted: false, position: { x: -3.9, y: -2.9 } }];
    const p = resizeRoom(s, { width: 4, depth: 4 });
    expect(p.room).toEqual({ width: 4, depth: 4 });
    expect(p.listener).toEqual({ x: -2, y: 2 });
    expect(p.devices).toEqual({ a: { x: 2, y: 0 }, b: { x: 0.2, y: -0.4 } });
    expect(p.objects[0]!.position).toEqual({ x: -2, y: -2 });
  });

  it('default objects and channel indices follow 5.1 WAV order', () => {
    expect(defaultObjectsFor(6, false).map((o) => o.channel)).toEqual(['L', 'R', 'C', 'LFE', 'SL', 'SR']);
    expect(defaultObjectsFor(2, false).map((o) => o.channel)).toEqual(['L', 'R']);
    expect(defaultObjectsFor(2, true).map((o) => o.channel)).toEqual(['L', 'R', 'C', 'SL', 'SR', 'AMB']);
    expect(defaultObjectsFor(1, true).map((o) => o.channel)).toEqual(['MONO']);
    expect(['L', 'R', 'C', 'LFE', 'SL', 'SR'].map((c) => channelIndexFor(c as 'L', 6))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(channelIndexFor('R', 2)).toBe(1);
    expect(channelIndexFor('C', 2)).toBeNull();
    expect(channelIndexFor('MONO', 1)).toBe(0);
  });
});
