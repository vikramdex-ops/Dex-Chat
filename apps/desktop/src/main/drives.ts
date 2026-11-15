// This PC's drive letters, for share paths in messages (see packages/core/src/sharepaths.ts).
//
// Windows only. Three small programs, no PowerShell (which takes a second or more to start, and
// may be blocked by policy) and no native modules:
// - `reg query HKCU\Network /s /v RemotePath`: the persistent mappings ("Reconnect at sign-in");
// - `net use`: the connections there are now, including ones made for this session only;
// - `subst`: letters that stand for a folder (onto a local folder they stay local; onto a mapped
//   drive or a share they lead to the share).
// `net use` wins when it and the registry disagree (it is what the PC uses right now). Its header,
// status words and closing line are translated on non-English Windows, so only the shape of a
// line is read: a drive letter followed by a \\server\share path. The registry's key names and
// value types are the same in every language.
//
// DFS: a letter mapped to a namespace (\\dexterity.local\dfs\Project) keeps the namespace path,
// which is the same on every PC; it is never resolved to whichever server answers today. Two
// people mapping the same folder once through DFS and once through its server see two different
// roots, so their letters are not swapped for each other.
//
// macOS and Linux have no drive letters; mounted SMB shares (/Volumes/…, /mnt/…) are not read:
// share paths are shown in their UNC form there, and Open folder stays a Windows thing.
//
// The map is read when the app starts, when its window gains focus (at most once a minute) and
// when Preferences asks (Refresh). Paths are checked for access the same way: cached for a minute,
// never more than about two seconds, off the window's thread.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { candidates, cleanMappings, looksLikeFile, parsePath, toUnc } from '@dex/core/sharepaths';
import type { DriveMap, DriveMapping } from '@dex/core/sharepaths';
import { windowsFolderPath } from './folders.ts';

const TTL = 60_000;

// ------------------------------------------------------------------ reading what Windows prints

/** `reg query HKCU\Network /s /v RemotePath`: a key line per letter, then its RemotePath value. */
export function parseRegNetwork(out: string): DriveMapping[] {
  const list: DriveMapping[] = [];
  let letter: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const key = /^HKEY_CURRENT_USER\\Network\\([A-Za-z])\s*$/i.exec(line.trim()) ?? /^HKCU\\Network\\([A-Za-z])\s*$/i.exec(line.trim());
    if (key) { letter = key[1].toUpperCase(); continue; }
    const value = /^\s+RemotePath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (value && letter) { list.push({ letter: `${letter}:`, root: value[1], source: 'registry' }); letter = null; }
  }
  return cleanMappings(list).map((m) => ({ ...m, source: 'registry' as const }));
}

/**
 * `net use`: a line per connection, in columns that are translated and may wrap (a long remote
 * name pushes the network name onto the next line). Only lines with a drive letter and a UNC path
 * count; connections without a letter (\\nas01\IPC$) are not drives.
 */
export function parseNetUse(out: string): DriveMapping[] {
  const list: DriveMapping[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /(?:^|\s)([A-Za-z]):\s+(\\\\[^\s\\]+\\\S.*?)(?:\s{2,}|\s*$)/.exec(line);
    if (m) list.push({ letter: `${m[1].toUpperCase()}:`, root: m[2], source: 'net-use' });
  }
  return cleanMappings(list).map((m) => ({ ...m, source: 'net-use' as const }));
}

/** `subst`: "S:\: => C:\Work\Jobs", or "T:\: => UNC\nas01\Project\Jobs" for a share. */
export function parseSubst(out: string): DriveMapping[] {
  const list: DriveMapping[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]):\\?:?\s*=>\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const target = /^UNC\\/i.test(m[2]) ? `\\\\${m[2].slice(4)}` : m[2];
    list.push({ letter: `${m[1].toUpperCase()}:`, root: target, source: 'subst' });
  }
  return cleanMappings(list).map((m) => ({ ...m, source: 'subst' as const }));
}

/** The three together: subst and `net use` over the registry, one mapping per letter. */
export function mergeMappings(reg: DriveMapping[], netUse: DriveMapping[], subst: DriveMapping[]): DriveMapping[] {
  const by = new Map<string, DriveMapping>();
  for (const m of [...reg, ...netUse, ...subst]) by.set(m.letter, m);
  return [...by.values()].sort((a, b) => a.letter.localeCompare(b.letter));
}

type Run = (file: string, args: string[]) => Promise<string>;

/** Console programs print in the console's code page: ask for UTF-8 so share names in Hindi or Tamil arrive intact. */
const runCmd: Run = (file, args) => new Promise((resolve) => {
  const comspec = process.env.ComSpec || 'cmd.exe';
  execFile(comspec, ['/d', '/c', `chcp 65001 >nul & ${file} ${args.join(' ')}`], { timeout: 4000, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' },
    (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''));
});

/** Read this Windows PC's drive map (each program may fail on its own; what the others say still counts). */
export async function readWindowsDrives(run: Run = runCmd): Promise<DriveMapping[]> {
  const [reg, use, subst] = await Promise.all([
    run('reg', ['query', 'HKCU\\Network', '/s', '/v', 'RemotePath']).catch(() => ''),
    run('net', ['use']).catch(() => ''),
    run('subst', []).catch(() => ''),
  ]);
  return mergeMappings(parseRegNetwork(reg), parseNetUse(use), parseSubst(subst));
}

// ------------------------------------------------------------------ the test hook (development builds only)

/**
 * TEST ONLY. DEXCONNECT_TEST_DRIVES (honoured only in an unpackaged, development build, and only
 * when set) gives a fake drive map: inline JSON, or the path of a JSON file read on every
 * refresh: { "drives": [{ "letter": "X:", "root": "\\\\nas01\\Project" }],
 *            "access": { "\\\\nas01\\Project\\HR": "denied" } }.
 * Under it, paths count as reachable unless "access" says otherwise (by prefix), and Explorer is
 * never started: what would have been opened is recorded in globalThis.__dexTestShell.
 */
export interface TestHook { drives: DriveMapping[]; access: Record<string, AccessState> }

export function readTestHook(value: string | undefined, packaged: boolean): TestHook | null {
  if (packaged || !value) return null;
  try {
    const text = value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8');
    const j = JSON.parse(text) as { drives?: unknown; access?: Record<string, unknown> };
    const access: Record<string, AccessState> = {};
    for (const [k, v] of Object.entries(j.access ?? {})) if (v === 'ok' || v === 'denied' || v === 'missing' || v === 'offline') access[k] = v;
    return { drives: cleanMappings(j.drives).map((m) => ({ ...m, source: 'test' as const })), access };
  } catch { return { drives: [], access: {} }; }
}

// ------------------------------------------------------------------ the service

export type AccessState = 'ok' | 'denied' | 'missing' | 'offline' | 'unknown';

export interface DriveDeps {
  platform: NodeJS.Platform;
  /** TEST ONLY: see readTestHook. Read again on every refresh. */
  testHook?: () => TestHook | null;
  read?: () => Promise<DriveMapping[]>;
  stat?: (p: string) => Promise<fs.Stats>;
  reach?: (host: string) => Promise<boolean>;
  open?: (p: string) => Promise<string>;
  now?: () => number;
}

/** Is a file server answering on the file-sharing port? 0.8 s, like Explorer's own quick check. */
function reachable(host: string, ms = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: 445 });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** Kinds of files Open starts in their own program from a message; programs and scripts never are. */
const OPENABLE = new Set(['dwg', 'dxf', 'dgn', 'pdf', 'xlsx', 'xls', 'xlsm', 'csv', 'docx', 'doc', 'pptx', 'txt', 'pcf', 'idf', 'nwd', 'nwc', 'nwf', 'rvt',
  'ifc', 'step', 'stp', 'iges', 'igs', 'sat', 'e3d', 'rvm', 'zip', '7z', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'msg', 'eml', 'mpp', 'xer', 'json', 'xml', 'md', 'log']);

export class Drives {
  private map: DriveMap = { known: false, drives: [] };
  private at = 0;
  private inflight: Promise<DriveMap> | null = null;
  private readonly access = new Map<string, { state: AccessState; at: number }>();
  private readonly hosts = new Map<string, { ok: boolean; at: number }>();
  private readonly listeners = new Set<(m: DriveMap) => void>();
  private readonly deps: DriveDeps;
  /** TEST ONLY: what Open and Open folder would have handed to Explorer. */
  readonly testShell: Array<{ kind: 'folder' | 'file'; path: string }> = [];

  constructor(deps: DriveDeps) { this.deps = deps; }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private hook(): TestHook | null { return this.deps.testHook?.() ?? null; }
  /** Drive letters mean something here: Windows, or a test pretending to be one. */
  get applies(): boolean { return this.deps.platform === 'win32' || !!this.hook(); }

  onChange(cb: (m: DriveMap) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  current(): DriveMap { return this.map; }

  /** The map, read again when it is older than a minute (or when `force`). */
  get(force = false): Promise<DriveMap> {
    if (!force && this.at && this.now() - this.at < TTL) return Promise.resolve(this.map);
    this.inflight ??= (async () => {
      const hook = this.hook();
      let drives: DriveMapping[] = [];
      let known = false;
      if (hook) { drives = hook.drives; known = true; } else if (this.deps.platform === 'win32') {
        try { drives = await (this.deps.read ?? readWindowsDrives)(); known = true; } catch { known = false; }
      }
      const next: DriveMap = { known, drives };
      const changed = JSON.stringify(next) !== JSON.stringify(this.map);
      this.map = next;
      this.at = this.now();
      if (changed) { this.access.clear(); for (const l of this.listeners) l(next); }
      return next;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Can this person reach the path from here? Fast, cached for a minute; 'unknown' where drive letters do not apply. */
  async check(raw: unknown): Promise<AccessState> {
    const p = typeof raw === 'string' ? parsePath(raw) : null;
    if (!p) return 'unknown';
    const hook = this.hook();
    if (!this.applies) return 'unknown';
    const map = await this.get();
    const key = p.path.toLowerCase();
    const hit = this.access.get(key);
    if (hit && this.now() - hit.at < TTL) return hit.state;
    let state: AccessState;
    if (hook) {
      const unc = toUnc(p.path, map.drives) ?? p.path;
      const rule = Object.entries(hook.access).filter(([k]) => [p.path, unc].some((x) => x.toLowerCase().startsWith(k.toLowerCase()))).sort((a, b) => b[0].length - a[0].length)[0];
      state = rule ? rule[1] : 'ok';
    } else state = await this.probe(p.path, map);
    this.access.set(key, { state, at: this.now() });
    if (this.access.size > 500) this.access.delete(this.access.keys().next().value!);
    return state;
  }

  private async probe(p: string, map: DriveMap): Promise<AccessState> {
    const unc = toUnc(p, map.drives);
    const server = unc ? /^\\\\([^\\]+)/.exec(unc)?.[1] : null;
    if (server) {
      const h = this.hosts.get(server.toLowerCase());
      let ok = h && this.now() - h.at < TTL ? h.ok : undefined;
      if (ok === undefined) { ok = await (this.deps.reach ?? reachable)(server); this.hosts.set(server.toLowerCase(), { ok, at: this.now() }); }
      if (!ok) return 'offline';
    }
    const stat = this.deps.stat ?? ((x: string) => fs.promises.stat(x));
    const tryOne = async (x: string): Promise<AccessState> => {
      try { await stat(x); return 'ok'; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') return 'denied';
        if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
        return server ? 'offline' : 'missing';
      }
    };
    let last: AccessState = 'missing';
    for (const c of candidates(p, map.drives)) {
      last = await withTimeout(tryOne(c), 2000, 'offline' as AccessState);
      if (last === 'ok' || last === 'denied') return last;
    }
    return last;
  }

  /** The first way to reach the path that works here (as given, through the share, through this PC's letter). */
  private async reach(raw: unknown, want: 'folder' | 'file'): Promise<string> {
    const p = typeof raw === 'string' ? parsePath(raw) : null;
    if (!p) throw new Error('Only paths on the office share (\\\\server\\share) or a drive (D:\\) can be opened.');
    if (want === 'file') {
      const ext = /\.([\p{L}\p{N}]{1,8})$/u.exec(p.path)?.[1]?.toLowerCase() ?? '';
      if (!looksLikeFile(p) || !OPENABLE.has(ext)) throw new Error('Files of this kind are not opened from a message. Open its folder instead.');
    }
    const hook = this.hook();
    if (!this.applies) throw new Error('Folders on the office share open on Windows PCs.');
    const map = await this.get();
    if (hook) {
      const state = await this.check(p.path);
      if (state === 'denied') throw new Error("You don't have access to this on the office share.");
      if (state === 'offline') throw new Error("The file server isn't reachable from here.");
      if (state === 'missing') throw new Error('That cannot be found from this PC.');
      const via = candidates(p.path, map.drives)[0] ?? p.path;
      this.testShell.push({ kind: want, path: via });
      return via;
    }
    const stat = this.deps.stat ?? ((x: string) => fs.promises.stat(x));
    let denied = false;
    for (const any of candidates(p.path, map.drives)) {
      // the same plain-path check as ever (no device paths, wildcards or '..'), whatever form works
      const c = windowsFolderPath(any);
      if (!c) continue;
      const st = await withTimeout(stat(c).catch((e: NodeJS.ErrnoException) => { if (e.code === 'EACCES' || e.code === 'EPERM') denied = true; return null; }), 3000, null);
      if (!st) continue;
      if (want === 'folder' && !st.isDirectory()) throw new Error('That is a file, not a folder. Open it from the folder instead.');
      if (want === 'file' && !st.isFile()) throw new Error('That is a folder. Use Open folder.');
      return c;
    }
    throw new Error(denied ? "You don't have access to this on the office share." : 'That cannot be found from this PC. Check that you can reach the share.');
  }

  /** Open folder: in Explorer, through whichever form of the path works here. */
  async openFolder(raw: unknown): Promise<void> {
    const p = await this.reach(raw, 'folder');
    if (this.hook()) return;
    const err = await (this.deps.open ?? (async () => ''))(p);
    if (err) throw new Error(err);
  }

  /** Open: a drawing, sheet or document in its own program (never a program or script). */
  async openFile(raw: unknown): Promise<void> {
    const p = await this.reach(raw, 'file');
    if (this.hook()) return;
    const err = await (this.deps.open ?? (async () => ''))(p);
    if (err) throw new Error(err);
  }
}
