import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockSync } from '@syncsound/audio-core';
import type { Device, RtcData } from '@syncsound/protocol';
import {
  ClockLink,
  DISCONNECT_GRACE_MS,
  MAP_STALE_MS,
  READY_HOLD_MS,
  RECONNECT_BACKOFF_MS,
  parseLinkMsg,
  pickClockMaster,
} from './clockLink';

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
    expect(parseLinkMsg('{"t":"pong","t0":1,"r":2,"s":3,"d":{"t0":1,"a0":2,"s1":0,"s2":0,"tEnd":null}}')).toEqual({
      t: 'pong',
      t0: 1,
      r: 2,
      s: 3,
      d: { t0: 1, a0: 2, s1: 0, s2: 0, tEnd: Infinity },
    });
    expect(parseLinkMsg('{"t":"pong","t0":1,"r":2,"s":3,"d":{"bogus":true}}')).toEqual({ t: 'pong', t0: 1, r: 2, s: 3 });
    expect(parseLinkMsg('{"t":"pong","t0":1,"r":"x","s":2}')).toBeNull();
    expect(parseLinkMsg('not json')).toBeNull();
  });
});

/** a master and a peer with zero-delay links; T is the true room time, advanced by the test */
function pair() {
  const st = { T: 1_700_000_000_000 };
  const masterLocal = () => st.T - 5_000;
  const peerLocal = () => st.T - 12_345.678;
  const server = new ClockSync();
  const send = () => {};
  const master = new ClockLink({ selfId: 'm', send, serverClock: () => server, now: masterLocal });
  const peer = new ClockLink({ selfId: 'p', send, serverClock: () => new ClockSync(), now: peerLocal });
  master.setMaster('m');
  // peer.setMaster would open an RTCPeerConnection; set the field the same way connect() would leave it
  (peer as unknown as { master: string }).master = 'm';
  const exchange = () => {
    server.addSample({ t0: masterLocal(), tsRecv: st.T, tsSend: st.T, t3: masterLocal() }); // zero-delay server link
    const pong = master.onMessage('p', { t: 'ping', t0: peerLocal() });
    expect(pong?.t).toBe('pong');
    peer.onMessage('m', pong!);
    return pong!;
  };
  return { st, masterLocal, peerLocal, server, master, peer, exchange };
}

describe('ClockLink', () => {
  it('a peer maps its clock through the master to the master’s room time, after a ready hold', () => {
    const { st, peerLocal, master, peer, exchange } = pair();
    expect(peer.ready).toBe(false);
    for (let i = 0; i < 20; i++, st.T += 100) exchange();
    peer.onMessage('m', master.mapMsg()!);
    expect(peer.ready).toBe(false); // healthy, but not yet for READY_HOLD_MS
    for (let i = 0; i < READY_HOLD_MS / 100; i++, st.T += 100) exchange();
    expect(peer.ready).toBe(true);
    expect(peer.toRoomTime(peerLocal())).toBeCloseTo(st.T, 3);
    expect(peer.toLocalTime(st.T)).toBeCloseTo(peerLocal(), 3);
    expect(peer.frozenAt(peerLocal()).toRoomTime(peerLocal())).toBeCloseTo(st.T, 3);
    // messages from anyone but the master are ignored
    peer.onMessage('x', { t: 'map', d: { t0: 0, a0: 999, s1: 0, tEnd: Infinity, s2: 0 } });
    expect(peer.toRoomTime(peerLocal())).toBeCloseTo(st.T, 3);
    st.T += 5_000; // master silent → stale, and the hold starts over when it is back
    expect(peer.ready).toBe(false);
    for (let i = 0; i < 10; i++, st.T += 100) exchange();
    expect(peer.ready).toBe(false);
    for (let i = 0; i < READY_HOLD_MS / 100; i++, st.T += 100) exchange();
    expect(peer.ready).toBe(true);
  });

  it('pongs carry the mapping when it changed, and a stale mapping is not ready', () => {
    const { st, peer, exchange } = pair();
    const first = exchange();
    expect(first.t === 'pong' && first.d).toBeTruthy(); // first pong after the server clock has a mapping
    st.T += 100;
    const withMap = [exchange()].filter((p) => p.t === 'pong' && p.d).length; // the server clock moved → new t0
    expect(withMap).toBe(1);
    for (let i = 0; i < 30; i++, st.T += 100) exchange();
    expect(peer.ready).toBe(false); // healthy from here: the hold starts
    for (let i = 0; i < READY_HOLD_MS / 100; i++, st.T += 100) exchange();
    expect(peer.ready).toBe(true);
    // pongs keep coming but no mapping for MAP_STALE_MS → not ready
    const link = peer as unknown as { mappingAt: number };
    link.mappingAt -= MAP_STALE_MS;
    expect(peer.ready).toBe(false);
  });
});

/** a fake RTCPeerConnection: enough surface for connect(), wire() and the state handlers */
class FakePc {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  ondatachannel: (() => void) | null = null;
  localDescription = { sdp: 'offer' };
  remoteDescription = null;
  dc = { readyState: 'open', onmessage: null, onopen: null as (() => void) | null, onclose: null as (() => void) | null, send() {} };
  createDataChannel() {
    return this.dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
  }
}

describe('ClockLink reconnect', () => {
  afterEach(() => vi.useRealTimers());

  it('rebuilds a dropped link to the same master with backoff; a new master cancels it', async () => {
    vi.useFakeTimers();
    const pcs: FakePc[] = [];
    const sent: Array<{ to: string; data: RtcData }> = [];
    const peer = new ClockLink({
      selfId: 'p',
      send: (to, data) => sent.push({ to, data }),
      serverClock: () => new ClockSync(),
      now: () => Date.now(),
      createPeerConnection: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc as unknown as RTCPeerConnection;
      },
    });
    peer.setMaster('m');
    await vi.advanceTimersByTimeAsync(0);
    expect(pcs.length).toBe(1);
    expect(sent.filter((s) => s.data.kind === 'offer').length).toBe(1);
    // the channel opens, then ICE drops: a short blip is tolerated…
    pcs[0]!.dc.onopen?.();
    pcs[0]!.connectionState = 'disconnected';
    pcs[0]!.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS / 2);
    pcs[0]!.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    expect(pcs.length).toBe(1);
    // …a lasting one is not: reconnect after the first backoff step
    pcs[0]!.connectionState = 'disconnected';
    pcs[0]!.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + RECONNECT_BACKOFF_MS[0]! + 10);
    expect(pcs.length).toBe(2);
    expect(sent.filter((s) => s.data.kind === 'offer').length).toBe(2);
    // the new channel closes before opening: next backoff step
    pcs[1]!.dc.onclose?.();
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[0]! + 10);
    expect(pcs.length).toBe(2);
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[1]!);
    expect(pcs.length).toBe(3);
    // a different master takes over: pending reconnects are dropped, a fresh link is made to it
    pcs[2]!.dc.onclose?.();
    peer.setMaster('m2');
    await vi.advanceTimersByTimeAsync(0);
    expect(pcs.length).toBe(4);
    expect(sent.at(-1)!.to).toBe('m2');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pcs.length).toBe(4);
    peer.dispose();
  });
});
