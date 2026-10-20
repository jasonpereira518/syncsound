import { describe, expect, it } from 'vitest';
import { mungeOpusSdp } from './rtc';

const SDP = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=0', 'a=rtpmap:63 red/48000/2', ''].join('\r\n');

describe('mungeOpusSdp', () => {
  it('sets stereo, bitrate and FEC on the opus fmtp line, keeping other params', () => {
    const out = mungeOpusSdp(SDP);
    const line = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))!;
    expect(line).toContain('minptime=10');
    expect(line).toContain('useinbandfec=1');
    expect(line).toContain('stereo=1');
    expect(line).toContain('maxaveragebitrate=256000');
    expect(line).not.toContain('useinbandfec=0');
  });
  it('adds an fmtp line when missing', () => {
    const out = mungeOpusSdp(SDP.replace('a=fmtp:111 minptime=10;useinbandfec=0\r\n', ''));
    const lines = out.split('\r\n');
    expect(lines[lines.indexOf('a=rtpmap:111 opus/48000/2') + 1]).toMatch(/^a=fmtp:111 .*stereo=1/);
  });
  it('leaves SDP without opus untouched', () => {
    expect(mungeOpusSdp('v=0\r\n')).toBe('v=0\r\n');
  });
});
