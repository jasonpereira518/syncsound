'use client';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { LayoutId, ObjectChannel, type AudioObject, type Device, type Scene, type SceneUpdate, type Vec2 } from '@syncsound/protocol';
import { computeDeviceMix, dbapGains, freeSpot, layoutLabel, resizeRoom, suggestLayout, type DeviceMix } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { CHANNEL_COLOR, Icon, IconButton, Menu, Panel, RangeField, ROLE_COLOR, Toggle, inputClass, selectClass } from '../ui';
import { act, isTypingTarget, useCanControl } from './shared';

type Target = { kind: 'object' | 'device' | 'listener'; id: string };
type ScenePatch = Omit<SceneUpdate, 'type'>;

const SNAP = 0.25;
const GLYPH_PX = 34; // on-screen size of one glyph unit, so labels stay legible at any map or room size
const CHANNELS = ObjectChannel.options;

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtPos = (p: Vec2) => `x ${p.x.toFixed(2)} m, y ${p.y.toFixed(2)} m`;
const same = (a: Target | null, b: Target) => !!a && a.kind === b.kind && a.id === b.id;

function posOf(scene: Scene, t: Target, fallback: Record<string, Vec2>): Vec2 | null {
  if (t.kind === 'listener') return scene.listener;
  if (t.kind === 'device') return scene.devices[t.id] ?? fallback[t.id] ?? null;
  return scene.objects.find((o) => o.id === t.id)?.position ?? null;
}
function withPos(scene: Scene, t: Target, p: Vec2): Scene {
  if (t.kind === 'listener') return { ...scene, listener: p };
  if (t.kind === 'device') return { ...scene, devices: { ...scene.devices, [t.id]: p } };
  return { ...scene, objects: scene.objects.map((o) => (o.id === t.id ? { ...o, position: p } : o)) };
}
function patchFor(scene: Scene, t: Target): ScenePatch {
  if (t.kind === 'listener') return { listener: scene.listener };
  if (t.kind === 'device') return { devices: scene.devices };
  return { objects: scene.objects };
}
const sceneUpdate = (patch: ScenePatch, commit: boolean) => act(() => roomActions.updateScene(patch, { commit }));

/** Total linear level a device puts out for the scene (for the little meters). */
const totalGain = (m: DeviceMix) => {
  const sq = Object.values(m.objectGains).reduce((a, g) => a + g * g, 0) + m.bassGain * m.bassGain;
  return Math.min(1, m.outputGain * Math.sqrt(sq));
};

export function Stage() {
  const room = useRoomStore((s) => s.room);
  const canUndo = useRoomStore((s) => s.canUndo);
  const canRedo = useRoomStore((s) => s.canRedo);
  const identifyFlash = useRoomStore((s) => s.identifyFlash);
  const canControl = useCanControl();

  const [draft, setDraft] = useState<Scene | null>(null); // optimistic scene while dragging / until the store echoes
  const [draftBase, setDraftBase] = useState<Scene | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sel, setSel] = useState<Target | null>(null);
  const [snap, setSnap] = useState(false);
  const [announce, setAnnounce] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ t: Target; dx: number; dy: number; last: Scene | null } | null>(null);

  const base = room?.scene ?? null;
  const scene = draft && (dragging || draftBase === base) ? draft : base;
  const devices = useMemo(() => (room?.devices ?? []).filter((d) => d.connected || (base && base.devices[d.id])), [room?.devices, base]);

  // Undo / redo shortcuts
  useEffect(() => {
    if (!canControl) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isTypingTarget(e.target) || !(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) act(() => roomActions.undo());
      else if ((k === 'z' && e.shiftKey) || k === 'y') act(() => roomActions.redo());
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canControl]);

  // rendered pixels per metre, so glyphs can be sized in screen pixels rather than room metres
  const [pxPerM, setPxPerM] = useState(0);
  const geo = useMemo(() => {
    const W = scene?.room.width ?? 8;
    const D = scene?.room.depth ?? 6;
    const pad = Math.max(0.9, Math.max(W, D) * 0.13);
    const u = pxPerM > 0 ? Math.min(GLYPH_PX / pxPerM, pad * 0.8) : Math.max(W, D) / 13;
    return { W, D, pad, u };
  }, [scene?.room.width, scene?.room.depth, pxPerM]);

  const hasScene = !!scene;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const vb = el.viewBox.baseVal;
      const r = el.getBoundingClientRect();
      if (vb.width > 0 && r.width > 0) setPxPerM(Math.min(r.width / vb.width, r.height / vb.height));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasScene, geo.W, geo.D]);

  // Unplaced devices wait in a tray below the room until dragged in.
  const tray = useMemo(() => {
    const out: Record<string, Vec2> = {};
    const unplaced = devices.filter((d) => !scene?.devices[d.id]);
    unplaced.forEach((d, i) => {
      out[d.id] = { x: -geo.W / 2 + ((i + 0.5) * geo.W) / unplaced.length, y: geo.D / 2 + geo.pad * 0.55 };
    });
    return out;
  }, [devices, scene?.devices, geo]);

  const speakers = useMemo(
    () => devices.filter((d) => d.connected && scene?.devices[d.id]).map((d) => ({ id: d.id, pos: scene!.devices[d.id]! })),
    [devices, scene],
  );

  const selObj = sel?.kind === 'object' ? (scene?.objects.find((o) => o.id === sel.id) ?? null) : null;
  const selGains = useMemo(() => {
    if (!selObj || !scene || speakers.length === 0) return null;
    try {
      return dbapGains(selObj.position, speakers, { rolloff: scene.rolloff, blur: scene.blur });
    } catch {
      return null;
    }
  }, [selObj, speakers, scene]);

  const mixes = useMemo(() => {
    if (!scene || !room) return null;
    const out: Record<string, DeviceMix> = {};
    try {
      for (const s of speakers) out[s.id] = computeDeviceMix({ scene, devices: room.devices, masterVolume: room.volume }, s.id);
      return out;
    } catch {
      return null;
    }
  }, [scene, room, speakers]);

  if (!room || !scene || !base) return null;
  const { W, D, pad, u } = geo;

  const clampSnap = (p: Vec2): Vec2 => {
    let x = Math.min(W / 2, Math.max(-W / 2, p.x));
    let y = Math.min(D / 2, Math.max(-D / 2, p.y));
    if (snap) {
      x = Math.round(x / SNAP) * SNAP;
      y = Math.round(y / SNAP) * SNAP;
    }
    return { x: r2(x), y: r2(y) };
  };
  const toMeters = (e: PointerEvent): Vec2 | null => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const onDown = (e: PointerEvent<SVGGElement>, t: Target) => {
    setSel(t);
    if (!canControl || e.button !== 0) return;
    const m = toMeters(e);
    const p = posOf(scene, t, tray);
    if (!m || !p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { t, dx: p.x - m.x, dy: p.y - m.y, last: null };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current;
    const m = d && toMeters(e);
    if (!d || !m) return;
    const next = withPos(scene, d.t, clampSnap({ x: m.x + d.dx, y: m.y + d.dy }));
    d.last = next;
    setDraft(next);
    setDraftBase(base);
    sceneUpdate(patchFor(next, d.t), false);
  };
  const onUp = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (d.last) {
      setDraftBase(base); // keep showing the drop position until the store echoes a new scene
      sceneUpdate(patchFor(d.last, d.t), true);
    }
  };

  const onItemKey = (e: KeyboardEvent<SVGGElement>, t: Target, label: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSel(t);
      return;
    }
    if (!canControl) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && t.kind === 'object') {
      e.preventDefault();
      deleteObject(t.id);
      return;
    }
    // with snap on, a 0.1 m step would round straight back onto the same grid point
    const step = e.shiftKey ? 0.5 : snap ? SNAP : 0.1;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const dv = delta[e.key];
    const p = posOf(base, t, tray);
    if (!dv || !p) return;
    e.preventDefault();
    const np = clampSnap({ x: p.x + dv[0], y: p.y + dv[1] });
    const next = withPos(base, t, np);
    setSel(t);
    setDraft(next);
    setDraftBase(base);
    sceneUpdate(patchFor(next, t), true);
    setAnnounce(`${label} moved to ${fmtPos(np)}`);
  };

  const deleteObject = (id: string) => {
    const objects = base.objects.filter((o) => o.id !== id);
    setDraft({ ...base, objects });
    setDraftBase(base);
    sceneUpdate({ objects }, true);
    setSel(null);
  };

  const live = room.devices.filter((d) => d.connected);
  const hasSub = live.some((d) => d.role === 'Sub');
  const suggested = suggestLayout(live.filter((d) => d.role !== 'Sub').length);

  const applyLayout = (layout: LayoutId) => act(() => roomActions.setLayout(layout));

  // grid lines every metre
  const gridX: number[] = [];
  for (let x = Math.ceil(-W / 2); x <= Math.floor(W / 2); x++) gridX.push(x);
  const gridY: number[] = [];
  for (let y = Math.ceil(-D / 2); y <= Math.floor(D / 2); y++) gridY.push(y);

  const fs = u * 0.42;
  const lis = scene.listener;

  return (
    <Panel
      title="Stage"
      className="lg:h-full"
      actions={
        <>
          <IconButton icon="undo" label="Undo (Ctrl/Cmd+Z)" disabled={!canControl || !canUndo} onClick={() => act(() => roomActions.undo())} />
          <IconButton icon="redo" label="Redo (Shift+Ctrl/Cmd+Z)" disabled={!canControl || !canRedo} onClick={() => act(() => roomActions.redo())} />
          <IconButton icon="grid" label={`Snap to ${SNAP} m grid`} pressed={snap} onClick={() => setSnap(!snap)} />
          <Menu label="Add sound object" icon="plus" testid="stage-add-object" panelClassName="w-72 p-3">
            <AddObject
              disabled={!canControl || scene.objects.length >= 32}
              onAdd={(o) => {
                const taken = [base.listener, ...Object.values(base.devices), ...base.objects.map((x) => x.position)];
                const position = clampSnap(freeSpot({ x: 0, y: -D / 4 }, taken, base.room, Math.max(0.8, 2 * u)));
                const objects = [...base.objects, { ...o, position }];
                sceneUpdate({ objects }, true);
                setSel({ kind: 'object', id: o.id });
              }}
            />
          </Menu>
          <Menu label="Rendering and room size" icon="settings" testid="stage-settings" panelClassName="w-80 p-3">
            <fieldset disabled={!canControl} className="grid min-w-0 gap-3">
              <legend className="sr-only">Rendering and room size</legend>
              <Toggle
                label="Time-align to listener"
                checked={scene.propagationComp}
                disabled={!canControl}
                onChange={(v) => sceneUpdate({ propagationComp: v }, true)}
              />
              <Toggle label="Stereo → surround upmix" checked={scene.upmix} disabled={!canControl} onChange={(v) => sceneUpdate({ upmix: v }, true)} />
              <RangeField
                label="Rolloff"
                min={0.1}
                max={4}
                step={0.1}
                value={scene.rolloff}
                format={(v) => `${v.toFixed(1)} (${(6 * v).toFixed(0)} dB/dist×2)`}
                onLive={(v) => sceneUpdate({ rolloff: v }, false)}
                onCommit={(v) => sceneUpdate({ rolloff: v }, true)}
              />
              <RangeField
                label="Spatial blur"
                min={0.01}
                max={5}
                step={0.01}
                value={scene.blur}
                format={(v) => `${v.toFixed(2)} m`}
                onLive={(v) => sceneUpdate({ blur: v }, false)}
                onCommit={(v) => sceneUpdate({ blur: v }, true)}
              />
              <RangeField
                label="Bass crossover"
                min={40}
                max={250}
                step={5}
                value={scene.crossoverHz}
                format={(v) => `${v} Hz`}
                onCommit={(v) => sceneUpdate({ crossoverHz: v }, true)}
              />
              <div className="grid grid-cols-2 gap-3">
                <RangeField label="Room width" min={2} max={30} step={0.5} value={W} format={(v) => `${v} m`} onCommit={(v) => sceneUpdate(resizeRoom(base, { width: v, depth: D }), true)} />
                <RangeField label="Room depth" min={2} max={30} step={0.5} value={D} format={(v) => `${v} m`} onCommit={(v) => sceneUpdate(resizeRoom(base, { width: W, depth: v }), true)} />
              </div>
            </fieldset>
          </Menu>
        </>
      }
    >
      {/* desktop: the map takes whatever height the layout row leaves */}
      <div className="flex flex-col gap-2 lg:h-full">
        {!canControl && (
          <p className="flex items-center gap-2 text-sm text-ink-400">
            <Icon name="lock" className="size-4" /> Stage locked by the host.
          </p>
        )}
        <p id="stage-help" className="sr-only">
          Top-down map of the room, front stage at the top. Drag items, or focus one with Tab and use the arrow keys to move it by 0.1 metres (Shift
          for 0.5). Delete removes a selected sound object.
        </p>
        <div className="relative overflow-hidden rounded-lg border border-ink-800 bg-ink-950 lg:min-h-48 lg:flex-1">
          <svg
            ref={svgRef}
            data-testid="stage-svg"
            viewBox={`${-W / 2 - pad} ${-D / 2 - pad} ${W + 2 * pad} ${D + 2 * pad}`}
            className="block h-auto max-h-[60vh] w-full touch-none select-none lg:absolute lg:inset-0 lg:h-full lg:max-h-none"
            role="group"
            aria-label={`Room map, ${W} by ${D} metres`}
            aria-describedby="stage-help"
            onPointerDown={(e) => !(e.target as Element).closest('.stage-item') && setSel(null)}
          >
            <rect x={-W / 2} y={-D / 2} width={W} height={D} rx={u * 0.2} fill="var(--color-ink-900)" stroke="var(--color-ink-700)" strokeWidth={u * 0.04} />
            {gridX.map((x) => (
              <line key={`gx${x}`} x1={x} x2={x} y1={-D / 2} y2={D / 2} stroke="var(--color-ink-800)" strokeWidth={x === 0 ? u * 0.035 : u * 0.02} />
            ))}
            {gridY.map((y) => (
              <line key={`gy${y}`} y1={y} y2={y} x1={-W / 2} x2={W / 2} stroke="var(--color-ink-800)" strokeWidth={y === 0 ? u * 0.035 : u * 0.02} />
            ))}
            <line x1={-W / 2} x2={W / 2} y1={-D / 2} y2={-D / 2} stroke="var(--color-ink-500)" strokeWidth={u * 0.08} />
            <text x={0} y={-D / 2 - pad * 0.35} textAnchor="middle" fontSize={fs * 0.85} fill="var(--color-ink-400)">
              Front
            </text>
            <text x={W / 2} y={D / 2 + pad * 0.3} textAnchor="end" fontSize={fs * 0.8} fill="var(--color-ink-500)" className="font-mono">
              {W} × {D} m
            </text>
            {Object.keys(tray).length > 0 && (
              <text x={-W / 2} y={D / 2 + pad * 0.3} fontSize={fs * 0.8} fill="var(--color-ink-400)">
                Drag into the room ↑
              </text>
            )}

            {/* listener */}
            <StageItem
              t={{ kind: 'listener', id: 'listener' }}
              testid="stage-listener"
              label={`Listener (sweet spot) at ${fmtPos(lis)}`}
              p={lis}
              sel={sel}
              canMove={canControl}
              handlers={{ onDown, onMove, onUp, onItemKey }}
              name="Listener"
            >
              <circle className="focus-ring" r={u * 0.62} fill="none" strokeWidth={u * 0.06} />
              <circle r={u * 0.38} fill="var(--color-ink-950)" stroke="#fff" strokeWidth={u * 0.07} />
              <circle r={u * 0.1} fill="#fff" />
              <path d={`M${-u * 0.6} 0h${u * 0.15}M${u * 0.45} 0h${u * 0.15}M0 ${-u * 0.6}v${u * 0.15}`} stroke="#fff" strokeWidth={u * 0.05} />
              <text y={u * 0.95} textAnchor="middle" fontSize={fs * 0.85} fill="var(--color-ink-200)">
                listener
              </text>
            </StageItem>

            {/* gain lines for the selected object */}
            {selObj &&
              selGains &&
              speakers.map((s) => {
                const g = selGains[s.id] ?? 0;
                return (
                  <line
                    key={`gl-${s.id}`}
                    x1={selObj.position.x}
                    y1={selObj.position.y}
                    x2={s.pos.x}
                    y2={s.pos.y}
                    stroke={CHANNEL_COLOR[selObj.channel]}
                    strokeOpacity={0.15 + 0.85 * g}
                    strokeWidth={u * (0.03 + 0.22 * g)}
                    strokeDasharray={g < 0.05 ? `${u * 0.1} ${u * 0.1}` : undefined}
                    pointerEvents="none"
                  />
                );
              })}

            {/* devices */}
            {devices.map((d) => {
              const p = scene.devices[d.id] ?? tray[d.id];
              if (!p) return null;
              const mix = mixes?.[d.id];
              const g = selGains?.[d.id];
              return (
                <StageItem
                  key={d.id}
                  t={{ kind: 'device', id: d.id }}
                  testid={`stage-device-${d.id}`}
                  label={`${d.name}, ${d.role} speaker, ${scene.devices[d.id] ? `at ${fmtPos(p)}` : 'not placed yet'}`}
                  p={p}
                  sel={sel}
                  canMove={canControl}
                  handlers={{ onDown, onMove, onUp, onItemKey }}
                  name={d.name}
                  className={identifyFlash === d.id ? 'animate-flash' : undefined}
                  dim={!d.connected || !scene.devices[d.id]}
                >
                  <DeviceGlyph d={d} u={u} />
                  <text y={u * 1.0} textAnchor="middle" fontSize={fs * 0.82} fill="var(--color-ink-100)">
                    {d.name.length > 14 ? `${d.name.slice(0, 13)}…` : d.name}
                  </text>
                  {mix && (
                    <g transform={`translate(${-u * 0.6} ${u * 1.18})`}>
                      <rect width={u * 1.2} height={u * 0.13} rx={u * 0.06} fill="var(--color-ink-700)" />
                      <rect width={u * 1.2 * totalGain(mix)} height={u * 0.13} rx={u * 0.06} fill="var(--color-accent)" />
                      {scene.propagationComp && mix.delaySec > 0.00005 && (
                        <text x={u * 0.6} y={u * 0.5} textAnchor="middle" fontSize={fs * 0.66} fill="var(--color-ink-400)" className="font-mono">
                          +{(mix.delaySec * 1000).toFixed(1)} ms
                        </text>
                      )}
                    </g>
                  )}
                  {g != null && (
                    <text y={-u * 0.85} textAnchor="middle" fontSize={fs * 0.75} fill={CHANNEL_COLOR[selObj!.channel]} className="font-mono">
                      {(20 * Math.log10(Math.max(g, 1e-4))).toFixed(1)} dB
                    </text>
                  )}
                </StageItem>
              );
            })}

            {/* audio objects */}
            {scene.objects.map((o) => (
              <StageItem
                key={o.id}
                t={{ kind: 'object', id: o.id }}
                testid={`stage-object-${o.id}`}
                label={`Sound object ${o.label} (${o.channel}) at ${fmtPos(o.position)}`}
                p={o.position}
                sel={sel}
                canMove={canControl}
                handlers={{ onDown, onMove, onUp, onItemKey }}
                name={o.label}
              >
                <circle className="focus-ring" r={u * 0.66} fill="none" strokeWidth={u * 0.06} />
                <circle
                  r={u * 0.44}
                  fill={CHANNEL_COLOR[o.channel]}
                  fillOpacity={o.muted ? 0.08 : 0.28}
                  stroke={CHANNEL_COLOR[o.channel]}
                  strokeWidth={u * 0.07}
                  strokeDasharray={o.muted ? `${u * 0.12} ${u * 0.08}` : undefined}
                />
                <text y={fs * 0.36} textAnchor="middle" fontSize={o.channel.length > 2 ? fs * 0.72 : fs} fontWeight={700} fill="#fff" className="font-mono">
                  {o.channel}
                </text>
                {/* label above: presets park objects on speakers, whose names sit below */}
                <text y={-u * 0.62} textAnchor="middle" fontSize={fs * 0.72} fill="var(--color-ink-300)">
                  {o.label.length > 16 ? `${o.label.slice(0, 15)}…` : o.label}
                </text>
              </StageItem>
            ))}
          </svg>
          <Inspector
            sel={sel}
            scene={scene}
            devices={devices}
            gains={selGains}
            mixes={mixes}
            canControl={canControl}
            onDelete={deleteObject}
            onClose={() => setSel(null)}
          />
          <span className="sr-only" aria-live="polite">
            {announce}
          </span>
        </div>

        <fieldset disabled={!canControl} className="min-w-0 shrink-0">
          <legend className="sr-only">Speaker layout</legend>
          <div className="flex flex-wrap items-center gap-x-0.5">
            <span aria-hidden className="mr-1 shrink-0 text-xs text-ink-500">
              Layout
            </span>
            {LayoutId.options.map((l) => {
              const on = (scene.layout ?? 'custom') === l;
              return (
                <button
                  key={l}
                  type="button"
                  data-testid={`layout-${l}`}
                  aria-pressed={on}
                  title={l === suggested ? 'Suggested for this many speakers' : undefined}
                  onClick={() => applyLayout(l)}
                  className={`relative min-h-11 shrink-0 rounded-md px-2.5 text-sm whitespace-nowrap transition disabled:opacity-50 ${
                    on ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-100'
                  }`}
                >
                  {layoutLabel(l, hasSub)}
                  {l === suggested && (
                    <>
                      <span aria-hidden className="absolute top-2 right-1 size-1 rounded-full bg-accent" />
                      <span className="sr-only"> (suggested)</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </Panel>
  );
}

interface ItemHandlers {
  onDown: (e: PointerEvent<SVGGElement>, t: Target) => void;
  onMove: (e: PointerEvent<SVGGElement>) => void;
  onUp: (e: PointerEvent<SVGGElement>) => void;
  onItemKey: (e: KeyboardEvent<SVGGElement>, t: Target, label: string) => void;
}

function StageItem({
  t,
  p,
  sel,
  label,
  name,
  testid,
  canMove,
  handlers,
  className,
  dim,
  children,
}: {
  t: Target;
  p: Vec2;
  sel: Target | null;
  label: string;
  name: string;
  testid: string;
  canMove: boolean;
  handlers: ItemHandlers;
  className?: string;
  dim?: boolean;
  children: ReactNode;
}) {
  const selected = same(sel, t);
  return (
    <g
      transform={`translate(${p.x} ${p.y})`}
      data-testid={testid}
      data-x={p.x}
      data-y={p.y}
      tabIndex={0}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      aria-describedby="stage-help"
      className={`stage-item ${selected ? 'is-selected' : ''} ${className ?? ''}`}
      style={{ cursor: canMove ? 'grab' : 'pointer', opacity: dim ? 0.55 : 1 }}
      onPointerDown={(e) => handlers.onDown(e, t)}
      onPointerMove={handlers.onMove}
      onPointerUp={handlers.onUp}
      onPointerCancel={handlers.onUp}
      onKeyDown={(e) => handlers.onItemKey(e, t, name)}
    >
      {children}
    </g>
  );
}

function DeviceGlyph({ d, u }: { d: Device; u: number }) {
  const c = ROLE_COLOR[d.role];
  const size: Record<string, [number, number]> = {
    phone: [0.55, 1],
    tablet: [0.8, 1.05],
    laptop: [1.2, 0.78],
    desktop: [1.3, 0.9],
  };
  const wh = size[d.caps.deviceClass];
  const fs = u * 0.36;
  return (
    <>
      {wh ? (
        <>
          <rect className="focus-ring" x={(-wh[0] / 2 - 0.15) * u} y={(-wh[1] / 2 - 0.15) * u} width={(wh[0] + 0.3) * u} height={(wh[1] + 0.3) * u} rx={u * 0.2} fill="none" strokeWidth={u * 0.06} />
          <rect x={(-wh[0] / 2) * u} y={(-wh[1] / 2) * u} width={wh[0] * u} height={wh[1] * u} rx={u * 0.12} fill="var(--color-ink-850)" stroke={c} strokeWidth={u * 0.08} />
        </>
      ) : (
        <>
          <circle className="focus-ring" r={u * 0.7} fill="none" strokeWidth={u * 0.06} />
          <circle r={u * 0.52} fill="var(--color-ink-850)" stroke={c} strokeWidth={u * 0.08} />
        </>
      )}
      <text y={fs * 0.36} textAnchor="middle" fontSize={d.role.length > 2 ? fs * 0.8 : fs} fontWeight={700} fill={c} className="font-mono">
        {d.role}
      </text>
    </>
  );
}

function Inspector({
  sel,
  scene,
  devices,
  gains,
  mixes,
  canControl,
  onDelete,
  onClose,
}: {
  sel: Target | null;
  scene: Scene;
  devices: Device[];
  gains: Record<string, number> | null;
  mixes: Record<string, DeviceMix> | null;
  canControl: boolean;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  if (!sel) return null;
  const obj: AudioObject | undefined = sel.kind === 'object' ? scene.objects.find((o) => o.id === sel.id) : undefined;
  const dev = sel.kind === 'device' ? devices.find((d) => d.id === sel.id) : undefined;
  if (sel.kind !== 'listener' && !obj && !dev) return null; // removed by someone else
  const pos = sel.kind === 'listener' ? scene.listener : sel.kind === 'device' ? scene.devices[sel.id] : obj?.position;
  const mix = dev ? mixes?.[dev.id] : undefined;
  return (
    // desktop: floats over the map so selecting never resizes it; phones: sits under the map
    <div className="border-t border-ink-800 bg-ink-900 p-3 text-sm lg:absolute lg:top-2 lg:right-2 lg:max-h-[calc(100%-1rem)] lg:w-64 lg:overflow-y-auto lg:rounded-lg lg:border lg:border-ink-700 lg:shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-medium">{sel.kind === 'listener' ? 'Listener (sweet spot)' : (obj?.label ?? dev?.name)}</p>
        <div className="flex shrink-0 items-center gap-1">
          {obj && (
            <IconButton icon="trash" label={`Delete ${obj.label}`} className="!size-9 hover:!text-bad" disabled={!canControl} onClick={() => onDelete(obj.id)} />
          )}
          <IconButton icon="x" label="Close inspector" className="!size-9" onClick={onClose} />
        </div>
      </div>
      <p className="mt-1 font-mono text-xs text-ink-400">{pos ? fmtPos(pos) : 'not placed'}</p>
      {obj && gains && (
        <ul className="mt-2 space-y-1">
          {devices
            .filter((d) => gains[d.id] != null)
            .map((d) => {
              const g = gains[d.id] ?? 0;
              return (
                <li key={d.id} className="flex items-center gap-2">
                  <span className="w-24 truncate text-xs">{d.name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                    <span className="block h-full rounded-full" style={{ width: `${Math.round(g * 100)}%`, background: CHANNEL_COLOR[obj.channel] }} />
                  </span>
                  <span className="w-14 text-right font-mono text-xs text-ink-400 tabular">{(20 * Math.log10(Math.max(g, 1e-4))).toFixed(1)} dB</span>
                </li>
              );
            })}
        </ul>
      )}
      {obj && !gains && <p className="mt-2 text-xs text-ink-500">Place connected speakers in the room to see this object&rsquo;s gains.</p>}
      {mix && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
          <dt className="text-ink-400">Output</dt>
          <dd className="text-right font-mono tabular">{(20 * Math.log10(Math.max(totalGain(mix), 1e-4))).toFixed(1)} dB</dd>
          <dt className="text-ink-400">Delay</dt>
          <dd className="text-right font-mono tabular">{(mix.delaySec * 1000).toFixed(2)} ms</dd>
          <dt className="text-ink-400">High-pass</dt>
          <dd className="text-right font-mono tabular">{mix.highpassHz ? `${Math.round(mix.highpassHz)} Hz` : 'none'}</dd>
          {mix.bassGain > 0 && (
            <>
              <dt className="text-ink-400">Bass</dt>
              <dd className="text-right">on the bass bus</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

function AddObject({ onAdd, disabled }: { onAdd: (o: Omit<AudioObject, 'position'>) => void; disabled: boolean }) {
  const [label, setLabel] = useState('');
  const [channel, setChannel] = useState<ObjectChannel>('STEM');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = `obj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    onAdd({ id, label: label.trim().slice(0, 40) || `Object ${channel}`, channel, gainDb: 0, muted: false });
    setLabel('');
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <h3 className="text-sm text-ink-300">Add sound object</h3>
      <div className="flex gap-2">
        <label htmlFor="obj-label" className="sr-only">Object label</label>
        <input id="obj-label" maxLength={40} placeholder="Stem: vocals" value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        <label htmlFor="obj-channel" className="sr-only">Source channel</label>
        <select
          id="obj-channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as ObjectChannel)}
          className={`${selectClass} font-mono`}
        >
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <IconButton icon="plus" label="Add object" type="submit" disabled={disabled} className="bg-ink-800" />
      </div>
    </form>
  );
}
