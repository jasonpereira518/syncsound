import { describe, expect, it } from 'vitest';
import { defaultScene, isValidRoomCode, parseClientMessage } from './index';

describe('protocol', () => {
  it('validates room codes', () => {
    expect(isValidRoomCode('ABC234')).toBe(true);
    expect(isValidRoomCode('ABC10O')).toBe(false); // ambiguous chars excluded
    expect(isValidRoomCode('ABC23')).toBe(false);
  });
  it('accepts a PING and rejects junk', () => {
    expect(parseClientMessage({ type: 'PING', t0: 12.5 }).success).toBe(true);
    expect(parseClientMessage({ type: 'PING', t0: 'x' }).success).toBe(false);
    expect(parseClientMessage({ type: 'NOPE' }).success).toBe(false);
  });
  it('default scene is valid in SCENE_UPDATE', () => {
    const s = defaultScene();
    expect(parseClientMessage({ type: 'SCENE_UPDATE', objects: s.objects, listener: s.listener }).success).toBe(true);
  });
});
