'use client';
import { useState } from 'react';
import { DeviceRole, type Device, type DevicePatch } from '@syncsound/protocol';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Badge, CLASS_ICON, Icon, IconButton, Panel, RangeField, ROLE_COLOR, StatusDot, Toggle, fmtMs, fmtSigned } from '../ui';
import { act, currentTrack, syncStatusOf, useCanControl } from './shared';

const ROLES = DeviceRole.options;
const ROLE_LABEL: Record<DeviceRole, string> = { L: 'Left', R: 'Right', C: 'Centre', SL: 'Surround L', SR: 'Surround R', RL: 'Rear L', RR: 'Rear R', Sub: 'Sub', Full: 'Full range' };

const update = (patch: DevicePatch, id: string) => act(() => roomActions.updateDevice(patch, id));
const pct = (v: number) => `${Math.round(v * 100)}%`;

function BatterySaverToggle() {
  const on = useRoomStore((s) => s.engine.batterySaver);
  return (
    <Toggle
      label="Battery-friendly mode"
      description={on ? 'Fewer clock pings and sync checks on this device' : 'Full-rate sync on this device'}
      checked={on}
      onChange={(v) => act(() => roomActions.setBatterySaver(v))}
    />
  );
}
const db = (v: number) => `${fmtSigned(v, 1)} dB`;

export function DeviceList() {
  const room = useRoomStore((s) => s.room);
  const selfId = useRoomStore((s) => s.deviceId);
  const canControl = useCanControl();
  if (!room) return null;
  const devices = [...room.devices].sort(
    (a, b) => Number(b.id === selfId) - Number(a.id === selfId) || Number(b.isHost) - Number(a.isHost) || a.joinedAt - b.joinedAt,
  );
  return (
    <Panel title="Devices" icon="devices" className="lg:flex-1" actions={<Badge>{devices.filter((d) => d.connected).length} online</Badge>}>
      {!canControl && (
        <p className="mb-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-300">
          <Icon name="lock" className="mr-1 inline size-4 align-[-3px]" /> The host has locked control. You can still adjust your
          own speaker.
        </p>
      )}
      <ul className="space-y-3">
        {devices.map((d) => (
          <DeviceRow key={d.id} d={d} />
        ))}
      </ul>
    </Panel>
  );
}

function DeviceRow({ d }: { d: Device }) {
  const selfId = useRoomStore((s) => s.deviceId);
  const isHost = useRoomStore((s) => s.isHost);
  const clock = useRoomStore((s) => s.clock);
  const flashing = useRoomStore((s) => s.identifyFlash === d.id);
  const syncOnly = useRoomStore((s) => currentTrack(s.room)?.sourceClass === 'remote');
  const canControl = useCanControl();
  const isSelf = d.id === selfId;
  const editable = canControl || isSelf;
  const status = syncStatusOf(d, selfId, clock);
  const st = d.stats;
  const color = ROLE_COLOR[d.role];

  return (
    <li
      data-testid="device-row"
      data-device-id={d.id}
      className={`rounded-xl border bg-ink-850/70 p-3 ${isSelf ? 'border-accent/40' : 'border-ink-700'} ${d.connected ? '' : 'opacity-60'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className={`grid size-11 shrink-0 place-items-center rounded-xl border ${flashing ? 'animate-flash bg-accent text-accent-ink' : ''}`}
          style={flashing ? undefined : { borderColor: color, color }}
        >
          <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <NameField d={d} canRename={isSelf || isHost} />
            {isSelf && <Badge tone="accent">You</Badge>}
            {d.isHost && (
              <Badge>
                <Icon name="crown" className="size-3" /> Host
              </Badge>
            )}
            {!d.connected && <Badge tone="bad">Offline</Badge>}
            {syncOnly && <Badge tone="warn">Sync-only</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot status={status} />
            <span className="font-mono text-xs text-ink-400 tabular">
              rtt {fmtMs(st?.rttMs)} · off {st ? `${fmtSigned(st.offsetMs, 1)} ms` : '—'} · err {fmtMs(st?.syncErrorMs)}
            </span>
          </div>
        </div>
        <label className="sr-only" htmlFor={`role-${d.id}`}>
          Role for {d.name} ({ROLE_LABEL[d.role]})
        </label>
        <select
          id={`role-${d.id}`}
          value={d.role}
          disabled={!editable}
          onChange={(e) => update({ role: e.target.value as DeviceRole }, d.id)}
          className="h-11 w-20 shrink-0 rounded-xl border border-ink-600 bg-ink-800 px-2 font-mono text-sm disabled:opacity-50"
          style={{ color }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r} title={ROLE_LABEL[r]}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Badge>buffer: {st?.bufferState ?? 'unknown'}</Badge>
        {st?.battery != null && (
          <Badge tone={st.battery < 0.15 ? 'bad' : 'neutral'}>
            <Icon name="battery" className="size-3.5" /> {pct(st.battery)}
          </Badge>
        )}
        {d.calibratedLatencyMs != null && <Badge tone="ok">calibrated {fmtSigned(d.calibratedLatencyMs, 1)} ms</Badge>}
        {d.eq.source !== 'none' && <Badge>EQ: {d.eq.source}{d.eq.enabled ? '' : ' (off)'}</Badge>}
        <Badge>{d.caps.deviceClass}</Badge>
      </div>

      <details className="group mt-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-ink-300 hover:text-ink-100">
          <Icon name="sliders" className="size-4" />
          Adjust
          <span aria-hidden className="ml-auto transition group-open:rotate-90">›</span>
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <IconButton icon="wave" label={`Identify ${d.name} (beep and flash)`} onClick={() => act(() => roomActions.identify(d.id))} />
          <fieldset disabled={!editable} className="contents">
            <IconButton icon="mute" label={d.muted ? `Unmute ${d.name}` : `Mute ${d.name}`} pressed={d.muted} onClick={() => update({ muted: !d.muted }, d.id)} />
            <button
              type="button"
              aria-pressed={d.solo}
              onClick={() => update({ solo: !d.solo }, d.id)}
              className={`inline-flex size-11 items-center justify-center rounded-xl border font-mono text-sm font-bold disabled:opacity-40 ${
                d.solo ? 'border-warn bg-warn/15 text-warn' : 'border-ink-600 text-ink-300 hover:border-ink-400'
              }`}
            >
              <span aria-hidden>S</span>
              <span className="sr-only">Solo {d.name}</span>
            </button>
            <button
              type="button"
              onClick={() => act(() => roomActions.applyPresetEq(d.id))}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-ink-600 px-3 text-sm hover:border-ink-400 disabled:opacity-40"
            >
              <Icon name="eq" className="size-4" /> Use preset EQ
            </button>
          </fieldset>
        </div>
        <fieldset disabled={!editable} className="mt-3 grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Settings for {d.name}</legend>
          <RangeField label="Volume" min={0} max={1} step={0.01} value={d.volume} format={pct} onCommit={(v) => update({ volume: v }, d.id)} />
          <RangeField label="Trim" min={-24} max={12} step={0.5} value={d.trimDb} format={db} onCommit={(v) => update({ trimDb: v }, d.id)} />
          <div className="sm:col-span-2">
            <RangeField
              label="Manual latency (ms, + plays earlier)"
              min={-500}
              max={500}
              step={1}
              withNumber
              value={d.latencyMs}
              format={(v) => `${fmtSigned(v, 0)} ms`}
              onCommit={(v) => update({ latencyMs: Math.round(v) }, d.id)}
            />
          </div>
          <div className="sm:col-span-2">
            <Toggle
              label="EQ"
              description={d.eq.source === 'none' ? 'No EQ measured yet' : `${d.eq.bands.length} bands (${d.eq.source})`}
              checked={d.eq.enabled}
              disabled={!editable}
              onChange={(v) => update({ eq: { ...d.eq, enabled: v } }, d.id)}
            />
          </div>
          {isSelf && (
            <div className="sm:col-span-2">
              <BatterySaverToggle />
            </div>
          )}
        </fieldset>
      </details>
    </li>
  );
}

function NameField({ d, canRename }: { d: Device; canRename: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing === null) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium">{d.name}</span>
        {canRename && (
          <button
            type="button"
            aria-label={`Rename ${d.name}`}
            onClick={() => setEditing(d.name)}
            className="-my-2 inline-flex size-11 items-center justify-center rounded-lg text-ink-400 hover:text-ink-100"
          >
            <Icon name="edit" className="size-4" />
          </button>
        )}
      </span>
    );
  }
  const save = () => {
    const n = editing.trim().slice(0, 40);
    if (n && n !== d.name) update({ name: n }, d.id);
    setEditing(null);
  };
  return (
    <input
      autoFocus
      aria-label="Device name"
      maxLength={40}
      value={editing}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') setEditing(null);
      }}
      className="h-9 min-w-0 rounded-lg border border-accent bg-ink-900 px-2 text-sm"
    />
  );
}

/** Simplified status for guests: "You're a speaker". */
export function SpeakerCard() {
  const self = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.deviceId) ?? null);
  const clock = useRoomStore((s) => s.clock);
  const engine = useRoomStore((s) => s.engine);
  const hostOnly = useRoomStore((s) => !!s.room?.settings.hostOnlyControl);
  if (!self) return null;
  const status = syncStatusOf(self, self.id, clock);
  return (
    <section aria-labelledby="speaker-h" className="rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        <span className="relative grid size-16 shrink-0 place-items-center rounded-2xl border-2 border-accent text-accent">
          {engine.bufferState === 'playing' && <span aria-hidden className="absolute inset-0 animate-ring rounded-2xl border border-accent" />}
          <Icon name={CLASS_ICON[self.caps.deviceClass]} className="size-8" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="speaker-h" className="font-display text-2xl font-bold tracking-tight">
            You&rsquo;re a speaker
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusDot status={status} testid="self-sync-status" />
            <Badge>
              role <strong className="ml-1" style={{ color: ROLE_COLOR[self.role] }}>{self.role}</strong>
            </Badge>
            <Badge>{fmtMs(engine.syncErrorMs)} error</Badge>
            {!engine.wakeLock && <Badge tone="warn">screen may sleep</Badge>}
          </div>
        </div>
      </div>
      {!!self.volumeUpDb && (
        <p role="status" data-testid="volume-up-hint" className="mt-3 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <strong className="text-warn">This speaker is quieter than the rest.</strong> Turn this device&rsquo;s own volume up (about{' '}
          {Math.round(self.volumeUpDb)} dB), then tune the room again so everyone can play louder.
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <RangeField label="My volume" min={0} max={1} step={0.01} value={self.volume} format={pct} onCommit={(v) => update({ volume: v }, self.id)} />
        <RangeField
          label="My latency trim (ms)"
          min={-500}
          max={500}
          step={1}
          withNumber
          value={self.latencyMs}
          format={(v) => `${fmtSigned(v, 0)} ms`}
          onCommit={(v) => update({ latencyMs: Math.round(v) }, self.id)}
        />
        <div className="sm:col-span-2">
          <BatterySaverToggle />
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-400">
        {hostOnly
          ? 'The host has locked playback and the stage. You can still adjust your own volume and latency.'
          : 'Keep this tab in front and the screen on. Full controls are in the tabs below.'}
      </p>
    </section>
  );
}
