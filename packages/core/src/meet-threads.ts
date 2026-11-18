// Meeting threads, action points and recaps: the rules the hub and the apps share. A meeting's
// thread is a conversation; each time a meeting is held is an occurrence; an action point is a
// message in the thread with a register entry (AP-07, owner, due, status); a recap gathers an
// occurrence afterwards. See docs/MEETINGS.md, "Meeting threads, action points and recaps".
import { dueFrom, findPerson } from './nib.ts';
import { isWebGuest } from './meet.ts';
import type { NibPerson } from './nib.ts';
import type { RecordingInfo } from './meet.ts';
import type { FileInfo, MeetingKind } from './protocol.ts';

// ---------------------------------------------------------------- occurrences
export type OccurrenceState = 'live' | 'ended' | 'cancelled';
export interface MeetOccurrence {
  id: string;
  /** The meeting (nine-digit ID), when it was held as a call. */
  meetingId: string | null;
  convId: string;
  eventId: string | null;
  title: string;
  kind: MeetingKind;
  hostId: string;
  /** The Calendar slot it belongs to (null for a meeting held outside any slot). */
  slotStart: number | null;
  slotEnd: number | null;
  startedAt: number;
  endedAt: number | null;
  state: OccurrenceState;
  /** 1, 2, 3… in its thread (the drawing number's sheet). */
  seq: number;
  noteTakerId: string | null;
  /** The thread is an end-to-end encrypted Direct conversation: the app builds the chat part of the recap. */
  sealed: boolean;
}

/** MTG-482913207-03: the occurrence's drawing number. */
export const occurrenceNo = (o: Pick<MeetOccurrence, 'meetingId' | 'seq' | 'id'>): string =>
  `MTG-${o.meetingId ?? o.id.slice(-6)}-${String(Math.max(1, o.seq)).padStart(2, '0')}`;

/** How close to a Calendar slot a Room counts as that slot's occurrence. */
export const SLOT_EARLY_MS = 60 * 60_000;
export const SLOT_LATE_MS = 60 * 60_000;
/** A Room of the same meeting opened again this soon after the last ended resumes its occurrence. */
export const RESUME_MS = 15 * 60_000;

// ---------------------------------------------------------------- action points
export type ActionStatus = 'open' | 'done' | 'dropped';
export type ActionSource = 'chat' | 'strip' | 'promote' | 'register';
export interface ActionPoint {
  id: string;
  convId: string;
  occurrenceId: string | null;
  /** 1, 2, 3… in the thread: AP-01, AP-02. */
  n: number;
  /** The task, as the hub can read it ('' when the message is end-to-end encrypted). */
  text: string;
  sealed: boolean;
  /** A colleague, or null for a guest named in ownerName. */
  ownerId: string | null;
  ownerName: string | null;
  /** YYYY-MM-DD */
  due: string | null;
  status: ActionStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  doneBy: string | null;
  /** The card's message in the thread. */
  messageId: string;
  source: ActionSource;
  /** Logged in an earlier occurrence and still open when this one began. */
  carried?: boolean;
  /** Who runs the meeting it came from (they may change it, with its owner and whoever logged it). */
  organiserId?: string | null;
  /** When its words were last revised after it was logged (null: as logged, or as its message says). */
  revisedAt?: number | null;
}

/** One change in an action point's history (its audit trail), newest last. */
export interface ActionChange {
  at: number;
  by: string;
  /** 'logged' when it was made, 'changed' for an edit, 'ticked' from a day sheet. */
  kind: 'logged' | 'changed' | 'ticked';
  /** What changed, from what to what ('' for none; owners as user ids, or a guest's name with a leading '~'). */
  fields: Array<{ field: 'text' | 'owner' | 'due' | 'status'; from: string; to: string }>;
}

/**
 * Who may change an action point (its words, owner, due date, done or open, or drop it): its owner,
 * whoever logged it, the meeting's organiser, and the office's owners and administrators. Guests
 * and bots never. The hub enforces it; the app greys out what you may not do.
 */
export function mayChangeAction(ap: Pick<ActionPoint, 'ownerId' | 'createdBy' | 'organiserId'>, me: { id: string; role: string }): boolean {
  if (me.role === 'guest' || me.role === 'bot') return false;
  return ap.createdBy === me.id || ap.ownerId === me.id || (!!ap.organiserId && ap.organiserId === me.id) || me.role === 'owner' || me.role === 'admin';
}

export const apRef = (n: number): string => `AP-${String(Math.max(1, Math.floor(n))).padStart(2, '0')}`;
export const ACTION_TEXT_MAX = 300;
export const AGENDA_MAX = 30;

/** "Mr Rao (guest)", "Ravi Kumar", or "No owner". */
export function ownerLabel(ap: Pick<ActionPoint, 'ownerId' | 'ownerName'>, nameOf: (id: string) => string): string {
  if (ap.ownerId) return nameOf(ap.ownerId);
  if (ap.ownerName) return `${ap.ownerName} (guest)`;
  return 'No owner';
}

/** Open and past its date (dates compared as YYYY-MM-DD). */
export const isOverdue = (ap: Pick<ActionPoint, 'status' | 'due'>, today: string): boolean => ap.status === 'open' && !!ap.due && ap.due < today;

// ---------------------------------------------------------------- capture from words
/** Words that start an action point in a chat line. Returns the rest, or null. */
const TRIGGER = /^\s*(?:\/action\b|\/ap\b|ap\s*[:\-–—]|action(?:\s+point)?\s*[:\-–—]|→|->|=>)\s*/i;
export function actionTrigger(text: string): string | null {
  const m = TRIGGER.exec(text);
  return m ? text.slice(m[0].length) : null;
}

export interface ActionParseContext {
  /** Colleagues (and the meeting's guests, with their guest: ids) who can own it. */
  people: NibPerson[];
  /** YYYY-MM-DD, the day the words are written. */
  today: string;
  meId?: string;
}
export interface ActionParse {
  task: string;
  owner: { id: string | null; name: string } | null;
  due: string | null;
  /** Where the owner and the due date were found in the words (for underlining as you type). */
  spans: Array<{ from: number; to: number; kind: 'owner' | 'due' }>;
}

const HONORIFIC = /^(?:mr|mrs|ms|dr|shri|smt|er)\.?\s/i;
const MENTION_AT = /^<@([0-9A-Za-z_:-]{2,60})>/;

/**
 * Read an action point: "Ravi to send the revised GA by Fri", "@Meera: check the MTO", "Mr Rao
 * will confirm the nozzle loads by 20 Nov", "send the GA – Ravi". Never throws; whatever cannot be
 * placed stays in the task.
 */
export function parseAction(input: string, ctx: ActionParseContext): ActionParse {
  const raw = String(input ?? '').replace(/\s+/g, ' ').slice(0, 400);
  const out: ActionParse = { task: '', owner: null, due: null, spans: [] };
  let text = raw.trim();
  if (!text) return out;
  const lead = raw.length - raw.trimStart().length;
  const byId = new Map(ctx.people.map((p) => [p.id, p]));
  // the owner first: "<@id> …", "Name to/will/: …"
  let ownerEnd = 0;
  const men = MENTION_AT.exec(text);
  if (men && byId.has(men[1])) {
    out.owner = { id: men[1], name: byId.get(men[1])!.name };
    ownerEnd = men[0].length;
  } else {
    const m = /^@?((?:[\p{L}][\p{L}.'-]*)(?:\s+[\p{L}][\p{L}.'-]*){0,2}?)\s*(?:[:,–—-]\s*|\s+(?:to|will|should|shall|must|please|pls|ko|se)\b\s*)/u.exec(text);
    if (m) {
      const name = m[1].trim();
      const p = findPerson(name, ctx.people);
      if (p) out.owner = { id: isWebGuest(p.id) ? null : p.id, name: p.name };
      else if (HONORIFIC.test(`${name} `)) out.owner = { id: null, name };
      if (out.owner) ownerEnd = m[0].length;
    }
  }
  if (out.owner) out.spans.push({ from: lead, to: lead + ownerEnd, kind: 'owner' });
  let rest = text.slice(ownerEnd);
  // "… – Ravi" or "… (Ravi)" at the end
  if (!out.owner) {
    const tail = /\s*(?:[–—-]\s*|\(\s*)@?([\p{L}][\p{L}.' -]{1,40}?)\s*\)?\s*$/u.exec(rest);
    if (tail) {
      const p = findPerson(tail[1], ctx.people);
      if (p) {
        out.owner = { id: isWebGuest(p.id) ? null : p.id, name: p.name };
        out.spans.push({ from: lead + ownerEnd + tail.index, to: lead + ownerEnd + tail.index + tail[0].length, kind: 'owner' });
        rest = rest.slice(0, tail.index);
      }
    }
  }
  const due = dueFrom(rest, ctx.today);
  if (due) {
    out.due = due.due;
    out.spans.push({ from: lead + ownerEnd + due.from, to: lead + ownerEnd + due.to, kind: 'due' });
    rest = `${rest.slice(0, due.from)} ${rest.slice(due.to)}`;
  }
  let task = rest.replace(/\s+/g, ' ').replace(/^[\s:,;–—-]+|[\s,;:–—-]+$/g, '').trim();
  if (task) task = task[0].toLocaleUpperCase() + task.slice(1);
  out.task = task.slice(0, ACTION_TEXT_MAX);
  out.spans.sort((a, b) => a.from - b.from);
  return out;
}

// ---------------------------------------------------------------- working hours
/** Is this moment inside the working day (workdays, between the start and the wrap-up, HH:MM local)? */
export function inWorkingHours(t: number, workdays: number[], start: string, end: string): boolean {
  const d = new Date(t);
  if (!workdays.includes(d.getDay())) return false;
  const min = d.getHours() * 60 + d.getMinutes();
  const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  return min >= hm(start) && min < hm(end);
}

// ---------------------------------------------------------------- agenda
export interface AgendaItem { id: string; n: number; text: string; minutes: number | null; doneAt: number | null }

// ---------------------------------------------------------------- the recap
export interface RecapPerson { userId: string; name: string; guest: boolean; firstJoin: number; lastLeave: number; totalMs: number; joins: number }
export interface RecapFile { file: FileInfo; messageId: string; authorId: string; authorName: string; at: number }
export interface RecapDecision { messageId: string; question: string; authorId: string; at: number; reached: number; outcomes: Array<{ label: string; count: number }> }
export interface RecapPoll { messageId: string; question: string; options: Array<{ text: string; votes: number }>; voters: number }
export interface RecapNote { kind: 'note' | 'board'; id: string; title: string; updatedAt: number }
export interface RecapLine { messageId: string; authorId: string; name: string; guest: boolean; text: string; at: number; everyone: boolean; breakout: string | null; files: string[] }

export interface MeetRecap {
  occurrence: MeetOccurrence;
  /** What this viewer may do and see. */
  viewer: { member: boolean; organiser: boolean };
  attendance: RecapPerson[];
  /** Invited (or members of the meeting's own thread) and never in it. */
  absent: string[];
  recordings: RecordingInfo[];
  actions: ActionPoint[];
  decisions: RecapDecision[];
  files: RecapFile[];
  filesMore: number;
  polls: RecapPoll[];
  notes: RecapNote[];
  agenda: AgendaItem[];
  /** The chat's first page (the hub cannot read an encrypted Direct thread: then empty, and `sealed`). */
  chat: { lines: RecapLine[]; total: number; next: string | null; from: number; to: number; sealed: boolean };
}

/** The parts the organiser may send by email. */
export interface RecapParts { attendance: boolean; actions: boolean; decisions: boolean; files: boolean; polls: boolean; recording: boolean; chat: boolean }
export const RECAP_PARTS_ALL: RecapParts = { attendance: true, actions: true, decisions: true, files: true, polls: true, recording: true, chat: false };
export const RECAP_PARTS_GUESTS: RecapParts = { attendance: false, actions: true, decisions: false, files: true, polls: false, recording: false, chat: false };

const two = (n: number) => String(n).padStart(2, '0');
const hm = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const day = (t: number) => new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const durationText = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${two(m % 60)} min`;
};
const statusWord: Record<ActionStatus, string> = { open: 'Open', done: 'Done', dropped: 'Dropped' };

/** The recap as plain text (Copy recap, and the email's text part). */
export function recapText(r: MeetRecap, parts: RecapParts, nameOf: (id: string) => string): string {
  const o = r.occurrence;
  const lines: string[] = [];
  const end = o.endedAt ?? Date.now();
  lines.push(`${o.title}`, `${occurrenceNo(o)} · ${day(o.startedAt)} · ${hm(o.startedAt)}–${hm(end)} · ${durationText(end - o.startedAt)}`, `Organiser: ${nameOf(o.hostId)}${o.noteTakerId ? ` · Note-taker: ${nameOf(o.noteTakerId)}` : ''}`, '');
  if (parts.attendance) {
    lines.push('ATTENDANCE');
    for (const p of r.attendance) lines.push(`  ${p.name}${p.guest ? ' (guest)' : ''} · ${durationText(p.totalMs)}`);
    if (r.absent.length) lines.push(`  Invited, not there: ${r.absent.map(nameOf).join(', ')}`);
    lines.push('');
  }
  if (parts.actions && r.actions.length) {
    lines.push('ACTION POINTS');
    for (const a of r.actions) lines.push(`  ${apRef(a.n)} ${a.text || '(encrypted: open it in Dexterity Connect)'} · ${ownerLabel(a, nameOf)}${a.due ? ` · due ${a.due}` : ''} · ${statusWord[a.status]}${a.carried ? ' · brought forward' : ''}`);
    lines.push('');
  }
  if (parts.decisions && r.decisions.length) {
    lines.push('DECISIONS');
    for (const d of r.decisions) lines.push(`  ${d.question}${d.outcomes.length ? `: ${d.outcomes.map((x) => `${x.label} (${x.count})`).join(', ')}` : ''}`);
    lines.push('');
  }
  if (parts.polls && r.polls.length) {
    lines.push('POLLS');
    for (const p of r.polls) lines.push(`  ${p.question}: ${p.options.map((x) => `${x.text} ${x.votes}`).join(' · ')}`);
    lines.push('');
  }
  if (parts.files && r.files.length) {
    lines.push('FILES');
    for (const f of r.files) lines.push(`  ${f.file.name} · ${f.authorName}`);
    if (r.filesMore) lines.push(`  and ${r.filesMore} more`);
    lines.push('');
  }
  if (parts.recording && r.recordings.length) {
    lines.push('RECORDING');
    for (const rec of r.recordings) lines.push(`  ${rec.title} · ${durationText(rec.durationMs)}${rec.chapters.length ? ` · ${rec.chapters.length} chapters` : ''}`);
    lines.push('');
  }
  if (parts.chat && r.chat.lines.length) {
    lines.push('CHAT');
    for (const l of r.chat.lines) lines.push(`  ${hm(l.at)} ${l.name}${l.guest ? ' (guest)' : ''}: ${l.text}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The recap as an email (subject, text, HTML) for buildEml. */
export function recapEmail(r: MeetRecap, parts: RecapParts, nameOf: (id: string) => string, office = 'Dexterity Connect'): { subject: string; text: string; html: string } {
  const o = r.occurrence;
  const text = recapText(r, parts, nameOf);
  const end = o.endedAt ?? Date.now();
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td style="border-bottom:1px solid #d5e2e3;padding:6px 8px;vertical-align:top">${c}</td>`).join('')}</tr>`;
  const section = (no: string, title: string, body: string) => `<h3 style="font:600 11px/1.4 Consolas,monospace;letter-spacing:.12em;color:#1e6066;margin:20px 0 6px">${no} ${esc(title.toUpperCase())}</h3>${body}`;
  const table = (rows: string[]) => `<table style="border-collapse:collapse;width:100%;font:14px 'Segoe UI',system-ui,sans-serif">${rows.join('')}</table>`;
  const out: string[] = [];
  let n = 0;
  const no = () => two(++n);
  if (parts.attendance) out.push(section(no(), 'Attendance', table([...r.attendance.map((p) => row([esc(p.name) + (p.guest ? ' <small>(guest)</small>' : ''), esc(durationText(p.totalMs))])), ...(r.absent.length ? [row([`<i>Invited, not there</i>`, esc(r.absent.map(nameOf).join(', '))])] : [])])));
  if (parts.actions && r.actions.length) out.push(section(no(), 'Action points', table(r.actions.map((a) => row([`<b style="font-family:Consolas,monospace">${apRef(a.n)}</b>`, esc(a.text || '(encrypted)'), esc(ownerLabel(a, nameOf)), esc(a.due ?? ''), esc(statusWord[a.status])])))));
  if (parts.decisions && r.decisions.length) out.push(section(no(), 'Decisions', table(r.decisions.map((d) => row([esc(d.question), esc(d.outcomes.map((x) => `${x.label} (${x.count})`).join(', '))])))));
  if (parts.polls && r.polls.length) out.push(section(no(), 'Polls', table(r.polls.map((p) => row([esc(p.question), esc(p.options.map((x) => `${x.text} ${x.votes}`).join(' · '))])))));
  if (parts.files && r.files.length) out.push(section(no(), 'Files', table(r.files.map((f) => row([esc(f.file.name), esc(f.authorName)])))));
  if (parts.recording && r.recordings.length) out.push(section(no(), 'Recording', table(r.recordings.map((x) => row([esc(x.title), esc(durationText(x.durationMs))])))));
  if (parts.chat && r.chat.lines.length) out.push(section(no(), 'Chat', table(r.chat.lines.map((l) => row([esc(hm(l.at)), esc(l.name), esc(l.text)])))));
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#f4f8f8;color:#14292b">`
    + `<div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #c4d6d7">`
    + `<div style="border-bottom:2px solid #1c7680;padding:16px 20px"><div style="font:600 11px Consolas,monospace;letter-spacing:.12em;color:#1e6066">MEETING RECAP · ${esc(occurrenceNo(o))}</div>`
    + `<h2 style="font:600 22px 'Segoe UI',system-ui,sans-serif;margin:6px 0">${esc(o.title)}</h2>`
    + `<div style="font:13px 'Segoe UI',system-ui,sans-serif;color:#41605f">${esc(day(o.startedAt))} · ${hm(o.startedAt)}–${hm(end)} · ${esc(durationText(end - o.startedAt))} · ${esc(nameOf(o.hostId))}</div></div>`
    + `<div style="padding:4px 20px 20px">${out.join('')}</div></div>`
    + `<p style="font:12px 'Segoe UI',system-ui,sans-serif;color:#6b8584;text-align:center">${esc(office)}</p></body>`;
  return { subject: `Recap: ${o.title} (${day(o.startedAt)})`, text, html };
}

// ---------------------------------------------------------------- what messages carry
/** A card the hub posts in a thread: an occurrence started, its recap, or the meeting was cancelled. */
export interface MeetCard {
  kind: 'started' | 'recap' | 'cancelled';
  occurrenceId: string | null;
  title: string;
  no: string;
  startedAt: number;
  endedAt: number | null;
  /** Counts on the recap card. */
  people?: number;
  files?: number;
  actionsOpen?: number;
  actionsDone?: number;
  decisions?: number;
  minutes?: number;
}

/** A line said in the meeting chat (to everyone in the Room, guests included). */
export interface MeetLine { name: string; guest: boolean; breakout: string | null; occurrenceId: string | null }

// ---------------------------------------------------------------- the protocol, extended
declare module './protocol.ts' {
  interface Message {
    /** A card the hub posted about the meeting held in this thread. */
    meetCard?: MeetCard | null;
    /** An action point on this message. */
    actionPoint?: ActionPoint | null;
    /** Said in the meeting chat (guests read it); a guest's line carries their name. */
    meetLine?: MeetLine | null;
  }
  interface RoomInfo {
    /** The occurrence of the meeting this Room is part of (its thread's divider and recap). */
    occurrenceId?: string | null;
    /** Who takes the notes in this occurrence. */
    noteTakerId?: string | null;
  }
  interface MeetingRecord {
    /** The occurrence it was part of, for its recap. */
    occurrenceId?: string | null;
  }
  interface Ops {
    /** The meeting's thread (made when needed) and its occurrences, newest first. */
    'meet.thread': { req: { convId?: string; eventId?: string; meetingId?: string }; res: { convId: string; occurrences: MeetOccurrence[]; live: MeetOccurrence | null; next: { slotStart: number; slotEnd: number } | null } };
    'meet.recap': { req: { occurrenceId: string }; res: MeetRecap };
    /** More of a recap's chat, older to newer from the cursor. */
    'meet.recapChat': { req: { occurrenceId: string; after: string; q?: string }; res: { lines: RecapLine[]; next: string | null } };
    /** The recap of a Calendar event's occurrence at that slot, if one was held. */
    'meet.recapFor': { req: { eventId: string; slotStart: number }; res: { occurrenceId: string | null } };
    'meet.noteTaker': { req: { roomId: string; userId: string | null }; res: { ok: true } };
    /** Log an action point on a message in a thread (one the app just sent, or any to promote). */
    'ap.create': { req: { messageId: string; text?: string; ownerId?: string | null; ownerName?: string | null; due?: string | null; source?: ActionSource }; res: ActionPoint };
    'ap.update': { req: { id: string; text?: string; ownerId?: string | null; ownerName?: string | null; due?: string | null; status?: ActionStatus }; res: ActionPoint };
    /** A thread's register (with what is brought forward), or my own open points across threads. */
    'ap.list': { req: { convId?: string; occurrenceId?: string; mine?: boolean }; res: { actions: ActionPoint[]; next: number } };
    /** An action point's history: who logged it and every change since (for anyone who may read it). */
    'ap.history': { req: { id: string }; res: { action: ActionPoint; changes: ActionChange[] } };
    'agenda.get': { req: { convId: string }; res: { occurrenceId: string | null; items: AgendaItem[] } };
    'agenda.set': { req: { convId: string; items: Array<{ id?: string; text: string; minutes: number | null }> }; res: { occurrenceId: string | null; items: AgendaItem[] } };
    'agenda.tick': { req: { convId: string; id: string; done: boolean }; res: { occurrenceId: string | null; items: AgendaItem[] } };
  }
  interface Events {
    /** To an action point's owner (once, quietly) and the thread: it changed. */
    'ap.assigned': { action: ActionPoint; by: string; title: string };
    'ap.updated': ActionPoint;
    'meet.occurrence': MeetOccurrence;
    'agenda.updated': { convId: string; occurrenceId: string | null; items: AgendaItem[] };
  }
}
