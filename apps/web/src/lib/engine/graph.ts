/**
 * Web Audio graph pieces. Browser-only (needs an AudioContext); imported by audioEngine only.
 *
 *  Voice (per source):  src → fade → splitter → per-object input ─→ objGain (objectGains)  ─→ chain.mainIn
 *                                                                 └→ bassSend (bassObjectGains) → chain.bassIn
 *  OutputChain:  mainIn ───────────────────────────┐
 *                bassIn → [LR4 LP] → bassGain ──────┴→ preHp → [LR4 HP @ mix.highpassHz] → preEq
 *                preEq → [EQ (no HP)] → preamp → wet ─┐
 *                preEq → dry ─────────────────────────┼→ limiter → delay → out → dest
 *                fxIn (click test) ───────────────────┘
 */
import {
  channelIndexFor,
  dbToGain,
  eqToBiquads,
  linkwitzRiley4,
  toIirArgs,
  type BiquadCoeffs,
  type DeviceMix,
} from '@syncsound/audio-core';
import type { DeviceEq, Scene } from '@syncsound/protocol';

export const SMOOTH_TAU = 0.03;
export const XFADE_SEC = 0.015;

export function smooth(ctx: BaseAudioContext, param: AudioParam, value: number, tau = SMOOTH_TAU) {
  param.setTargetAtTime(value, ctx.currentTime, tau);
}

function gainNode(ctx: BaseAudioContext, gain: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = gain;
  return g;
}

const iir = (ctx: BaseAudioContext, cs: BiquadCoeffs[]) =>
  cs.map((c) => {
    const { feedforward, feedback } = toIirArgs(c);
    return ctx.createIIRFilter(feedforward, feedback);
  });

function wire(from: AudioNode, nodes: AudioNode[], to: AudioNode) {
  let prev = from;
  for (const n of nodes) {
    prev.connect(n);
    prev = n;
  }
  prev.connect(to);
}

const disconnectAll = (nodes: AudioNode[]) => {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* not connected */
    }
  }
};

export class OutputChain {
  readonly mainIn: GainNode;
  readonly bassIn: GainNode;
  readonly fxIn: GainNode;
  private readonly bassGain: GainNode;
  private readonly preHp: GainNode;
  private readonly preEq: GainNode;
  private readonly preamp: GainNode;
  private readonly wet: GainNode;
  private readonly dry: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly delay: DelayNode;
  private readonly out: GainNode;
  private hp: AudioNode[] = [];
  private lp: AudioNode[] = [];
  private eq: AudioNode[] = [];
  private keys = { hp: '', lp: '', eq: '' };

  constructor(private readonly ctx: AudioContext) {
    this.mainIn = gainNode(ctx, 1);
    this.bassIn = gainNode(ctx, 1);
    this.fxIn = gainNode(ctx, 1);
    this.bassGain = gainNode(ctx, 0);
    this.preHp = gainNode(ctx, 1);
    this.preEq = gainNode(ctx, 1);
    this.preamp = gainNode(ctx, 1);
    this.wet = gainNode(ctx, 1);
    this.dry = gainNode(ctx, 0);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.ratio.value = 20;
    this.limiter.knee.value = 0;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;
    this.delay = ctx.createDelay(2);
    this.out = gainNode(ctx, 0);

    this.mainIn.connect(this.preHp);
    this.bassIn.connect(this.bassGain);
    this.bassGain.connect(this.preHp);
    this.preHp.connect(this.preEq);
    this.preEq.connect(this.preamp);
    this.preEq.connect(this.dry);
    this.preamp.connect(this.wet);
    this.wet.connect(this.limiter);
    this.dry.connect(this.limiter);
    this.fxIn.connect(this.limiter);
    this.limiter.connect(this.delay);
    this.delay.connect(this.out);
    this.out.connect(ctx.destination);
  }

  /** device-output high-pass (main + bass), LR4. mix.highpassHz already includes the protective eq.highpassHz. */
  setHighpass(hz: number | null) {
    const key = String(hz);
    if (key === this.keys.hp) return;
    this.keys.hp = key;
    const next = hz === null ? [] : iir(this.ctx, linkwitzRiley4(hz, this.ctx.sampleRate).highpass);
    this.preHp.disconnect();
    disconnectAll(this.hp);
    wire(this.preHp, next, this.preEq);
    this.hp = next;
  }

  setCrossover(hz: number) {
    const key = String(hz);
    if (key === this.keys.lp) return;
    this.keys.lp = key;
    const next = iir(this.ctx, linkwitzRiley4(hz, this.ctx.sampleRate).lowpass);
    this.bassIn.disconnect();
    disconnectAll(this.lp);
    wire(this.bassIn, next, this.bassGain);
    this.lp = next;
  }

  setEq(eq: DeviceEq | null) {
    const active = eq && eq.enabled ? eq : null;
    const key = JSON.stringify(active ? [active.bands, active.preampDb] : null);
    if (key === this.keys.eq) return;
    this.keys.eq = key;
    // the protective HP lives in mix.highpassHz (setHighpass), so build the EQ without it
    const next = active ? iir(this.ctx, eqToBiquads({ ...active, highpassHz: null }, this.ctx.sampleRate)) : [];
    this.preEq.disconnect();
    disconnectAll(this.eq);
    wire(this.preEq, next, this.preamp);
    this.preEq.connect(this.dry);
    this.eq = next;
    smooth(this.ctx, this.preamp.gain, active ? dbToGain(active.preampDb) : 1);
  }

  /** A/B: crossfade EQ'd (wet) vs dry */
  setBypass(bypass: boolean) {
    smooth(this.ctx, this.wet.gain, bypass ? 0 : 1);
    smooth(this.ctx, this.dry.gain, bypass ? 1 : 0);
  }

  setMix(mix: DeviceMix) {
    smooth(this.ctx, this.bassGain.gain, mix.bassGain);
    smooth(this.ctx, this.out.gain, mix.outputGain);
  }

  setDelayMs(ms: number) {
    smooth(this.ctx, this.delay.delayTime, Math.min(1.99, Math.max(0, ms / 1000)), 0.05);
  }

  dispose() {
    disconnectAll([
      this.mainIn,
      this.bassIn,
      this.fxIn,
      this.bassGain,
      this.preHp,
      this.preEq,
      this.preamp,
      this.wet,
      this.dry,
      this.limiter,
      this.delay,
      this.out,
      ...this.hp,
      ...this.lp,
      ...this.eq,
    ]);
  }
}

/** Per-source routing into the chain. Rebuilt when the object layout or channel count changes. */
export class Voice {
  readonly fade: GainNode;
  private readonly splitter: ChannelSplitterNode;
  private route: AudioNode[] = [];
  private objGains = new Map<string, GainNode>();
  private bassSends = new Map<string, GainNode>();
  private layoutKey = '';

  constructor(
    private readonly ctx: AudioContext,
    readonly input: AudioNode,
    readonly channels: number,
    private readonly chain: OutputChain,
  ) {
    this.fade = gainNode(ctx, 0);
    // force the declared channel count (mono capture streams get up-mixed to L=R)
    this.fade.channelCount = channels;
    this.fade.channelCountMode = 'explicit';
    this.fade.channelInterpretation = 'speakers';
    this.splitter = ctx.createChannelSplitter(channels);
    input.connect(this.fade);
    this.fade.connect(this.splitter);
  }

  apply(scene: Scene, mix: Pick<DeviceMix, 'objectGains' | 'bassObjectGains'>) {
    const key = JSON.stringify([this.channels, scene.upmix, scene.objects.map((o) => [o.id, o.channel])]);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.rebuild(scene, mix);
      return;
    }
    for (const [id, g] of this.objGains) smooth(this.ctx, g.gain, mix.objectGains[id] ?? 0);
    for (const [id, g] of this.bassSends) smooth(this.ctx, g.gain, mix.bassObjectGains[id] ?? 0);
  }

  private rebuild(scene: Scene, mix: Pick<DeviceMix, 'objectGains' | 'bassObjectGains'>) {
    const { ctx, splitter, chain, channels: n } = this;
    splitter.disconnect();
    disconnectAll(this.route);
    this.route = [];
    this.objGains.clear();
    this.bassSends.clear();
    const keep = <T extends AudioNode>(node: T) => (this.route.push(node), node);

    // stereo → surround upmix: C = 0.5(L+R)·0.707, side = 0.5(L−R); SL/SR = side, LP 7 kHz, delayed 12/17 ms
    const upmix = n === 2 && scene.upmix;
    let derived: Partial<Record<'C' | 'SL' | 'SR' | 'AMB', AudioNode>> = {};
    if (upmix) {
      const c = keep(gainNode(ctx, 0.5 * Math.SQRT1_2));
      splitter.connect(c, 0);
      splitter.connect(c, 1);
      const side = keep(gainNode(ctx, 1));
      const sl = keep(gainNode(ctx, 0.5));
      const sr = keep(gainNode(ctx, -0.5));
      splitter.connect(sl, 0);
      splitter.connect(sr, 1);
      sl.connect(side);
      sr.connect(side);
      const lp = keep(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      side.connect(lp);
      const dl = keep(ctx.createDelay(0.05));
      const dr = keep(ctx.createDelay(0.05));
      dl.delayTime.value = 0.012;
      dr.delayTime.value = 0.017;
      lp.connect(dl);
      lp.connect(dr);
      derived = { C: c, SL: dl, SR: dr, AMB: side };
    }

    for (const obj of scene.objects) {
      const idx = channelIndexFor(obj.channel, n);
      const from = idx === null ? derived[obj.channel as keyof typeof derived] : undefined;
      if (idx === null && !from) continue;
      const tap = (gain: number, dest: AudioNode) => {
        const g = keep(gainNode(ctx, gain));
        if (idx !== null) splitter.connect(g, idx);
        else from!.connect(g);
        g.connect(dest);
        return g;
      };
      // main bus = Σ objectGains·source (LFE never has one); bass bus = Σ bassObjectGains·source
      if (obj.channel !== 'LFE') this.objGains.set(obj.id, tap(mix.objectGains[obj.id] ?? 0, chain.mainIn));
      this.bassSends.set(obj.id, tap(mix.bassObjectGains[obj.id] ?? 0, chain.bassIn));
    }
  }

  dispose() {
    disconnectAll([this.fade, this.splitter, ...this.route]);
    try {
      this.input.disconnect(this.fade);
    } catch {
      /* already gone */
    }
  }
}
