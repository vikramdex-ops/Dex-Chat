// Share paths in the window: this PC's drive letters (from the main process), the drive maps of
// the people who wrote messages (from the hub, for older drive-letter paths), and how one path in
// one message reads here (packages/core/src/sharepaths.ts does the string work).
//
// Messages store share paths as UNC (\\nas01\Project\…): sending turns this PC's mapped letters
// into their UNC form, and every reader sees them with their own letter. The writer therefore
// still sees what they typed. This PC publishes its network roots (letter → UNC, nothing else)
// to the hub when it is signed in, so other PCs can read the drive-letter paths it wrote before.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { EMPTY_DRIVE_MAP, cleanMappings, localText, networkRoots, shareableText, viewPath } from '@dex/core/sharepaths';
import type { DriveMap, PathView } from '@dex/core/sharepaths';

let mine: DriveMap = EMPTY_DRIVE_MAP;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function take(m: DriveMap): void {
  const next: DriveMap = { known: !!m?.known, drives: cleanMappings(m?.drives) };
  if (JSON.stringify(next) === JSON.stringify(mine)) return;
  mine = next;
  access.clear();
  changed();
  void publish();
}

/** This PC's drive map (empty and unknown off Windows). */
export const myDrives = (): DriveMap => mine;

/** Read the map again now (Preferences → Refresh). */
export async function refreshDrives(): Promise<DriveMap> {
  if (!window.dex?.driveMap) return mine;
  take(await window.dex.driveMap(true));
  return mine;
}

// ------------------------------------------------------------------ publishing this PC's map
let signedIn: { hub: string; role: string } | null = null;
let published = '';
async function publish(): Promise<void> {
  if (!signedIn || !mine.known || signedIn.role === 'guest' || signedIn.role === 'bot') return;
  const drives = networkRoots(mine.drives);
  const key = `${signedIn.hub}|${JSON.stringify(drives)}`;
  if (key === published) return;
  published = key;
  try { await window.dex.request('links.drives.set', { drives }); } catch { published = ''; }
}

if (typeof window !== 'undefined' && window.dex) {
  void window.dex.driveMap?.().then(take).catch(() => {});
  window.dex.onDriveMap?.(take);
  const onState = (s: { phase?: string; session?: { hub: { id: string }; me: { role: string } } | null }) => {
    const now = s?.phase === 'ready' && s.session ? { hub: s.session.hub.id, role: s.session.me.role } : null;
    const was = signedIn;
    signedIn = now;
    // a new connection (or another office) gets the map again
    if (now && (!was || was.hub !== now.hub)) { published = ''; writers.clear(); void publish(); }
  };
  void window.dex.getState?.().then(onState).catch(() => {});
  window.dex.onState?.(onState as never);
}

// ------------------------------------------------------------------ writers' maps (older messages)
const WRITER_TTL = 10 * 60_000;
const writers = new Map<string, { map: DriveMap; at: number }>();
const wanted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function fetchWriters(): void {
  timer = null;
  const ids = [...wanted].slice(0, 100);
  for (const id of ids) wanted.delete(id);
  if (!ids.length) return;
  // not signed in yet: ask once we are
  if (!signedIn) { for (const id of ids) wanted.add(id); timer = setTimeout(fetchWriters, 1000); return; }
  // guests are never told the office's share roots
  if (signedIn.role === 'guest') { for (const id of ids) writers.set(id, { map: EMPTY_DRIVE_MAP, at: Date.now() }); changed(); return; }
  void window.dex.request('links.drives.of', { userIds: ids }).then((res) => {
    for (const id of ids) {
      const r = res[id];
      writers.set(id, { map: r ? { known: r.known, drives: cleanMappings(r.drives) } : EMPTY_DRIVE_MAP, at: Date.now() });
    }
    changed();
  }).catch(() => { for (const id of ids) writers.set(id, { map: EMPTY_DRIVE_MAP, at: Date.now() - WRITER_TTL + 60_000 }); changed(); });
  if (wanted.size) timer = setTimeout(fetchWriters, 50);
}

/** The writer's map, if the hub has told us (asked for in batches, kept ten minutes); null while asking. */
function writerMap(userId: string): DriveMap | null {
  const hit = writers.get(userId);
  if (hit && Date.now() - hit.at < WRITER_TTL) return hit.map;
  if (!wanted.has(userId)) { wanted.add(userId); timer ??= setTimeout(fetchWriters, 30); }
  return hit?.map ?? null;
}

// ------------------------------------------------------------------ one path, here

/** How a path written by `authorId` reads on this PC. Only drive-letter paths by someone else ask the hub for their map. */
export function pathView(raw: string, authorId: string | undefined, meId: string): PathView | null {
  const writerIsMe = !!authorId && authorId === meId;
  const needsWriter = !writerIsMe && !!authorId && /^\s*["'“‘«]?(?:file:\/\/\/)?[A-Za-z]:/i.test(raw);
  return viewPath(raw, { mine, writer: needsWriter ? writerMap(authorId) : null, writerIsMe });
}

/** pathView, drawn again when this PC's map or the writer's map arrives. */
export function usePathView(raw: string, authorId: string | undefined, meId: string): PathView | null {
  useSyncExternalStore(subscribe, () => version);
  return pathView(raw, authorId, meId);
}

/** This PC's map, for Preferences. */
export function useMyDrives(): DriveMap {
  useSyncExternalStore(subscribe, () => version);
  return mine;
}

/** The text as it is stored: mapped letters become UNC (see shareableText). */
export const toShareable = (text: string): string => shareableText(text, mine.drives);
/** The text as this PC shows it: UNC paths with this PC's letters (editing a sent message). */
export const toLocalText = (text: string): string => localText(text, mine.drives);

/** Words for share paths drawn inside message text (format.tsx draws with the plain runtime and calls tr() itself). */
export const PATH_WORDS = {
  maybe: 'This drive letter may be mapped differently on your PC',
  maybeShort: '(may be mapped differently on your PC)',
  mine: 'Only on this PC',
  theirs: "Only on the writer's PC",
};

// ------------------------------------------------------------------ "no access", quietly
export type Access = 'ok' | 'denied' | 'missing' | 'offline' | 'unknown';
const access = new Map<string, { state: Access; at: number }>();
const ACCESS_TTL = 60_000;

/** Whether this person can reach the path from here: asked once the card is on screen, cached a minute, never in the way. */
export function usePathAccess(path: string | null, on: boolean): Access | null {
  const key = path?.toLowerCase() ?? '';
  const hit = key ? access.get(key) : undefined;
  const fresh = hit && Date.now() - hit.at < ACCESS_TTL ? hit.state : null;
  const [state, setState] = useState<Access | null>(fresh);
  useEffect(() => {
    if (!on || !path || !window.dex?.checkPath) return;
    const h = access.get(key);
    if (h && Date.now() - h.at < ACCESS_TTL) { setState(h.state); return; }
    let live = true;
    void window.dex.checkPath(path).then((s) => {
      access.set(key, { state: s, at: Date.now() });
      if (access.size > 500) access.delete(access.keys().next().value!);
      if (live) setState(s);
    }).catch(() => { if (live) setState('unknown'); });
    return () => { live = false; };
  }, [key, on, path]);
  return state;
}
