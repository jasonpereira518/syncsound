import { describe, expect, it } from 'vitest';
import { defaultScene } from '@syncsound/protocol';
import { nextFreeSlot, placeForLayout, slotPositions } from './layout';

describe('nextFreeSlot', () => {
  it('fills empty slots in layout order, then doubles up the least occupied one; non-routed layouts give Full', () => {
    expect(nextFreeSlot('stereo', {})).toBe('L');
    expect(nextFreeSlot('stereo', { a: 'L' })).toBe('R');
    expect(nextFreeSlot('stereo', { a: 'L', b: 'R' })).toBe('L');
    expect(nextFreeSlot('stereo', { a: 'L', b: 'R', c: 'L' })).toBe('R');
    expect(nextFreeSlot('surround5', { a: 'L', b: 'R', c: 'C', s: 'Sub' })).toBe('SL');
    expect(nextFreeSlot('party', { a: 'L' })).toBe('Full');
  });
});

describe('placeForLayout', () => {
  it('keeps the measured positions of ranged devices and places the rest on their slots', () => {
    const scene = { ...defaultScene(), devices: { a: { x: 0.7, y: -1.1 }, b: { x: 2.2, y: 0.3 }, c: { x: 0, y: 0 } } };
    const roles = { a: 'L' as const, b: 'R' as const, c: 'SL' as const };
    const canonical = slotPositions('quad', roles, scene);
    const placed = placeForLayout('quad', roles, scene, ['a', 'b']);
    expect(placed.a).toEqual(scene.devices.a);
    expect(placed.b).toEqual(scene.devices.b);
    expect(placed.c).toEqual(canonical.c);
    // a kept device without a stored position still gets its slot
    expect(placeForLayout('quad', roles, { ...scene, devices: {} }, ['a']).a).toEqual(canonical.a);
  });
});
