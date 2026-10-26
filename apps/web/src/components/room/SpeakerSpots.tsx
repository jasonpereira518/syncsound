'use client';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Device, DeviceRole, LayoutId, Scene } from '@syncsound/protocol';
import { LAYOUT_SLOTS } from '@syncsound/audio-core';
import { roomActions } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon } from '../ui';
import { RoomDiagram, SLOT_NAME, slotAnchors } from './RoomDiagram';
import { act } from './shared';

const DRAG_PX = 6; // pointer travel before a press becomes a drag
const DROP_M = 0.9; // a drop this close to a spot lands in it

interface Drag {
  id: string;
  name: string;
  role: DeviceRole;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
  over: DeviceRole | null;
}

/**
 * Preset spots for a standard layout, one speaker each: drag a speaker onto a spot (onto another speaker to swap
 * them), drag it to the tray to take it out, or tap a spot to pick its speaker. Reset re-runs the automatic fill.
 */
export function SpeakerSpots({ layout, scene, devices, canControl = true }: { layout: LayoutId; scene: Scene; devices: Device[]; canControl?: boolean }) {
  const live = devices.filter((d) => d.connected);
  const [slot, setSlot] = useState<DeviceRole | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const justDragged = useRef(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slot) picker.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [slot]);

  // what the pointer is over: a spot (nearest within DROP_M), the tray ('Full'), or nothing
  const anchors = slotAnchors(layout, scene);
  const targetAt = (x: number, y: number): DeviceRole | null => {
    const t = trayRef.current?.getBoundingClientRect();
    if (t && x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) return 'Full';
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(x, y).matrixTransform(ctm.inverse());
    let best: DeviceRole | null = null;
    let bestD = DROP_M;
    for (const [s, a] of Object.entries(anchors)) {
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bestD) [best, bestD] = [s as DeviceRole, d];
    }
    return best;
  };
  const targetRef = useRef(targetAt);
  useEffect(() => {
    targetRef.current = targetAt;
  });

  const pressing = drag !== null;
  useEffect(() => {
    if (!pressing) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > DRAG_PX;
      const next = { ...d, x: e.clientX, y: e.clientY, moved, over: moved ? targetRef.current(e.clientX, e.clientY) : null };
      dragRef.current = next;
      setDrag(next);
    };
    const end = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return; // a plain tap: the spot's click opens its picker
      // the click that follows a drag must not open a picker
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const to = e.type === 'pointerup' ? targetRef.current(e.clientX, e.clientY) : null;
      if (to && to !== d.role) act(() => roomActions.placeInSlot(d.id, to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [pressing]);

  const start = (e: ReactPointerEvent, d: Device) => {
    if (!canControl || e.button !== 0) return;
    const s: Drag = { id: d.id, name: d.name, role: d.role, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, over: null };
    dragRef.current = s;
    setDrag(s);
  };

  const lifted = drag?.moved ? drag : null;
  const unplaced = live.filter((d) => d.role === 'Full' && d.id !== lifted?.id);
  const missing = LAYOUT_SLOTS[layout].filter((s) => !live.some((d) => d.role === s));

  return (
    <div className="space-y-3">
      {canControl && (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-ink-300">Drag a speaker onto a spot, or tap a spot to choose who plays there.</p>
          <Button variant="ghost" data-testid="reset-spots" className="!min-h-9 shrink-0 text-sm" onClick={() => act(() => roomActions.resetSlots())}>
            <Icon name="undo" className="size-4" /> Reset
          </Button>
        </div>
      )}
      <div className="rounded-2xl border border-ink-700 bg-ink-950 p-2">
        <RoomDiagram
          layout={layout}
          scene={scene}
          devices={devices}
          selected={slot}
          svgRef={svgRef}
          dropTarget={lifted?.over}
          dragging={lifted?.id}
          onSlot={canControl ? (s) => !justDragged.current && setSlot(s === slot ? null : s) : undefined}
          onSlotPointerDown={
            canControl
              ? (s, e) => {
                  const d = live.find((x) => x.role === s);
                  if (d) start(e, d);
                }
              : undefined
          }
        />
      </div>

      {canControl && (
        <div
          ref={trayRef}
          data-testid="spots-tray"
          className={`rounded-2xl border border-dashed p-3 transition ${lifted?.over === 'Full' ? 'border-accent bg-accent/10' : 'border-ink-600'}`}
        >
          <h3 className="text-xs tracking-widest text-ink-400 uppercase">Not placed</h3>
          {unplaced.length ? (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unplaced.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    data-testid={`tray-${d.id}`}
                    onPointerDown={(e) => start(e, d)}
                    className="flex min-h-10 cursor-grab touch-none items-center gap-2 rounded-full border border-ink-600 px-3 text-sm select-none hover:border-ink-400"
                  >
                    <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-4" />
                    {d.name}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-warn">These stay silent until they have a spot.</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-400">Drag a speaker here to take it out of the layout.</p>
          )}
        </div>
      )}

      {slot && canControl && (
        <div ref={picker} className="rounded-2xl border border-accent/40 p-3">
          <SpotPicker slot={slot} devices={live} onDone={() => setSlot(null)} />
        </div>
      )}

      {missing.length > 0 && !slot && (
        <p className="text-sm text-ink-400">Empty spots ({missing.map((s) => SLOT_NAME[s].toLowerCase()).join(', ')}) are covered by the nearest speakers.</p>
      )}

      {lifted && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[70] -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-ink-900 px-3 py-1.5 text-sm shadow-xl"
          style={{ left: lifted.x, top: lifted.y }}
        >
          {lifted.name}
        </div>
      )}
    </div>
  );
}

/** "Who plays front left?": every live speaker; picking one puts it there (swapping), picking the current one empties the spot */
export function SpotPicker({ slot, devices, onDone }: { slot: DeviceRole; devices: Device[]; onDone: () => void }) {
  return (
    <>
      <h3 className="text-sm text-ink-300">Who plays {SLOT_NAME[slot].toLowerCase()}?</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {devices
          .filter((d) => d.connected)
          .map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={d.role === slot}
              data-testid={`assign-${d.id}`}
              onClick={() => {
                act(() => roomActions.placeInSlot(d.id, d.role === slot ? 'Full' : slot));
                onDone();
              }}
              className={`flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm ${
                d.role === slot ? 'border-accent bg-accent/15' : 'border-ink-600 hover:border-ink-400'
              }`}
            >
              <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-4" />
              {d.name}
              {d.role !== 'Full' && d.role !== slot && <span className="text-xs text-ink-400">now {SLOT_NAME[d.role].toLowerCase()}</span>}
            </button>
          ))}
      </div>
    </>
  );
}
