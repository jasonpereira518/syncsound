/**
 * Persistent Home client (no accounts): the home id is a shareable capability link; the owner key, kept in this
 * browser, allows changes and doubles as the host key for every room in the home.
 */
import {
  HomeCreateResponse,
  HomeRoom,
  HomeView,
  OWNER_KEY_HEADER,
} from '@syncsound/protocol';
import { serverUrl } from './config';
import { hostKeyName, readError } from './roomClient';

const HOME_KEY = 'syncsound:home';

export interface SavedHome {
  homeId: string;
  ownerKey?: string;
}

export function savedHome(): SavedHome | null {
  try {
    const raw = localStorage.getItem(HOME_KEY);
    return raw ? (JSON.parse(raw) as SavedHome) : null;
  } catch {
    return null;
  }
}

function saveHome(h: SavedHome) {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(h));
  } catch {
    /* storage blocked: the link still works, this browser just won't remember it */
  }
}

/** remember a home opened by link (keeps the owner key if this browser created it) */
export function rememberHome(homeId: string) {
  const cur = savedHome();
  if (cur?.homeId !== homeId) saveHome({ homeId });
}

export const ownerKeyFor = (homeId: string) => {
  const h = savedHome();
  return h?.homeId === homeId ? h.ownerKey : undefined;
};

/** the owner joins every room in the home as host */
export function claimRooms(homeId: string, roomIds: string[]) {
  const key = ownerKeyFor(homeId);
  if (!key) return;
  try {
    for (const id of roomIds) localStorage.setItem(hostKeyName(id), key);
  } catch {
    /* storage blocked */
  }
}

async function call<T>(path: string, init: RequestInit, parse: (x: unknown) => T, ownerKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/api/homes${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(ownerKey ? { [OWNER_KEY_HEADER]: ownerKey } : {}) },
    });
  } catch {
    throw new Error("Can't reach the SyncSound server. Check that it is running and on the same network.");
  }
  if (res.status === 404) throw new Error('This home no longer exists.');
  if (!res.ok) throw new Error(await readError(res));
  return res.status === 204 ? (undefined as T) : parse(await res.json());
}

export async function createHome(): Promise<string> {
  const r = await call('', { method: 'POST' }, (x) => HomeCreateResponse.parse(x));
  saveHome({ homeId: r.homeId, ownerKey: r.ownerKey });
  return r.homeId;
}

export const getHome = (homeId: string) => call(`/${encodeURIComponent(homeId)}`, { method: 'GET' }, (x) => HomeView.parse(x));

export async function addRoom(homeId: string, name: string): Promise<HomeRoom> {
  const room = await call(
    `/${encodeURIComponent(homeId)}/rooms`,
    { method: 'POST', body: JSON.stringify({ name }) },
    (x) => HomeRoom.parse(x),
    ownerKeyFor(homeId),
  );
  claimRooms(homeId, [room.id]);
  return room;
}

export const renameRoom = (homeId: string, roomId: string, name: string) =>
  call(`/${encodeURIComponent(homeId)}/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify({ name }) }, (x) => HomeRoom.parse(x), ownerKeyFor(homeId));

export const removeRoom = (homeId: string, roomId: string) =>
  call(`/${encodeURIComponent(homeId)}/rooms/${roomId}`, { method: 'DELETE' }, () => undefined, ownerKeyFor(homeId));
