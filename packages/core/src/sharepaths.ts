// Paths on the office share, whatever drive letter each person uses.
//
// One person has \\nas01\Project mapped as X:, another as Z:, a third has nothing mapped. A message
// therefore stores a share path in its UNC form (\\server\share\…), which is the same for
// everyone, and each reader sees it with their own drive letter where they have one. Drive-letter
// paths written before this (or on a PC whose map the hub does not know) are translated through
// the writer's published map when it is known.
//
// Everything here is pure string work, shared by the app's main process (opening folders), the
// window (messages and cards) and the hub's tests. Nothing here touches the disk.

/** One drive letter on one PC: X: → \\nas01\Project (or a folder below a share), or a subst drive. */
export interface DriveMapping {
  /** 'X:' (upper case). */
  letter: string;
  /** What the letter points at: a UNC path for a network drive; a drive path for a subst drive. */
  root: string;
  /** Where the PC told us: the registry's persistent mappings, `net use`, `subst`, or a test hook. */
  source?: 'registry' | 'net-use' | 'subst' | 'test';
}

/** A PC's (or a person's) drive map. `known` is false when nobody has told us, so absence means nothing. */
export interface DriveMap {
  known: boolean;
  drives: DriveMapping[];
}

export const EMPTY_DRIVE_MAP: DriveMap = { known: false, drives: [] };

/** A path, normalised: backslashes, drive letter upper case, no \\?\ prefix, no trailing separator. */
export type ParsedPath =
  | { kind: 'unc'; path: string; server: string; share: string; trailing: boolean }
  | { kind: 'drive'; path: string; letter: string; trailing: boolean };

const MAX_PATH = 1024;
/** Characters Windows never allows in a file or folder name (and that end a path in running text). */
const BAD_NAME = /[<>"|?*\u0000-\u001f]/;

const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '«': '»', '<': '>', '`': '`' };

/** Strip one pair of matching quotes around the whole string. */
function unquote(s: string): string {
  const close = QUOTES[s[0]];
  return close && s.length > 1 && s.endsWith(close) ? s.slice(1, -1).trim() : s;
}

/** A file:// URL as a Windows path, or null. file://server/share/… is UNC, file:///X:/… a drive. */
function fromFileUrl(s: string): string | null {
  const m = /^file:(\/\/[^/]*)?(\/.*)?$/i.exec(s);
  if (!m) return null;
  let host = (m[1] ?? '').slice(2);
  let rest = m[2] ?? '';
  try { host = decodeURIComponent(host); rest = decodeURIComponent(rest); } catch { return null; }
  if (host && host.toLowerCase() !== 'localhost') return `\\\\${host}${rest.replace(/\//g, '\\')}`;
  const drive = /^\/([A-Za-z])[:|](\/.*)?$/.exec(rest);
  if (drive) return `${drive[1]}:${(drive[2] ?? '\\').replace(/\//g, '\\')}`;
  // file:////server/share (four slashes) is UNC too
  if (/^\/\/[^/]/.test(rest)) return rest.replace(/\//g, '\\');
  return null;
}

/**
 * Read a path as people paste it: in quotes, as a file:// URL, with forward slashes, as a \\?\UNC\
 * long path, with doubled separators or a trailing one. Returns null for anything that is not a
 * plain share or drive path (device paths, '..', wildcards, control characters).
 */
export function parsePath(raw: string): ParsedPath | null {
  if (typeof raw !== 'string') return null;
  let s = unquote(raw.trim());
  if (!s || s.length > MAX_PATH) return null;
  if (/^file:/i.test(s)) { const p = fromFileUrl(s); if (!p) return null; s = p; }
  s = s.replace(/\//g, '\\');
  // long-path prefixes: \\?\UNC\server\share and \\?\X:\ (\\.\ is a device: never ours)
  if (/^\\\\\?\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (/^\\\\\?\\[A-Za-z]:/.test(s)) s = s.slice(4);
  else if (/^\\\\[?.]\\/.test(s)) return null;
  const unc = /^\\\\[^\\]/.test(s);
  const drive = /^[A-Za-z]:(?:\\|$)/.test(s);
  if (!unc && !drive) return null;
  const body = unc ? s.slice(2) : s.slice(2);
  const trailing = /\\$/.test(body) && body.replace(/\\+$/, '').length > 0;
  const segs = body.split('\\').filter((x) => x !== '' && x !== '.');
  if (segs.some((x) => x === '..' || BAD_NAME.test(x) || /:/.test(x))) return null;
  if (unc) {
    if (segs.length < 2) return null;
    const [server, share] = segs;
    if (!/^[\p{L}\p{N}._$-]{1,253}$/u.test(server) || share.length > 255) return null;
    return { kind: 'unc', path: `\\\\${segs.join('\\')}`, server, share, trailing };
  }
  const letter = `${s[0].toUpperCase()}:`;
  return { kind: 'drive', path: segs.length ? `${letter}\\${segs.join('\\')}` : `${letter}\\`, letter, trailing: segs.length ? trailing : false };
}

/** The path with its trailing separator back, if it had one (folders people wrote as …\). */
export function withTrailing(p: ParsedPath | { path: string; trailing: boolean }, path = p.path): string {
  return p.trailing && !/\\$/.test(path) ? `${path}\\` : path;
}

/** Is `path` the same as or below `root`? Returns the part below ('' when equal, '\…' otherwise). Case-insensitive, by whole segments. */
export function under(path: string, root: string): string | null {
  const r = root.replace(/\\+$/, '');
  if (path.length < r.length) return null;
  if (path.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return null;
  const rest = path.slice(r.length);
  if (rest === '' ) return '';
  return rest[0] === '\\' ? rest.replace(/\\+$/, '') : null;
}

/** Mappings cleaned up: letters upper case, roots parsed, nonsense dropped, one per letter. */
export function cleanMappings(list: unknown): DriveMapping[] {
  if (!Array.isArray(list)) return [];
  const out = new Map<string, DriveMapping>();
  for (const x of list.slice(0, 64)) {
    if (!x || typeof x !== 'object') continue;
    const { letter, root, source } = x as Record<string, unknown>;
    if (typeof letter !== 'string' || typeof root !== 'string') continue;
    const l = /^([A-Za-z]):?\\?$/.exec(letter.trim())?.[1];
    const p = parsePath(root);
    if (!l || !p) continue;
    // a letter that points at itself is not a mapping
    if (p.kind === 'drive' && p.letter === `${l.toUpperCase()}:`) continue;
    const m: DriveMapping = { letter: `${l.toUpperCase()}:`, root: p.path };
    if (source === 'registry' || source === 'net-use' || source === 'subst' || source === 'test') m.source = source;
    out.set(m.letter, m);
  }
  return [...out.values()].sort((a, b) => a.letter.localeCompare(b.letter));
}

/** Only the network part of a map: letters whose root is (or leads to) a share, as UNC. What a PC publishes. */
export function networkRoots(drives: DriveMapping[]): Array<{ letter: string; root: string }> {
  const out: Array<{ letter: string; root: string }> = [];
  for (const d of drives) {
    const unc = toUnc(`${d.letter}\\`, drives);
    if (unc) out.push({ letter: d.letter, root: unc.replace(/\\+$/, '') });
  }
  return out;
}

/**
 * A path in its UNC form through a drive map: X:\P12513 → \\nas01\Project\P12513 when X: is mapped.
 * Follows subst drives (S: → X:\Jobs → \\nas01\Project\Jobs), at most four steps. UNC paths come
 * back as they are; a local drive (C:, or a subst onto one) gives null.
 */
export function toUnc(path: string, drives: DriveMapping[]): string | null {
  let p = parsePath(path);
  for (let i = 0; p && i < 5; i++) {
    if (p.kind === 'unc') return p.path;
    const letter = p.letter;
    const m = drives.find((d) => d.letter === letter);
    if (!m) return null;
    const rest = p.path.slice(3);
    p = parsePath(rest ? `${m.root.replace(/\\+$/, '')}\\${rest}` : m.root);
  }
  return null;
}

/**
 * A UNC path with this PC's drive letter, where it has one: \\nas01\Project\P12513 → X:\P12513.
 * The mapping with the longest root wins (X: → \\nas01\Project and J: → \\nas01\Project\Jobs:
 * \\nas01\Project\Jobs\P1 becomes J:\P1); between equal roots, the first letter.
 */
export function toLocal(unc: string, drives: DriveMapping[]): string | null {
  const p = parsePath(unc);
  if (!p || p.kind !== 'unc') return null;
  let best: { letter: string; root: string; rest: string } | null = null;
  for (const n of networkRoots(drives)) {
    const rest = under(p.path, n.root);
    if (rest === null) continue;
    if (!best || n.root.length > best.root.length || (n.root.length === best.root.length && n.letter < best.letter)) best = { ...n, rest };
  }
  return best ? `${best.letter}${best.rest || '\\'}` : null;
}

// ------------------------------------------------------------------ paths in running text

/** One path found in a message: where it is, what was written, and the path inside any quotes. */
export interface PathSpan { start: number; end: number; raw: string; path: string; quoted: boolean }

// unquoted: a UNC path (\\ or //, with \\?\UNC\ allowed), a drive path (X:\ or X:/) not inside a
// word or a URL, or a file:// URL; each runs to the first space or character Windows forbids
const SEG = String.raw`[^\s\\/<>"|?*` + '`' + ']+';
const PATH_RE = new RegExp(
  [
    String.raw`file://[^\s<>"'` + '`' + ']+',
    String.raw`(?:\\\\\?\\UNC\\|\\\\\?\\(?=[A-Za-z]:)|\\\\|(?<![:\w/])//)` + SEG + String.raw`(?:[\\/]` + SEG + String.raw`)+[\\/]?`,
    String.raw`(?<![A-Za-z0-9_/\\:.@-])[A-Za-z]:[\\/](?:` + SEG + String.raw`[\\/]?)*`,
  ].join('|'),
  'gu',
);
// quoted: "…", “…”, ‘…’, «…» around a path that may have spaces
const QUOTED_RE = /"([^"\n]{3,400})"|“([^”\n]{3,400})”|‘([^’\n]{3,400})’|«([^»\n]{3,400})»/g;
/** Punctuation that ends a sentence, not a path (a file or folder name never ends in a full stop). */
const TRAILING = /[.,;:!?'"’”»)\]}…।॥]/u;
const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function trimEnd(s: string): string {
  let t = s;
  while (t.length > 3) {
    const c = t[t.length - 1];
    if (!TRAILING.test(c)) break;
    // a closing bracket that belongs to the path stays: \\nas01\Jobs\P-12 (Rev B)
    const open = OPENING[c];
    if (open && t.split(open).length - 1 >= t.split(c).length - 1) break;
    t = t.slice(0, -1);
  }
  return t;
}

/** Ranges of code (```blocks``` and `spans`): what people wrote there is left exactly as it is. */
export function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Every share or drive path in a text, left to right, with sentence punctuation left out. */
export function findPaths(text: string, opts: { skipCode?: boolean } = {}): PathSpan[] {
  if (!text || !/[\\/:]/.test(text)) return [];
  const code = opts.skipCode ? codeRanges(text) : [];
  const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x);
  const out: PathSpan[] = [];
  const taken = (a: number, b: number) => out.some((s) => a < s.end && b > s.start);
  for (const m of text.matchAll(QUOTED_RE)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!parsePath(inner) || inCode(m.index, m.index + m[0].length)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0], path: inner, quoted: true });
  }
  for (const m of text.matchAll(PATH_RE)) {
    const raw = trimEnd(m[0]);
    const start = m.index;
    const end = start + raw.length;
    if (taken(start, end) || inCode(start, end) || !parsePath(raw)) continue;
    out.push({ start, end, raw, path: raw, quoted: false });
  }
  return out.sort((a, b) => a.start - b.start);
}

const PATH_AT = new RegExp(PATH_RE.source, 'uy');
const QUOTED_AT = new RegExp(QUOTED_RE.source, 'y');

/** The path that starts exactly at `at` in a text, if one does (for drawing a message piece by piece). */
export function pathAt(text: string, at: number): PathSpan | null {
  const c = text[at];
  if (c === '"' || c === '“' || c === '‘' || c === '«') {
    QUOTED_AT.lastIndex = at;
    const m = QUOTED_AT.exec(text);
    const inner = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
    if (m && parsePath(inner)) return { start: at, end: at + m[0].length, raw: m[0], path: inner, quoted: true };
    return null;
  }
  PATH_AT.lastIndex = at;
  const m = PATH_AT.exec(text);
  if (!m) return null;
  const raw = trimEnd(m[0]);
  return parsePath(raw) ? { start: at, end: at + raw.length, raw, path: raw, quoted: false } : null;
}

/** Could a path start here? A cheap test before pathAt. */
export function mayStartPath(text: string, at: number): boolean {
  const c = text[at];
  if (c === '\\') return text[at + 1] === '\\';
  if (c === '/') return text[at + 1] === '/';
  if (c === '"' || c === '“' || c === '‘' || c === '«') return true;
  if (c === 'f' || c === 'F') return /^file:\/\//i.test(text.slice(at, at + 7));
  return /[A-Za-z]/.test(c ?? '') && text[at + 1] === ':' && (text[at + 2] === '\\' || text[at + 2] === '/');
}

/** Rewrite each path in a text with `fn` (null leaves it). Quotes and file:// form are kept around the new path. */
export function mapPaths(text: string, fn: (p: ParsedPath, span: PathSpan) => string | null, opts: { skipCode?: boolean } = {}): string {
  const spans = findPaths(text, opts);
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const s of spans) {
    const p = parsePath(s.path);
    const next = p ? fn(p, s) : null;
    if (next === null || next === s.path) continue;
    let replaced = next;
    if (/^file:/i.test(s.path)) replaced = toFileUrl(next);
    if (s.quoted) replaced = s.raw.replace(s.path, replaced);
    out += text.slice(at, s.start) + replaced;
    at = s.end;
  }
  return out + text.slice(at);
}

/** A Windows path as a file:// URL (file://server/share/… or file:///X:/…). */
export function toFileUrl(path: string): string {
  const p = parsePath(path);
  if (!p) return path;
  const enc = (segs: string[]) => segs.map((x) => encodeURIComponent(x).replace(/%24/g, '$')).join('/');
  const tail = p.trailing ? '/' : '';
  if (p.kind === 'unc') return `file://${p.server}/${enc(p.path.slice(2).split('\\').slice(1))}${tail}`;
  return `file:///${p.letter}/${enc(p.path.slice(3).split('\\').filter(Boolean))}${tail}`;
}

/**
 * The message as it is stored: drive letters this PC maps to a network share become the share's
 * UNC path, so the message is right for everyone. Local drives (C:\Users\…) and code stay as written.
 */
export function shareableText(text: string, drives: DriveMapping[]): string {
  if (!drives.length) return text;
  return mapPaths(text, (p) => (p.kind === 'drive' ? (() => { const u = toUnc(p.path, drives); return u ? withTrailing(p, u) : null; })() : null), { skipCode: true });
}

/** The other way, for editing a sent message: UNC paths with this PC's drive letters, as the writer typed them. */
export function localText(text: string, drives: DriveMapping[]): string {
  if (!drives.length) return text;
  return mapPaths(text, (p) => (p.kind === 'unc' ? (() => { const l = toLocal(p.path, drives); return l ? withTrailing(p, l) : null; })() : null), { skipCode: true });
}

// ------------------------------------------------------------------ one path, as one reader sees it

/** How one path in a message reads on this PC. */
export interface PathView {
  /** The path as written, normalised. */
  written: string;
  /** Its share path, when known (always for a UNC path; through a drive map for a letter). */
  unc: string | null;
  /** What to show: this PC's drive letter where it has one, else the UNC path, else as written. */
  shown: string;
  /** 'share': on the office share; 'local': on one PC only; 'unknown': a letter nobody could place. */
  scope: 'share' | 'local' | 'unknown';
  /** For 'local': whose PC it is on. */
  owner?: 'me' | 'writer';
  /** How the share path was found: it was written so, through this PC's map, or through the writer's. */
  via: 'written' | 'mine' | 'writer' | null;
  /** A drive letter we could not place: it may be mapped differently on this PC. */
  hint: boolean;
  /** The path to try opening on this PC, or null when it cannot be here. */
  open: string | null;
  /** Written as a folder (…\) or with no file extension. */
  folder: boolean;
}

/** The last segment has an extension: a file. Anything else is taken for a folder. */
export function looksLikeFile(p: ParsedPath): boolean {
  if (p.trailing) return false;
  const last = p.path.split('\\').filter(Boolean).pop() ?? '';
  return /\.[\p{L}\p{N}]{1,8}$/u.test(last) && !/^[A-Za-z]:$/.test(last);
}

/**
 * One path as one reader sees it. `mine` is this PC's map; `writer` the map the hub knows for the
 * person who wrote the message (null or unknown for old messages or other systems).
 */
export function viewPath(raw: string, ctx: { mine: DriveMap; writer: DriveMap | null; writerIsMe: boolean }): PathView | null {
  const p = parsePath(raw);
  if (!p) return null;
  const folder = !looksLikeFile(p);
  const base = { written: withTrailing(p), folder };
  if (p.kind === 'unc') {
    const local = toLocal(p.path, ctx.mine.drives);
    return { ...base, unc: p.path, shown: withTrailing(p, local ?? p.path), scope: 'share', via: 'written', hint: false, open: p.path };
  }
  if (ctx.writerIsMe) {
    const unc = toUnc(p.path, ctx.mine.drives);
    if (unc) return { ...base, unc, shown: withTrailing(p), scope: 'share', via: 'mine', hint: false, open: p.path };
    if (ctx.mine.known) return { ...base, unc: null, shown: withTrailing(p), scope: 'local', owner: 'me', via: null, hint: false, open: p.path };
    return { ...base, unc: null, shown: withTrailing(p), scope: 'unknown', via: null, hint: false, open: p.path };
  }
  const writer = ctx.writer;
  if (writer?.known) {
    const unc = toUnc(p.path, writer.drives);
    if (unc) {
      const local = toLocal(unc, ctx.mine.drives);
      return { ...base, unc, shown: withTrailing(p, local ?? unc), scope: 'share', via: 'writer', hint: false, open: unc };
    }
    return { ...base, unc: null, shown: withTrailing(p), scope: 'local', owner: 'writer', via: null, hint: false, open: null };
  }
  // nobody can place the letter: it is worth trying only where this PC has a drive by that letter
  const here = ctx.mine.drives.some((d) => d.letter === p.letter);
  return { ...base, unc: null, shown: withTrailing(p), scope: 'unknown', via: null, hint: true, open: here ? p.path : null };
}

/** The folder a path is in (for a file), or the path itself (for a folder). */
export function folderOf(path: string, isFolder: boolean): string {
  const p = parsePath(path);
  if (!p) return path;
  if (isFolder) return p.path;
  const i = p.path.lastIndexOf('\\');
  const parent = p.path.slice(0, i);
  return p.kind === 'drive' && parent.length === 2 ? `${parent}\\` : parent;
}

/** The ways to reach a path on this PC, best first: as given, its UNC form, its drive-letter form. */
export function candidates(path: string, drives: DriveMapping[]): string[] {
  const p = parsePath(path);
  if (!p) return [];
  const out = [p.path];
  const unc = toUnc(p.path, drives);
  if (unc) out.push(unc);
  const local = unc ? toLocal(unc, drives) : null;
  if (local) out.push(local);
  return [...new Set(out)];
}
