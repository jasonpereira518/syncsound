import { describe, expect, it } from 'vitest';
import { ClockSync } from '@syncsound/audio-core';
import type { Device } from '@syncsound/protocol';
import { ClockLink, parseLinkMsg, pickClockMaster } from './clockLink';

const dev = (id: string, deviceClass: string, connected = true) => ({ id, connected, caps: { deviceClass } }) as unknown as Device;

describe('pickClockMaster', () => {
  it('prefers the connected host, then desktops/laptops, then lowest id', () => {
    const ds = [dev('b', 'phone'), dev('c', 'laptop'), dev('a', 'phone'), dev('h', 'phone', false)];
    expect(pickClockMaster(ds, 'a')).toBe('a');
    expect(pickClockMaster(ds, 'h')).toBe('c'); // host offline
    expect(pickClockMaster(ds.filter((d) => d.id !== 'c'), null)).toBe('a');
    expect(pickClockMaster([], null)).toBeNull();
  });
});

describe('parseLinkMsg', () => {
  it('accepts well-formed messages, maps a null tEnd back to Infinity, rejects junk', () => {
    expect(parseLinkMsg('{"t":"ping","t0":1}')).toEqual({ t: 'ping', t0: 1 });
    expect(parseLinkMsg('{"t":"map","d":{"t0":1,"a0":2,"s1":0,"s2":0,"tEnd":null}}')).toEqual({
      t: 'map',
      d: { t0: 1, a0: 2, s1: 0, s2: 0, tEnd: Infinity },
    });
    expect(parseLinkMsg('{"t":"pong","t0":1,"r":"x","s":2}')).toBeNull();
    expect(parseLinkMsg('not json')).toBeNull();
  });
});

describe('ClockLink', () => {
  it('a peer maps its clock through the master to the master’s room time', () => {
    let T = 1_700_000_000_000; // true room time
    const masterLocal = () => T - 5_000;
    const peerLocal = () => T - 12_345.678;
    const server = new ClockSync();
    const send = () => {};
    const master = new ClockLink({ selfId: 'm', send, serverClock: () => server, now: masterLocal });
    const peer = new ClockLink({ selfId: 'p', send, serverClock: () => new ClockSync(), now: peerLocal });
    master.setMaster('m');
    // peer.setMaster would open an RTCPeerConnection; set the field the same way connect() would leave it
    (peer as unknown as { master: string }).master = 'm';
    expect(peer.ready).toBe(false);

    for (let i = 0; i < 20; i++, T += 100) {
      server.addSample({ t0: masterLocal(), tsRecv: T, tsSend: T, t3: masterLocal() }); // zero-delay server link
      const pong = master.onMessage('p', { t: 'ping', t0: peerLocal() });
      expect(pong?.t).toBe('pong');
      peer.onMessage('m', pong!);
    }
    peer.onMessage('m', master.mapMsg()!);
    expect(peer.ready).toBe(true);
    expect(peer.toRoomTime(peerLocal())).toBeCloseTo(T, 3);
    expect(peer.toLocalTime(T)).toBeCloseTo(peerLocal(), 3);
    // messages from anyone but the master are ignored
    peer.onMessage('x', { t: 'map', d: { t0: 0, a0: 999, s1: 0, tEnd: Infinity, s2: 0 } });
    expect(peer.toRoomTime(peerLocal())).toBeCloseTo(T, 3);
    T += 5_000; // master silent → stale
    expect(peer.ready).toBe(false);
  });
});
