import { describe, expect, it } from 'vitest';
import { detectDeviceClass } from './device';

describe('detectDeviceClass', () => {
  it('classifies common user agents', () => {
    expect(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('phone');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('phone');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; SM-X700) Safari')).toBe('tablet');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { touchPoints: 5 })).toBe('tablet');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('laptop');
    expect(detectDeviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh)', { outputLabel: 'AirPods Pro' })).toBe('bluetooth');
  });
});
