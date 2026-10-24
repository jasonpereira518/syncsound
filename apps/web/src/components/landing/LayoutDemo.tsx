'use client';
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { dbapGains, slotPositions } from '@syncsound/audio-core';
import { defaultScene, type DeviceRole, type LayoutId, type Vec2 } from '@syncsound/protocol';
import { Speaker } from './Speaker';

/** the four layouts the setup wizard offers, as people say them */
const LAYOUTS: { id: LayoutId; label: string; slots: DeviceRole[] }[] = [
  { id: 'stereo', label: 'stereo', slots: ['L', 'R'] },
  { id: 'lcr', label: '3.1', slots: ['L', 'C', 'R', 'Sub'] },
  { id: 'surround5', label: '5.1', slots: ['L', 'R', 'C', 'SL', 'SR', 'Sub'] },
  { id: 'surround7', label: '7.1', slots: ['L', 'R', 'C', 'SL', 'SR', 'RL', 'RR', 'Sub'] },
];
const SLOT_NAME: Record<string, string> = {
  L: 'Front left',
  R: 'Front right',
  C: 'Centre',
  SL: 'Side left',
  SR: 'Side right',
  RL: 'Rear left',
  RR: 'Rear right',
  Sub: 'Sub',
};

const scene = defaultScene();
const { width: RW, depth: RD } = scene.room;
const pct = (p: Vec2) => ({ left: `${((p.x + RW / 2) / RW) * 100}%`, top: `${((p.y + RD / 2) / RD) * 100}%` });
const clampRoom = (p: Vec2): Vec2 => ({
  x: Math.max(-RW / 2 + 0.3, Math.min(RW / 2 - 0.3, p.x)),
  y: Math.max(-RD / 2 + 0.3, Math.min(RD / 2 - 0.3, p.y)),
});

/**
 * "Move the sound around your room": the real layout geometry (slotPositions) and the real position panner
 * (dbapGains, the one the room engine uses for placed sounds) on a plan of the default 8 × 6 m room.
 */
export function LayoutDemo() {
  const [layout, setLayout] = useState(LAYOUTS[2]!);
  const [sound, setSound] = useState<Vec2>({ x: -1.6, y: -1.2 });
  const plan = useRef<HTMLDivElement>(null);

  const speakers = useMemo(() => {
    const roles = Object.fromEntries(layout.slots.map((s) => [s, s])) as Record<string, DeviceRole>;
    const pos = slotPositions(layout.id, roles, scene);
    return layout.slots.map((slot) => ({ slot, pos: pos[slot]! }));
  }, [layout]);

  const gains = useMemo(
    () =>
      dbapGains(
        sound,
        speakers.filter((s) => s.slot !== 'Sub').map((s) => ({ id: s.slot, pos: s.pos })),
        { rolloff: scene.rolloff, blur: scene.blur },
      ),
    [sound, speakers],
  );

  const moveTo = (e: PointerEvent) => {
    const r = plan.current!.getBoundingClientRect();
    setSound(clampRoom({ x: ((e.clientX - r.left) / r.width - 0.5) * RW, y: ((e.clientY - r.top) / r.height - 0.5) * RD }));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.25;
    const d: Record<string, Vec2> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    setSound((p) => clampRoom({ x: p.x + v.x, y: p.y + v.y }));
  };

  const loudest = Object.entries(gains).sort((a, b) => b[1] - a[1])[0]?.[0];

  return (
    <div className="demo" data-layout={layout.id}>
      <div className="demo-copy">
        <h2 id="layouts-h" className="demo-h">
          Your room, in <span className="demo-word">{layout.label}</span>.
        </h2>
        <p className="lead">
          Pick the layout that matches the speakers you have, then drag the sound around the room. Each speaker
          plays only its own share, the way SyncSound mixes it for real.
        </p>
        <div className="seg" role="radiogroup" aria-label="Speaker layout" data-ui>
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={l.id === layout.id}
              data-testid={`demo-layout-${l.id}`}
              onClick={() => setLayout(l)}
              className="seg-btn"
            >
              {l.label === 'stereo' ? 'Stereo' : l.label}
            </button>
          ))}
        </div>
        <p className="demo-readout" aria-live="polite">
          Loudest now: <strong>{loudest ? SLOT_NAME[loudest] : 'none'}</strong>
        </p>
      </div>

      <div
        ref={plan}
        className="plan"
        data-ui
        data-testid="demo-plan"
        onPointerDown={(e) => {
          plan.current!.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => e.buttons && moveTo(e)}
      >
        <span className="plan-seat" style={pct(scene.listener)} aria-hidden>
          <span>You</span>
        </span>
        {speakers.map(({ slot, pos }) => {
          const g = slot === 'Sub' ? 0.5 : (gains[slot] ?? 0);
          const db = slot === 'Sub' ? null : 20 * Math.log10(Math.max(g, 1e-4));
          return (
            <figure key={slot} className="plan-spk" style={pct(pos)} data-testid="demo-speaker">
              <Speaker level={g} sizes="80px" alt="" />
              <figcaption>
                {SLOT_NAME[slot]}
                <span className="tabular" data-testid={`demo-level-${slot}`}>
                  {db === null ? 'bass only' : `${db.toFixed(1)} dB`}
                </span>
              </figcaption>
            </figure>
          );
        })}
        <button
          type="button"
          className="plan-sound"
          style={{ ...pct(sound), '--pulse': gains[loudest ?? ''] ?? 0 } as CSSProperties}
          aria-label={`Sound position, ${sound.x.toFixed(1)} m across and ${sound.y.toFixed(1)} m deep. Arrow keys move it.`}
          onKeyDown={onKey}
          data-testid="demo-sound"
        >
          <span className="plan-ring" aria-hidden />
          <span className="plan-ring" aria-hidden />
        </button>
      </div>
    </div>
  );
}
