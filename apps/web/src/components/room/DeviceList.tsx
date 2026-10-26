'use client';
import { useState } from 'react';
import { DeviceRole, MAX_MANUAL_LATENCY_MS, type Device, type DevicePatch } from '@syncsound/protocol';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Badge, Button, CLASS_ICON, Icon, IconButton, Note, Panel, RangeField, ROLE_COLOR, Select, StatusDot, Toggle, fmtMs, fmtSigned } from '../ui';
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
  const online = devices.filter((d) => d.connected).length;
  return (
    <Panel title="Devices" icon="devices" className="lg:flex-1" actions={<span className="text-sm text-ink-300">{online} online</span>}>
      {!canControl && (
        <Note icon="lock" className="mb-3">
          The host has locked control. You can still adjust your own speaker.
        </Note>
      )}
      <ul className="divide-y divide-ink-800">
        {devices.map((d) => (
          <DeviceRow key={d.id} d={d} />
        ))}
      </ul>
    </Panel>
  );
}

const STATUS_WORD = { ok: 'In sync', warn: 'Drifting', bad: 'Out of sync' } as const;

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
  const lowBattery = st?.battery != null && st.battery < 0.15;
  const facts = [
    d.connected ? `${STATUS_WORD[status]}${st ? ` · ${fmtMs(st.syncErrorMs)}` : ''}` : 'Offline',
    isSelf ? 'You' : null,
    d.isHost ? 'Host' : null,
    d.caps.deviceClass === 'bluetooth' ? 'Bluetooth' : null,
  ].filter(Boolean);

  return (
    <li data-testid="device-row" data-device-id={d.id} className={`py-3 first:pt-0 ${d.connected ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={`relative grid size-11 shrink-0 place-items-center rounded-full ${
            flashing ? 'animate-flash bg-accent text-accent-ink' : 'bg-ink-800 text-ink-100'
          }`}
        >
          <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-5" />
          <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full ring-[3px] ring-ink-850 max-lg:ring-ink-950" style={{ background: color }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <NameField d={d} canRename={isSelf || isHost} />
            {!d.connected && <Badge tone="bad">Offline</Badge>}
            {syncOnly && <Badge tone="warn">Sync-only</Badge>}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-ink-300">
            {d.connected && <StatusDot status={status} label="" />}
            <span className="truncate">{facts.join(' · ')}</span>
            {lowBattery && (
              <span className="inline-flex shrink-0 items-center gap-1 text-bad">
                <Icon name="battery-low" className="size-4" /> {pct(st.battery!)}
              </span>
            )}
          </p>
        </div>
        <label className="sr-only" htmlFor={`role-${d.id}`}>
          Role for {d.name} ({ROLE_LABEL[d.role]})
        </label>
        <Select
          id={`role-${d.id}`}
          value={d.role}
          disabled={!editable}
          onChange={(e) => update({ role: e.target.value as DeviceRole }, d.id)}
          wrapClassName="w-[4.75rem]"
          style={{ color }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r} title={ROLE_LABEL[r]}>
              {r}
            </option>
          ))}
        </Select>
      </div>

      <details className="group mt-1.5 sm:ml-14">
        <summary className="-ml-3 inline-flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-full px-3 text-sm text-ink-300 transition hover:bg-ink-800 hover:text-ink-100">
          <Icon name="sliders" className="size-4" />
          Adjust
          <Icon name="chevron-down" className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <p className="mt-2 text-xs text-ink-400 tabular">
          rtt {fmtMs(st?.rttMs)} · offset {st ? `${fmtSigned(st.offsetMs, 1)} ms` : '—'} · buffer {st?.bufferState ?? 'unknown'}
          {st?.battery != null && ` · battery ${pct(st.battery)}`}
          {d.calibratedLatencyMs != null && ` · calibrated ${fmtSigned(d.calibratedLatencyMs, 1)} ms`}
          {d.eq.source !== 'none' && ` · EQ ${d.eq.source}${d.eq.enabled ? '' : ' (off)'}`} · {d.caps.deviceClass}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <IconButton icon="bell" label={`Identify ${d.name} (beep and flash)`} onClick={() => act(() => roomActions.identify(d.id))} />
          <fieldset disabled={!editable} className="contents">
            <IconButton icon="mute" label={d.muted ? `Unmute ${d.name}` : `Mute ${d.name}`} pressed={d.muted} onClick={() => update({ muted: !d.muted }, d.id)} />
            <button
              type="button"
              aria-pressed={d.solo}
              onClick={() => update({ solo: !d.solo }, d.id)}
              className={`inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-medium transition disabled:opacity-40 ${
                d.solo ? 'bg-warn/15 text-warn' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'
              }`}
            >
              Solo<span className="sr-only"> {d.name}</span>
            </button>
            <Button onClick={() => act(() => roomActions.applyPresetEq(d.id))}>
              <Icon name="eq" className="size-4" /> Use preset EQ
            </Button>
          </fieldset>
        </div>
        <fieldset disabled={!editable} className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <legend className="sr-only">Settings for {d.name}</legend>
          <RangeField label="Balance (this speaker only)" min={0} max={1} step={0.01} value={d.volume} format={pct} onCommit={(v) => update({ volume: v }, d.id)} />
          <RangeField label="Trim" min={-24} max={12} step={0.5} value={d.trimDb} format={db} onCommit={(v) => update({ trimDb: v }, d.id)} />
          <div className="sm:col-span-2">
            <RangeField
              label="Manual latency (ms, + plays earlier)"
              min={-MAX_MANUAL_LATENCY_MS}
              max={MAX_MANUAL_LATENCY_MS}
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
        <span className="truncate font-medium text-ink-100">{d.name}</span>
        {canRename && (
          <button
            type="button"
            aria-label={`Rename ${d.name}`}
            onClick={() => setEditing(d.name)}
            className="-my-2 inline-flex size-9 items-center justify-center rounded-full text-ink-400 transition hover:bg-ink-800 hover:text-ink-100"
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
      className="h-9 min-w-0 rounded-full bg-ink-800 px-3 text-sm text-ink-100 outline-none ring-2 ring-accent"
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
    <section aria-labelledby="speaker-h" className="rounded-panel bg-ink-850 p-5 max-lg:bg-ink-900">
      <div className="flex flex-wrap items-center gap-4">
        <span className="relative grid size-14 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
          {engine.bufferState === 'playing' && <span aria-hidden className="absolute inset-0 animate-ring rounded-full border-2 border-accent" />}
          <Icon name={CLASS_ICON[self.caps.deviceClass]} className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="speaker-h" className="font-display text-2xl font-semibold tracking-[-0.03em]">
            You&rsquo;re a speaker
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-300">
            <StatusDot status={status} testid="self-sync-status" />
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: ROLE_COLOR[self.role] }} />
              Role {self.role}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular">{fmtMs(engine.syncErrorMs)} error</span>
          </p>
          {!engine.wakeLock && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-warn">
              <Icon name="moon" className="size-4" /> Screen may sleep
            </p>
          )}
        </div>
      </div>
      {!!self.volumeUpDb && (
        <Note role="status" data-testid="volume-up-hint" icon="warning" tone="warn" className="mt-4">
          <strong className="font-semibold">This speaker is quieter than the rest.</strong> Turn this device&rsquo;s own volume up (about{' '}
          {Math.round(self.volumeUpDb)} dB), then tune the room again so it can keep up with the others.
        </Note>
      )}
      <div className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <RangeField label="My balance" min={0} max={1} step={0.01} value={self.volume} format={pct} onCommit={(v) => update({ volume: v }, self.id)} />
        <RangeField
          label="My latency trim (ms)"
          min={-MAX_MANUAL_LATENCY_MS}
          max={MAX_MANUAL_LATENCY_MS}
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
