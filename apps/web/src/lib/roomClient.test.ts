import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCaps } from '@syncsound/protocol';
import { RoomClient } from './roomClient';

// a real WELCOME from a server deployed before crossfade and tune identity (captured from Cloud Run)
const oldWelcome = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol/src/fixtures/welcome-before-tune-identity.json', import.meta.url), 'utf8'),
);

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const caps: DeviceCaps = oldWelcome.roomState.devices[0].caps;

function connect() {
  vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1, CONNECTING: 0 }));
  const onMessage = vi.fn();
  const onMismatch = vi.fn();
  const client = new RoomClient({
    code: oldWelcome.roomState.code,
    deviceId: oldWelcome.deviceId,
    name: 'Probe',
    caps: () => caps,
    onMessage,
    onStatus: () => {},
    onSynced: () => {},
    onFatal: () => {},
    onMismatch,
  });
  client.connect();
  const ws = FakeSocket.last!;
  ws.readyState = 1;
  ws.onopen?.();
  return { client, ws, onMessage, onMismatch };
}

describe('RoomClient against another server version', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('joins an older server whose messages only lack newer fields', () => {
    const { client, ws, onMessage, onMismatch } = connect();
    ws.receive(oldWelcome);
    expect(onMismatch).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'WELCOME' }));
    client.close();
  });

  it('reports a message it cannot read as a version mismatch, once', () => {
    const { client, ws, onMessage, onMismatch } = connect();
    const broken = structuredClone(oldWelcome);
    broken.roomState.devices[0].caps = 'not caps';
    ws.receive(broken);
    ws.receive(broken);
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'WELCOME' }));
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch.mock.calls[0]![0]).toBe('WELCOME');
    expect(onMismatch.mock.calls[0]![1]).toMatch(/caps/);
    client.close();
  });
});
