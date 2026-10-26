import { describe, expect, it } from 'vitest';
import { defaultEq, defaultScene, type Device, type DeviceClass } from '@syncsound/protocol';
import { autoAssign, isRoutedLayout, LAYOUT_SLOTS, layoutLabel, routedGains, slotPositions, suggestLayout } from './layout';
import { channelIndexFor, computeDeviceMix, defaultObjectsFor } from './spatial';

const dev = (id: string, over: Partial<Device> = {}, deviceClass: DeviceClass = 'phone'): Device => ({
  id,
  name: id,
  role: 'Full',
  isHost: false,
  connected: true,
  caps: { userAgent: '', platform: '', deviceClass, sampleRate: 48000, baseLatencyMs: null, outputLatencyMs: null, hasOutputTimestamp: true, hasMic: true },
  volume: 1,
  trimDb: 0,
  muted: false,
  solo: false,
  latencyMs: 0,
  calibratedLatencyMs: null,
  tuneArrivalMs: null,
  tuneId: null,
  tuneStale: null,
  syncState: 'untuned',
  eq: defaultEq(),
  bassCapable: false,
  rolloffHz: null,
  stats: null,
  remote: { spotify: 'unconfigured', apple: 'unconfigured' },
  joinedAt: 0,
  ...over,
});

describe('suggestLayout / layoutLabel', () => {
  it('picks a layout by speaker count; a sub makes it ".1"', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9].map(suggestLayout)).toEqual(['mono', 'stereo', 'lcr', 'quad', 'surround5', 'surround5', 'surround7', 'surround7']);
    expect(layoutLabel('stereo', true)).toBe('2.1');
    expect(layoutLabel('surround5', true)).toBe('5.1 Surround');
    expect(layoutLabel('surround7', false)).toBe('7.0 Surround');
    expect(isRoutedLayout('party')).toBe(false);
    expect(isRoutedLayout(undefined)).toBe(false);
    expect(isRoutedLayout('quad')).toBe(true);
  });
});

describe('autoAssign', () => {
  it('fronts go to laptops/desktops, phones to surrounds, subs stay, extras double up', () => {
    const ds = [
      dev('p1', { joinedAt: 1 }),
      dev('lap', { joinedAt: 2 }, 'laptop'),
      dev('p2', { joinedAt: 3 }),
      dev('desk', { joinedAt: 4 }, 'desktop'),
      dev('sub', { role: 'Sub' }, 'bluetooth'),
      dev('p3', { joinedAt: 5 }),
      dev('p4', { joinedAt: 6 }),
    ];
    expect(autoAssign('surround5', ds)).toEqual({ desk: 'L', lap: 'R', p1: 'C', p2: 'SL', p3: 'SR', p4: 'L', sub: 'Sub' });
    expect(autoAssign('party', ds).p1).toBe('Full');
  });
});

describe('slotPositions', () => {
  it('puts L/R at ±30° around the listener, subs in a corner, fans shared slots', () => {
    const scene = defaultScene();
    const pos = slotPositions('stereo', { a: 'L', b: 'R', s: 'Sub', x: 'Full', c: 'L' }, scene);
    expect(pos.x).toBeUndefined();
    const L = pos.a!;
    const R = pos.b!;
    expect(L.x).toBeLessThan(scene.listener.x);
    expect(R.x).toBeGreaterThan(scene.listener.x);
    expect(Math.hypot(pos.a!.x - pos.c!.x, pos.a!.y - pos.c!.y)).toBeCloseTo(0.4, 6);
    expect(pos.s!.y).toBeLessThan(0);
  });
});

describe('routedGains', () => {
  const sumSq = (g: Record<string, number>) => Object.values(g).reduce((s, x) => s + x * x, 0);
  it('routes to the slot, splits equal-power, folds down when the slot is empty', () => {
    const five = [
      { id: 'l', role: 'L' as const },
      { id: 'r', role: 'R' as const },
      { id: 'c', role: 'C' as const },
      { id: 'sl', role: 'SL' as const },
      { id: 'sl2', role: 'SL' as const },
    ];
    expect(routedGains('L', five)).toEqual({ l: 1 });
    const sl = routedGains('SL', five);
    expect(Object.keys(sl).sort()).toEqual(['sl', 'sl2']);
    expect(sumSq(sl)).toBeCloseTo(1, 12);
    expect(routedGains('SR', five)).toEqual({ r: 1 }); // no SR, no RR → R
    expect(routedGains('RL', five)).toEqual(routedGains('SL', five)); // 7.1 rear → side
    const stereo = five.slice(0, 2);
    const c = routedGains('C', stereo);
    expect(c.l).toBeCloseTo(Math.SQRT1_2, 12); // phantom centre −3 dB each
    expect(c.r).toBeCloseTo(Math.SQRT1_2, 12);
    expect(routedGains('LFE', five)).toEqual({});
    expect(routedGains('L', [])).toEqual({});
  });
});

describe('computeDeviceMix with a routed layout', () => {
  it('a 5.1 file in a stereo + sub room: each channel lands where it should, unassigned devices are silent', () => {
    const scene = { ...defaultScene(), layout: 'stereo' as const, objects: defaultObjectsFor(6, false) };
    const devices = [dev('l', { role: 'L' }), dev('r', { role: 'R' }), dev('s', { role: 'Sub', bassCapable: true }), dev('x')];
    scene.devices = { ...slotPositions('stereo', { l: 'L', r: 'R', s: 'Sub' }, scene), x: { x: 0, y: 0 } };
    const mix = (id: string) => computeDeviceMix({ scene, devices, masterVolume: 1 }, id);
    const L = mix('l').objectGains;
    expect(L['obj-L']).toBeCloseTo(1, 12);
    expect(L['obj-R']).toBe(0);
    expect(L['obj-C']).toBeCloseTo(Math.SQRT1_2, 12);
    expect(L['obj-SL']).toBeCloseTo(1, 12); // surround folds to the front pair
    expect(L['obj-SR']).toBe(0);
    expect(mix('s').bassGain).toBeCloseTo(1, 12);
    expect(Object.values(mix('s').objectGains).every((g) => g === 0)).toBe(true);
    expect(mix('x').outputGain).toBe(0);
    // small speakers' lows are re-routed to the sub bus at full power
    expect(mix('l').bassObjectGains['obj-L']).toBeCloseTo(1, 12);
  });

  it('every standard layout routes each content channel with Σg² = 1 when fully assigned', () => {
    for (const [layout, slots] of Object.entries(LAYOUT_SLOTS)) {
      if (!slots.length) continue;
      const devices = slots.map((s) => dev(s, { role: s }));
      const scene = { ...defaultScene(), layout: layout as keyof typeof LAYOUT_SLOTS, objects: defaultObjectsFor(8, false) };
      scene.devices = slotPositions(scene.layout, Object.fromEntries(slots.map((s) => [s, s])), scene);
      for (const o of scene.objects.filter((o) => o.channel !== 'LFE')) {
        const p = devices.reduce((s, d) => s + (computeDeviceMix({ scene, devices, masterVolume: 1 }, d.id).objectGains[o.id] ?? 0) ** 2, 0);
        expect(p, `${layout} ${o.channel}`).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('7.1 sources', () => {
  it('maps WAV 7.1 order and creates rear objects', () => {
    expect(['L', 'R', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'].map((c) => channelIndexFor(c as never, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(channelIndexFor('SL', 6)).toBe(4);
    expect(defaultObjectsFor(8, false).map((o) => o.channel)).toEqual(['L', 'R', 'C', 'LFE', 'SL', 'SR', 'RL', 'RR']);
  });
});
