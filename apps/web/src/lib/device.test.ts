import { describe, expect, it } from 'vitest';
import { chooseCalibrationInput, defaultOutputLabel, detectDeviceClass, isBluetoothLabel } from './device';

const input = (deviceId: string, label: string) => ({ kind: 'audioinput' as const, deviceId, label });

describe('Bluetooth helpers', () => {
  it('recognises Bluetooth labels', () => {
    expect(isBluetoothLabel('Default - JBL Flip 5 Hands-Free')).toBe(true);
    expect(isBluetoothLabel('Bluetooth headset')).toBe(true);
    expect(isBluetoothLabel('MacBook Pro Microphone')).toBe(false);
    expect(isBluetoothLabel(undefined)).toBe(false);
  });

  it('keeps a non-Bluetooth mic', () => {
    expect(chooseCalibrationInput('MacBook Pro Microphone', [])).toEqual({ kind: 'keep' });
    expect(chooseCalibrationInput('', [])).toEqual({ kind: 'keep' }); // unlabelled → can't tell, keep
  });

  it('switches away from a Bluetooth headset mic to a real built-in input', () => {
    const inputs = [
      input('default', 'Default - JBL Flip 5 Hands-Free'),
      input('communications', 'Communications - Built-in Microphone'),
      input('bt', 'JBL Flip 5 Hands-Free'),
      input('builtin', 'Built-in Microphone'),
    ];
    expect(chooseCalibrationInput('JBL Flip 5 Hands-Free', inputs)).toEqual({ kind: 'switch', deviceId: 'builtin' });
  });

  it('reports when only Bluetooth mics exist', () => {
    expect(chooseCalibrationInput('AirPods Pro', [input('default', 'Default - AirPods Pro'), input('a', 'AirPods Pro')])).toEqual({
      kind: 'bluetooth-only',
    });
  });

  it('reads the default output label', () => {
    const out = (deviceId: string, label: string) => ({ kind: 'audiooutput' as const, deviceId, label });
    expect(defaultOutputLabel([out('x', 'Speakers'), out('default', 'Default - JBL Flip 5')])).toBe('Default - JBL Flip 5');
    expect(defaultOutputLabel([out('x', 'Speakers')])).toBe('Speakers');
    expect(defaultOutputLabel([out('default', '')])).toBeUndefined();
    expect(defaultOutputLabel([input('default', 'Mic')])).toBeUndefined();
  });
});

describe('detectDeviceClass', () => {
  it('classifies common user agents', () => {
    expect(detectDeviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('phone');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe('phone');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; SM-X700) Safari')).toBe('tablet');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { touchPoints: 5 })).toBe('tablet');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('laptop');
    expect(detectDeviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
    expect(detectDeviceClass('Mozilla/5.0 (Macintosh)', { outputLabel: 'AirPods Pro' })).toBe('bluetooth');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', { outputLatencyMs: 180 })).toBe('bluetooth');
    expect(detectDeviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', { outputLatencyMs: 45 })).toBe('phone');
  });
});
