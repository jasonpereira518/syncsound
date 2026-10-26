'use client';
import { useEffect, useRef, useState } from 'react';
import { LayoutId, type Device, type DeviceRole } from '@syncsound/protocol';
import { isRoutedLayout, LAYOUT_SLOTS, layoutLabel, suggestLayout } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { CLASS_ICON, Icon } from '../ui';
import { RoomDiagram, SLOT_NAME } from './RoomDiagram';
import { act } from './shared';

const STANDARD = LayoutId.options.filter((l) => isRoutedLayout(l));

/** Pick a layout and give each speaker its spot: the suggestion is applied on first open, the picture is draggable. */
export function LayoutEditor({ devices }: { devices: Device[] }) {
  const scene = useRoomStore((s) => s.room?.scene);
  const [slot, setSlot] = useState<DeviceRole | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slot) picker.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [slot]);
  const subs = devices.filter((d) => d.role === 'Sub');
  const suggested = suggestLayout(devices.length - subs.length);
  const layout = scene?.layout;
  const routed = isRoutedLayout(layout);

  // first visit: start from the suggestion so the diagram is never empty
  useEffect(() => {
    if (!routed) act(() => roomActions.setLayout(suggested));
  }, [routed, suggested]);
  if (!scene || !routed) return null;

  const options = [suggested, ...STANDARD.filter((l) => l !== suggested)];
  const missing = LAYOUT_SLOTS[layout].filter((s) => !devices.some((d) => d.role === s));
  const unplaced = devices.filter((d) => d.role === 'Full');

  return (
    <div className="space-y-5" data-testid="layout-editor">
      <p className="text-ink-200">
        With {devices.length} speaker{devices.length === 1 ? '' : 's'}, <strong className="text-ink-100">{layoutLabel(suggested, subs.length > 0)}</strong> fits
        best. Tap a spot in the room to choose which speaker sits there; drag a speaker to where it really is.
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Speaker layout">
        {options.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={layout === l}
            data-testid={`wizard-layout-${l}`}
            onClick={() => act(() => roomActions.setLayout(l))}
            className={`min-h-10 rounded-full border px-4 text-sm transition ${
              layout === l ? 'border-accent bg-accent/15 text-ink-100' : 'border-ink-600 text-ink-300 hover:border-ink-400'
            }`}
          >
            {layoutLabel(l, subs.length > 0)}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-ink-700 bg-ink-950 p-2">
        <RoomDiagram layout={layout} scene={scene} devices={devices} selected={slot} onSlot={(s) => setSlot(s === slot ? null : s)} />
      </div>

      {slot ? (
        <div ref={picker} className="rounded-2xl border border-accent/40 p-3">
          <h2 className="text-sm text-ink-300">Who plays {SLOT_NAME[slot].toLowerCase()}?</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={d.role === slot}
                data-testid={`assign-${d.id}`}
                onClick={() => {
                  act(() => roomActions.assignSlot(d.id, slot));
                  setSlot(null);
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
        </div>
      ) : (
        <ul className="space-y-1 text-sm text-ink-300">
          {missing.length > 0 && <li>Empty spots ({missing.map((s) => SLOT_NAME[s].toLowerCase()).join(', ')}) are covered by the nearest speakers.</li>}
          {unplaced.length > 0 && (
            <li className="text-warn">
              {unplaced.map((d) => d.name).join(', ')} {unplaced.length === 1 ? 'has' : 'have'} no spot yet and will stay silent.
            </li>
          )}
          <li>A speaker with a big bass driver can be your subwoofer: tap the corner spot.</li>
          <li>Distances fix the shape of the room but not its mirror image: if left and right look swapped, pick the spots again.</li>
        </ul>
      )}
    </div>
  );
}
