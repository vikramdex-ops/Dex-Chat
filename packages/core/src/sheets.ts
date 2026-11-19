// Dexterity Sheets, read from the hub: the Sheets server's read API (HTTP JSON on TCP 47812 of
// the Sheets server, found by the UDP question DEXSHEETS?1 to port 47811 or typed as an address),
// the questions Nib answers from it ("what's assigned to me in Sheets?", "any mentions for me?",
// "who's in <book>?") and the workbook links its answers carry. The hub's side is
// apps/hub/src/sheets.ts; the contract is in docs/INTEGRATIONS.md (Dexterity Sheets).

export const SHEETS_API_PORT = 47812;
export const SHEETS_DISCOVERY_PORT = 47811;
export const SHEETS_DISCOVERY_QUESTION = 'DEXSHEETS?1';

/** GET /api/v1/people/{user}/assigned */
export interface SheetsAssigned { book: string; sheet: string; cell: string; title: string; status: string; due: string | null; link: string }
/** GET /api/v1/people/{user}/mentions?since= */
export interface SheetsMention { book: string; sheet: string; cell: string; from: string; text: string; at: string; link: string }
/** GET /api/v1/books */
export interface SheetsBook {
  id: string; name: string; sharer: string; online: string[];
  /** Not in the contract yet: a dexterity://open link to the book, used when the server sends one. */
  link?: string | null;
}
/** A Sheets server that answered the discovery question. */
export interface SheetsFound { name: string; address: string; version: string; url: string }

export interface SheetsTestResult { ok: boolean; name: string | null; version: string | null; error: string | null; at: number }

/** Control room → Integrations. The token is never sent back once saved. */
export interface SheetsAdminView {
  url: string | null;
  hasToken: boolean;
  configured: boolean;
  lastTest: SheetsTestResult | null;
  /** People who asked for the morning list of their open Sheets items. */
  digestPeople: number;
}

// ---------------------------------------------------------------- addresses
/** "PC-SERVER", "10.0.0.5:47812" or "http://pc-server:47812/" as the read API's base URL; null when it is not an address. */
export function sheetsBaseUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return `${u.protocol}//${u.hostname}:${u.port || SHEETS_API_PORT}`;
}

// ---------------------------------------------------------------- workbook links
/** "Line List!B4", "'Line List'!B4" or "B4": the sheet and the cell. */
export function splitAt(at: string): { sheet: string | null; cell: string } | null {
  const s = at.trim();
  if (!s) return null;
  const bang = s.lastIndexOf('!');
  if (bang < 0) return { sheet: null, cell: s };
  let sheet = s.slice(0, bang).trim();
  if (/^'.*'$/.test(sheet)) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const cell = s.slice(bang + 1).trim();
  return { sheet: sheet || null, cell };
}

export interface WorkbookLink { server: string; book: string; at: string | null; sheet: string | null; cell: string | null }

/** dexterity://open/<server>/<book>?at=<Sheet>!<Cell>, read. Null for anything else. */
export function parseWorkbookLink(link: string): WorkbookLink | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'dexterity:') return null;
  const segs = `${u.host}${u.pathname}`.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (segs[0] !== 'open' || !segs[1] || !segs[2]) return null;
  const at = u.searchParams.get('at');
  const where = at ? splitAt(at) : null;
  return { server: segs[1], book: segs.slice(2).join('/'), at: at || null, sheet: where?.sheet ?? null, cell: where?.cell ?? null };
}

/**
 * A dexterity://open link made safe to write in a message: characters that end a link in text
 * (spaces, quotes, brackets) are percent-encoded, so the whole link, `?at=` included, is found
 * and opened. Null for anything that is not a workbook link.
 */
export function safeWorkbookLink(link: unknown): string | null {
  if (typeof link !== 'string' || link.length > 2000 || !/^dexterity:\/\/open\//i.test(link.trim())) return null;
  const s = link.trim().replace(/[\s'"()<>[\]`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return parseWorkbookLink(s) ? s : null;
}

/** Words for a Markdown link label (no brackets or emphasis marks). */
const label = (s: string, max = 80): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[[\]()*_`~<>|\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** A book's id as people say it ("line-list-100-3f2a" → "Line list 100"). */
export function bookName(book: string): string {
  const name = book.replace(/\.(?:dxs|xlsx?|csv)$/i, '').replace(/-[0-9a-f]{4,8}$/i, '').replace(/[-_]+/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : book;
}

/** "[Line list 100 · Line List!B4](dexterity://…)", or the words alone when the link is not a workbook link. */
export function workbookMarkdown(book: string, sheet: string | null, cell: string | null, link: unknown): string {
  const where = [sheet, cell].filter(Boolean).join('!');
  const text = label([book, where].filter(Boolean).join(' · ')) || 'Workbook';
  const url = safeWorkbookLink(link);
  return url ? `[${text}](${url})` : `**${text}**`;
}

// ---------------------------------------------------------------- what Nib is asked
export type SheetsAsk =
  | { kind: 'assigned' }
  | { kind: 'mentions' }
  /** named: the words said Sheets or workbook; otherwise only a book with that name makes it a Sheets question. */
  | { kind: 'who'; book: string; named: boolean }
  | { kind: 'digest'; on: boolean };

const SHEETS_WORD = /\b(?:dexterity sheets|in sheets|on sheets|from sheets|sheets'?s?|workbooks?|spreadsheets?)\b/i;
const QUESTION_START = /^(?:what(?:'s|’s| is| are)?|whats|which|show(?: me)?|list|any|anything|do i have|have i got|have i|got any|check|tell me|my)\b/i;
const OFFICE_PLACES = /^(?:today|tomorrow|now|here|the office|office|site|the site|at site|on leave|leave|the building|around|office today)$/i;

/**
 * A question for Dexterity Sheets, or null. Only whole questions count, so work notes such as
 * "got 12 sheets assigned from Meera" or "Meera mentioned the GA" stay day-sheet lines.
 */
export function sheetsAsk(input: string): SheetsAsk | null {
  const t = String(input ?? '').trim().slice(0, 300);
  if (!t) return null;
  // the morning list: "sheets digest on", "send me my Sheets items every morning", "stop the Sheets digest"
  if (SHEETS_WORD.test(t)) {
    if (/\b(?:digest|every morning|each morning|morning list|mornings)\b/i.test(t)) {
      if (/\b(?:off|stop|no more|don'?t|do not|cancel|turn off|unsubscribe)\b/i.test(t)) return { kind: 'digest', on: false };
      if (/\b(?:on|start|send|yes|turn on|subscribe|please|want)\b/i.test(t)) return { kind: 'digest', on: true };
    }
  }
  if (/\bassign(?:ed|ments?)?\b/i.test(t) && SHEETS_WORD.test(t) && (QUESTION_START.test(t) || /\?\s*$/.test(t))) return { kind: 'assigned' };
  if (/\bmention(?:s|ed)?\b/i.test(t) && (QUESTION_START.test(t) || /^(?:mentions?|sheets mentions?)\??$/i.test(t))) return { kind: 'mentions' };
  const who = /^(?:who(?:'s|’s| is| are|s)?|who all(?: are| is)?)\s+(?:in|on|editing|working (?:in|on)|online in|looking at|inside)\s+(.+?)\s*\??$/i.exec(t);
  if (who) {
    const named = SHEETS_WORD.test(who[1]) || /^(?:the\s+)?["“'‘].+["”'’]/.test(who[1].trim());
    const book = cleanBook(who[1]);
    if (book && !OFFICE_PLACES.test(book)) return { kind: 'who', book, named };
  }
  return null;
}
function cleanBook(s: string): string {
  return s.replace(/\s*\?+\s*$/, '').replace(/\b(?:in|on)\s+(?:dexterity\s+)?sheets\b/gi, '').replace(/\b(?:the\s+)?(?:workbook|spreadsheet|book)\b/gi, '')
    .replace(/^(?:the\s+)/i, '').replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** A book matching what someone called it: exact name or id first, then a name containing the words. */
export function matchBook<T extends Pick<SheetsBook, 'id' | 'name'>>(books: T[], said: string): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/\.(?:dxs|xlsx?|csv)$/i, '').replace(/[-_\s]+/g, ' ').trim();
  const q = norm(said);
  if (!q) return null;
  return books.find((b) => norm(b.name) === q || norm(b.id) === q || norm(bookName(b.id)) === q)
    ?? books.find((b) => norm(b.name).includes(q) || norm(bookName(b.id)).includes(q))
    ?? null;
}

// ---------------------------------------------------------------- Nib's answers
/** Statuses that mean the item needs nothing more from the person. */
export const SHEETS_CLOSED = /^(?:done|closed|complete|completed|resolved|finished|cancel(?:l)?ed|n\/?a)$/i;
export const isOpenItem = (x: Pick<SheetsAssigned, 'status'>): boolean => !SHEETS_CLOSED.test(String(x.status ?? '').trim());

const MAX_LINES = 12;
const dueWords = (due: string | null, today: string): string => {
  if (!due) return '';
  const d = /^\d{4}-\d{2}-\d{2}/.exec(due)?.[0];
  if (!d) return `due ${label(due, 20)}`;
  const when = new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d < today ? `overdue since ${when}` : d === today ? 'due today' : `due ${when}`;
};

/** The open items assigned to someone, as Nib's Markdown answer. */
export function assignedAnswer(items: SheetsAssigned[], today: string, opts: { digest?: boolean; digestOn?: boolean } = {}): string {
  const open = items.filter(isOpenItem).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  const closed = items.length - open.length;
  if (!open.length) return closed ? `Nothing open is assigned to you in Dexterity Sheets (${closed} done).` : 'Nothing is assigned to you in Dexterity Sheets.';
  const head = opts.digest
    ? `Good morning. ${open.length === 1 ? 'One open item is' : `${open.length} open items are`} assigned to you in Dexterity Sheets:`
    : `${open.length === 1 ? 'One open item is' : `${open.length} open items are`} assigned to you in Dexterity Sheets:`;
  const lines = open.slice(0, MAX_LINES).map((x) => {
    const bits = [label(x.title ?? '', 120), x.status ? label(x.status, 30) : '', dueWords(x.due, today)].filter(Boolean).join(' · ');
    return `- ${workbookMarkdown(label(x.book ?? '') || 'Workbook', x.sheet || null, x.cell || null, x.link)}${bits ? ` — ${bits}` : ''}`;
  });
  if (open.length > MAX_LINES) lines.push(`- …and ${open.length - MAX_LINES} more in Dexterity Sheets.`);
  const foot = opts.digest ? 'Say “Sheets digest off” to stop this morning list.' : opts.digestOn === false ? 'Say “Sheets digest on” if you want this list each morning.' : '';
  return [head, lines.join('\n'), foot].filter(Boolean).join('\n\n');
}

/** Mentions of someone in Sheets comments, newest first. */
export function mentionsAnswer(items: SheetsMention[], sinceWords: string): string {
  if (!items.length) return `No one has mentioned you in Dexterity Sheets ${sinceWords}.`;
  const sorted = [...items].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const lines = sorted.slice(0, MAX_LINES).map((x) => {
    const said = label(x.text ?? '', 160);
    return `- ${workbookMarkdown(label(x.book ?? '') || 'Workbook', x.sheet || null, x.cell || null, x.link)} — ${label(x.from ?? '', 60) || 'Someone'}${said ? `: “${said}”` : ''}`;
  });
  if (sorted.length > MAX_LINES) lines.push(`- …and ${sorted.length - MAX_LINES} more.`);
  return `${sorted.length === 1 ? 'One mention' : `${sorted.length} mentions`} of you in Dexterity Sheets ${sinceWords}:\n\n${lines.join('\n')}`;
}

/** Who has a book open: names the hub knows, accounts it does not. */
export function whoAnswer(book: { name: string }, link: string | null, names: string[]): string {
  const title = link ? workbookMarkdown(label(book.name), null, null, link) : `**${label(book.name) || 'That workbook'}**`;
  if (!names.length) return `No one has ${title} open in Dexterity Sheets right now.`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.length === 1 ? `${list} has` : `${list} have`} ${title} open in Dexterity Sheets.`;
}

declare module './protocol.ts' {
  interface Ops {
    'admin.sheets.get': { req: void; res: SheetsAdminView };
    /** `url`: the Sheets server (address or URL; null forgets it). `token`: a new one replaces the saved one; empty keeps it; null removes it. */
    'admin.sheets.set': { req: { url?: string | null; token?: string | null }; res: SheetsAdminView };
    /** Asks the Sheets server (GET /api/v1/health with the token), with the saved settings or the ones being typed. */
    'admin.sheets.test': { req: { url?: string; token?: string }; res: SheetsTestResult };
    /** Sheets servers on the office network that answered within two seconds. */
    'admin.sheets.discover': { req: void; res: SheetsFound[] };
    /** Ask Nib a Sheets question in words; the answer is posted in the person's conversation with Nib. */
    'nib.sheets.ask': { req: { text: string }; res: { convId: string | null; messageId: string | null; text: string } };
  }
  interface Events {
    'admin.sheets': SheetsAdminView;
  }
}
