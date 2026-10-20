import { describe, expect, it } from 'vitest';
import { dueNow, setBatterySaverFlag } from './power';

describe('battery-friendly mode throttle', () => {
  it('runs every call normally and only every slowMs in battery mode', () => {
    const last = { t: 0 };
    setBatterySaverFlag(false);
    expect([1000, 1500, 2000].map((t) => dueNow(last, 5000, t))).toEqual([true, true, true]);
    setBatterySaverFlag(true);
    const runs = [3000, 4000, 7000, 7100, 12000].map((t) => dueNow(last, 5000, t));
    expect(runs).toEqual([false, false, true, false, true]);
    setBatterySaverFlag(false);
  });
});
