'use client';
import { useState, type ReactNode } from 'react';
import { DeviceRole, MAX_MANUAL_LATENCY_MS, type Device, type DevicePatch } from '@syncsound/protocol';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, Icon, IconButton, Panel, RangeField, ROLE_COLOR, StatusDot, Toggle, fmtMs, fmtSigned, selectClass } from '../ui';
import { act, syncStatusOf, useCanControl } from './shared';

const ROLES = DeviceRole.options;
const ROLE_LABEL: Record<DeviceRole, string> = { L: 'Left', R: 'Right', C: 'Centre', SL: 'Surround L', SR: 'Surround R', RL: 'Rear L', RR: 'Rear R', Sub: 'Sub', Full: 'Full range' };

const update = (patch: DevicePatch, id: string) => act(() => roomActions.updateDevice(patch, id));
const pct = (v: number) => `${Math.round(v * 100)}%`;

function BatterySaverToggle() {
  const on = useRoomStore((s) => s.engine.batterySaver);
  return <Toggle label="Battery-friendly mode" checked={on} onChange={(v) => act(() => roomActions.setBatterySaver(v))} />;
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
    <Panel
      title="Speakers"
      className="lg:flex-1"
      headerClassName="lg:sr-only"
      actions={<span className="text-xs text-ink-400">{online} online</span>}
    >
      {!canControl && (
        <p className="mb-2 flex items-center gap-2 text-sm text-ink-400">
          <Icon name="lock" className="size-4" /> Host has locked control. You can still adjust your own speaker.
        </p>
      )}
      <ul className="-mx-1">
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
  const canControl = useCanControl();
  const [open, setOpen] = useState(false);
  const isSelf = d.id === selfId;
  const editable = canControl || isSelf;
  const status = syncStatusOf(d, selfId, clock);
  const color = ROLE_COLOR[d.role];
  const tags = [isSelf && 'you', d.isHost && 'host', !d.connected && 'offline'].filter(Boolean).join(' · ');

  return (
    <li data-testid="device-row" data-device-id={d.id} className={d.connected ? undefined : 'opacity-50'}>
      <div className="flex items-center rounded-lg hover:bg-ink-900">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 pl-2 text-left"
        >
          <span
            className={`w-9 shrink-0 font-mono text-xs font-semibold ${flashing ? 'animate-flash' : ''}`}
            style={{ color }}
            title={ROLE_LABEL[d.role]}
          >
            {d.role}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">
            {d.name}
            {tags && <span className="ml-2 text-xs text-ink-500">{tags}</span>}
          </span>
          <StatusDot status={status} label="" />
          <span aria-hidden className={`grid size-4 shrink-0 place-items-center text-ink-500 transition ${open ? 'rotate-90' : ''}`}>
            ›
          </span>
        </button>
        <IconButton
          icon={d.muted ? 'mute' : 'volume'}
          label={d.muted ? `Unmute ${d.name}` : `Mute ${d.name}`}
          pressed={d.muted}
          disabled={!editable}
          onClick={() => update({ muted: !d.muted }, d.id)}
        />
      </div>

      {open && <DeviceDetails d={d} isSelf={isSelf} editable={editable} canRename={isSelf || isHost} />}
    </li>
  );
}

function DeviceDetails({ d, isSelf, editable, canRename }: { d: Device; isSelf: boolean; editable: boolean; canRename: boolean }) {
  const st = d.stats;
  return (
    <div className="space-y-3 px-2 pt-1 pb-4">
      <div className="flex flex-wrap items-center gap-1">
        <NameField d={d} canRename={canRename} />
        <span className="flex-1" />
        <label className="sr-only" htmlFor={`role-${d.id}`}>
          Role for {d.name} ({ROLE_LABEL[d.role]})
        </label>
        <select
          id={`role-${d.id}`}
          value={d.role}
          disabled={!editable}
          onChange={(e) => update({ role: e.target.value as DeviceRole }, d.id)}
          className={`${selectClass} w-20 font-mono`}
          style={{ color: ROLE_COLOR[d.role] }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r} title={ROLE_LABEL[r]}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" className="!min-h-9 !px-2.5" onClick={() => act(() => roomActions.identify(d.id))}>
          <Icon name="wave" className="size-4" /> Beep
        </Button>
        <fieldset disabled={!editable} className="contents">
          <Button variant="ghost" aria-pressed={d.solo} className={`!min-h-9 !px-2.5 ${d.solo ? 'bg-warn/15 text-warn' : ''}`} onClick={() => update({ solo: !d.solo }, d.id)}>
            Solo
          </Button>
          <Button variant="ghost" className="!min-h-9 !px-2.5" onClick={() => act(() => roomActions.applyPresetEq(d.id))}>
            <Icon name="eq" className="size-4" /> Preset EQ
          </Button>
        </fieldset>
      </div>
      <fieldset disabled={!editable} className="grid gap-3">
        <legend className="sr-only">Settings for {d.name}</legend>
        <RangeField label="Balance" min={0} max={1} step={0.01} value={d.volume} format={pct} onCommit={(v) => update({ volume: v }, d.id)} />
        <RangeField label="Trim" min={-24} max={12} step={0.5} value={d.trimDb} format={db} onCommit={(v) => update({ trimDb: v }, d.id)} />
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
        <Toggle
          label={d.eq.source === 'none' ? 'EQ (not measured yet)' : `EQ (${d.eq.bands.length} bands, ${d.eq.source})`}
          checked={d.eq.enabled}
          disabled={!editable}
          onChange={(v) => update({ eq: { ...d.eq, enabled: v } }, d.id)}
        />
        {isSelf && <BatterySaverToggle />}
      </fieldset>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <Stat k="Round trip" v={fmtMs(st?.rttMs)} />
        <Stat k="Clock offset" v={st ? `${fmtSigned(st.offsetMs, 1)} ms` : '—'} />
        <Stat k="Sync error" v={fmtMs(st?.syncErrorMs)} />
        <Stat k="Buffer" v={st?.bufferState ?? '—'} />
        {st?.battery != null && <Stat k="Battery" v={<span className={st.battery < 0.15 ? 'text-bad' : undefined}>{pct(st.battery)}</span>} />}
        <Stat k="Calibrated" v={d.calibratedLatencyMs != null ? `${fmtSigned(d.calibratedLatencyMs, 1)} ms` : 'no'} />
        <Stat k="Type" v={d.caps.deviceClass} />
      </dl>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-ink-500">{k}</dt>
      <dd className="text-right font-mono text-ink-300 tabular">{v}</dd>
    </>
  );
}

function NameField({ d, canRename }: { d: Device; canRename: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing === null) {
    return canRename ? (
      <Button variant="ghost" className="!min-h-9 !px-2.5" aria-label={`Rename ${d.name}`} onClick={() => setEditing(d.name)}>
        <Icon name="edit" className="size-4" /> Rename
      </Button>
    ) : null;
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

/** A guest's own speaker, above the list: role, sync, and the two things they may tune themselves. */
export function SpeakerCard() {
  const self = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.deviceId) ?? null);
  const clock = useRoomStore((s) => s.clock);
  const engine = useRoomStore((s) => s.engine);
  const hostOnly = useRoomStore((s) => !!s.room?.settings.hostOnlyControl);
  if (!self) return null;
  const status = syncStatusOf(self, self.id, clock);
  return (
    <section aria-labelledby="speaker-h" className="space-y-3 border-b border-ink-800 pb-4">
      <div className="flex min-h-11 items-center gap-3">
        <h2 id="speaker-h" className="text-sm font-semibold text-ink-200">
          You&rsquo;re a speaker
        </h2>
        <span className="font-mono text-xs font-semibold" style={{ color: ROLE_COLOR[self.role] }} title={ROLE_LABEL[self.role]}>
          {self.role}
        </span>
        <span className="flex-1" />
        <StatusDot status={status} testid="self-sync-status" />
      </div>
      {!!self.volumeUpDb && (
        <p role="status" data-testid="volume-up-hint" className="text-sm text-warn">
          This speaker is about {Math.round(self.volumeUpDb)} dB quieter. Turn its volume up and tune again.
        </p>
      )}
      {!engine.wakeLock && <p className="text-xs text-ink-400">Keep this screen on and the tab in front.</p>}
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
      <BatterySaverToggle />
      {hostOnly && <p className="text-xs text-ink-400">The host has locked playback and the stage.</p>}
    </section>
  );
}
