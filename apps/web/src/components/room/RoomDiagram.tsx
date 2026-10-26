'use client';
import type { KeyboardEvent, PointerEvent, Ref } from 'react';
import type { Device, DeviceRole, LayoutId, Scene } from '@syncsound/protocol';
import { LAYOUT_SLOTS, slotPositions } from '@syncsound/audio-core';
import { ROLE_COLOR } from '../ui';

export const SLOT_NAME: Record<DeviceRole, string> = {
  L: 'Front left',
  R: 'Front right',
  C: 'Centre',
  SL: 'Surround left',
  SR: 'Surround right',
  RL: 'Rear left',
  RR: 'Rear right',
  Sub: 'Subwoofer',
  Full: 'Not placed',
};

/** where each spot of `layout` (plus the sub corner) sits, in room metres */
export function slotAnchors(layout: LayoutId, scene: Scene): Partial<Record<DeviceRole, { x: number; y: number }>> {
  const slots: DeviceRole[] = [...LAYOUT_SLOTS[layout], 'Sub'];
  return slotPositions(layout, Object.fromEntries(slots.map((s) => [s, s])), scene);
}

/**
 * Top-down room: the listening seat, one ring per slot of the layout (plus the sub corner), and the speakers sitting
 * in them. Tapping a ring picks that slot. `highlight` marks one device (a speaker's own screen). For dragging
 * (SpeakerSpots): `onSlotPointerDown` starts a drag from a spot, `dropTarget` rings the spot under the pointer and
 * `dragging` lifts the device being moved out of its spot.
 */
export function RoomDiagram({
  layout,
  scene,
  devices,
  selected,
  highlight,
  onSlot,
  onSlotPointerDown,
  dropTarget,
  dragging,
  svgRef,
}: {
  layout: LayoutId;
  scene: Scene;
  devices: Device[];
  selected?: DeviceRole | null;
  highlight?: string;
  onSlot?: (slot: DeviceRole) => void;
  onSlotPointerDown?: (slot: DeviceRole, e: PointerEvent<SVGGElement>) => void;
  dropTarget?: DeviceRole | null;
  dragging?: string | null;
  svgRef?: Ref<SVGSVGElement>;
}) {
  const slots: DeviceRole[] = [...LAYOUT_SLOTS[layout], 'Sub'];
  const anchors = slotAnchors(layout, scene);
  const W = scene.room.width;
  const D = scene.room.depth;
  const pad = 0.6;
  const r = 0.42;
  const lis = scene.listener;
  const live = devices.filter((d) => d.connected);

  return (
    <svg
      ref={svgRef}
      viewBox={`${-W / 2 - pad} ${-D / 2 - pad} ${W + 2 * pad} ${D + 2 * pad}`}
      className="block h-auto w-full select-none"
      role="group"
      aria-label="Your room from above, screen at the top"
    >
      <defs>
        <radialGradient id="seat-glow">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x={-W / 2} y={-D / 2} width={W} height={D} rx={0.25} fill="var(--color-ink-900)" stroke="var(--color-ink-600)" strokeWidth={0.04} />
      <rect x={-W / 4} y={-D / 2 - 0.12} width={W / 2} height={0.12} rx={0.05} fill="var(--color-accent)" opacity={0.7} />
      <text x={0} y={-D / 2 - 0.25} textAnchor="middle" fontSize={0.26} fill="var(--color-ink-400)">
        Screen
      </text>
      <g transform={`translate(${lis.x} ${lis.y})`} aria-hidden>
        <circle r={1.2} fill="url(#seat-glow)" />
        <rect x={-0.5} y={-0.18} width={1} height={0.5} rx={0.14} fill="var(--color-ink-700)" stroke="var(--color-ink-500)" strokeWidth={0.03} />
        <text y={0.68} textAnchor="middle" fontSize={0.24} fill="var(--color-ink-300)">
          You
        </text>
      </g>

      {slots.map((slot) => {
        const p = anchors[slot];
        if (!p) return null;
        const here = live.filter((d) => d.role === slot && d.id !== dragging);
        const color = ROLE_COLOR[slot];
        const ring = selected === slot || dropTarget === slot || here.some((d) => d.id === highlight);
        const names = here.map((d) => d.name).join(', ');
        const label = here.length ? names : SLOT_NAME[slot];
        const interactive = onSlot
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${SLOT_NAME[slot]}: ${here.length ? names : 'empty'}`,
              'aria-pressed': selected === slot,
              'data-testid': `slot-${slot}`,
              onClick: () => onSlot(slot),
              ...(onSlotPointerDown && here.length > 0
                ? { onPointerDown: (e: PointerEvent<SVGGElement>) => onSlotPointerDown(slot, e), style: { touchAction: 'none' as const } }
                : {}),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onSlot(slot);
              },
              className: 'cursor-pointer outline-none [&:focus-visible>circle]:stroke-accent',
            }
          : {};
        return (
          <g key={slot} {...interactive}>
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              fill={here.length ? color : 'var(--color-ink-950)'}
              fillOpacity={here.length ? 0.22 : 1}
              stroke={ring ? 'var(--color-accent)' : color}
              strokeWidth={ring ? 0.09 : 0.045}
              strokeDasharray={here.length ? undefined : '0.12 0.09'}
            />
            {here.length > 0 && (
              <text x={p.x} y={p.y} dy="0.35em" textAnchor="middle" fontSize={0.34} fontWeight={700} fill="var(--color-ink-100)" className="pointer-events-none">
                {here.length > 1 ? here.length : here[0]!.name.slice(0, 1).toUpperCase()}
              </text>
            )}
            <text x={p.x} y={p.y + r + 0.3} textAnchor="middle" fontSize={0.22} fill={here.length ? 'var(--color-ink-100)' : 'var(--color-ink-400)'}>
              {label.length > 22 ? `${label.slice(0, 21)}…` : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
