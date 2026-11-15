// Meetings, phase M3: webinars. A webinar is a meeting with three roles: the organiser (its
// host, with co-hosts), panelists (seen and heard, they share) and attendees (they see and hear
// the stage, never the other way round). People outside the office register on a page the
// gateway serves and get a personal link; the app keeps the registrants, the questions, polls,
// handouts, the practice session and go-live, the live stream and the follow-up. The types
// extend the hub protocol (protocol.ts) by declaration merging, as meet.ts does.
import type { IceServer } from './protocol.ts';
import type { MeetingReport } from './meet.ts';
import { buildIcs } from './ics.ts';
import type { Invitation } from './ics.ts';
import { toCsv } from './csv.ts';

// ---------------------------------------------------------------- limits
/** Panelists besides the organiser: the stage is a PC-to-PC Room of up to 8. */
export const WEBINAR_MAX_PANELISTS = 7;
/** Viewers the stage is sent to straight from a PC (outside the office, or with no relay), through TURN. */
export const WEBINAR_DIRECT_VIEWERS = 25;
/** Attendees at once (on the office network, through the hub's relay). */
export const WEBINAR_AUDIENCE_MAX = 500;
/** Registrations a webinar may take (the organiser sets a lower cap). */
export const WEBINAR_REGISTRATION_MAX = 5000;
export const WEBINAR_FIELDS_MAX = 12;
export const WEBINAR_QUESTION_MAX = 500;
export const WEBINAR_ANSWER_MAX = 2000;
export const HANDOUTS_MAX = 12;
/** A registrant's personal token: 128 random bits, base64url. */
export const REG_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const EMAIL_RE = /^[^\s@<>"(),;:]{1,64}@[^\s@<>"(),;:]{1,190}\.[A-Za-z]{2,24}$/;

// ---------------------------------------------------------------- the webinar
export type WebinarState = 'scheduled' | 'practice' | 'live' | 'ended';
export type WebinarRole = 'organizer' | 'panelist' | 'attendee';
/** A question on the registration form or the follow-up survey. */
export interface WebinarField { id: string; label: string; kind: 'text' | 'choice'; options: string[]; required: boolean }
export type FieldAnswers = Record<string, string>;
/** A field as the organiser writes it (the hub gives it an id and cleans it). */
export interface WebinarFieldInput { id?: string; label: string; kind: 'text' | 'choice'; options?: string[]; required?: boolean }

export interface WebinarSettings {
  /** auto: every registrant is let in at once; manual: the organiser approves each one. */
  approval: 'auto' | 'manual';
  /** Most registrations taken. */
  cap: number;
  /** The registration page takes new registrations. */
  registrationOpen: boolean;
  /** Attendees may ask without their name. */
  anonymousQuestions: boolean;
  /** Everyone in the office sees it on the Meet lens and can watch. */
  listed: boolean;
}

export interface WebinarStreamView {
  /** rtmp:// or rtmps:// address (without the key). */
  url: string | null;
  /** The last four characters of the stream key (the key itself stays on the hub). */
  keyHint: string | null;
  /** A page where people can watch the stream (shown to viewers the webinar could not take). */
  watchUrl: string | null;
}

/** What the organiser and panelists see. */
export interface WebinarInfo {
  meetingId: string;
  title: string;
  description: string;
  startsAt: number;
  durationMin: number;
  hostId: string;
  coHosts: string[];
  panelists: string[];
  convId: string | null;
  settings: WebinarSettings;
  fields: WebinarField[];
  survey: WebinarField[];
  state: WebinarState;
  wentLiveAt: number | null;
  endedAt: number | null;
  /** The main Room of the last run, for its report. */
  roomId: string | null;
  registrants: { total: number; approved: number; pending: number; rejected: number };
  /** https://<gateway>/w/<ID>, when the office's gateway is on. */
  registerUrl: string | null;
  /** Why outside people cannot register now, in plain words. */
  problem: string | null;
  stream: WebinarStreamView;
  followUpAt: number | null;
  role: WebinarRole;
}

/** A webinar in a list (the Meet lens). */
export interface WebinarCard { meetingId: string; title: string; startsAt: number; durationMin: number; hostId: string; state: WebinarState; role: WebinarRole; audience: number; roomId: string | null }

export interface Registrant {
  id: string;
  name: string;
  email: string;
  answers: FieldAnswers;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
  /** Their personal link (https://<gateway>/w/<ID>/watch#<token>). */
  joinUrl: string | null;
  /** After the webinar: were they there while it was live? */
  attended: boolean | null;
  minutes: number;
}

export interface WebinarQuestion {
  id: string;
  text: string;
  /** Empty when asked anonymously (the organiser does not see the name either). */
  author: string;
  anonymous: boolean;
  votes: number;
  at: number;
  status: 'open' | 'answered' | 'live' | 'dismissed';
  answer: { text: string; by: string; at: number } | null;
  pinned: boolean;
  onStage: boolean;
  /** The viewer asked it / upvoted it. */
  own?: boolean;
  voted?: boolean;
}

export interface WebinarPoll {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  open: boolean;
  /** Attendees see the results. */
  showResults: boolean;
  /** Present when the viewer may see them: votes per option, and how many voted. */
  results: number[] | null;
  voters: number;
  /** The viewer's own choices. */
  mine: number[];
  at: number;
}

export interface Handout { id: string; name: string; size: number; mime: string; at: number }

/** The webinar as everyone sees it while it runs (attendees and panelists). */
export interface WebinarLive {
  meetingId: string;
  title: string;
  description: string;
  startsAt: number;
  state: WebinarState;
  wentLiveAt: number | null;
  host: string;
  panelists: string[];
  audience: number;
  hands: number;
  /** The device composing the stage (an organiser's PC), or null. */
  broadcaster: string | null;
  onStage: WebinarQuestion | null;
  poll: WebinarPoll | null;
  handouts: Handout[];
  anonymousQuestions: boolean;
  watchUrl: string | null;
  roomId: string | null;
}

/** How a viewer gets the stage: the hub's relay (office network), straight from a PC through TURN, or not at all (full). */
export type StageRoute = 'relay' | 'direct' | 'full' | 'none';

export interface AudienceMember { deviceId: string; userId: string; name: string; web: boolean; route: StageRoute; hand: number; since: number; invited: boolean }

export interface StreamStatus {
  state: 'off' | 'starting' | 'live' | 'stalled' | 'stopped' | 'failed' | 'unavailable';
  /** kbit/s */
  bitrate: number | null;
  fps: number | null;
  dropped: number;
  frames: number;
  speed: number | null;
  /** Seconds of video sent. */
  seconds: number;
  message: string | null;
  ffmpeg: string | null;
  since: number | null;
}

export interface WebinarReport {
  meetingId: string;
  title: string;
  startsAt: number;
  wentLiveAt: number | null;
  endedAt: number | null;
  peakAudience: number;
  registrants: Array<Registrant & { registeredAt: number }>;
  attendees: Array<{ name: string; email: string | null; office: boolean; registrantId: string | null; minutes: number; firstSeen: number; hands: number }>;
  questions: WebinarQuestion[];
  polls: Array<{ question: string; options: Array<{ text: string; votes: number }>; voters: number; answers: Array<{ name: string; choices: string[] }> }>;
  handouts: Array<{ name: string; downloads: Array<{ name: string; at: number }> }>;
  survey: { fields: WebinarField[]; answers: Array<{ name: string; at: number; answers: FieldAnswers }> };
}

// ---------------------------------------------------------------- the registration form
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The organiser's questions, cleaned: labels, kinds, 2 to 12 options for a choice, required or not. */
export function cleanFields(input: unknown): WebinarField[] {
  if (!Array.isArray(input)) return [];
  const out: WebinarField[] = [];
  const ids = new Set<string>();
  for (const raw of input.slice(0, WEBINAR_FIELDS_MAX)) {
    const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const label = clean(f.label, 120);
    if (!label) continue;
    const kind = f.kind === 'choice' ? 'choice' : 'text';
    const options = kind === 'choice' && Array.isArray(f.options) ? [...new Set(f.options.map((o) => clean(o, 80)).filter(Boolean))].slice(0, 12) : [];
    if (kind === 'choice' && options.length < 2) throw new Error(`"${label}" needs at least two choices.`);
    let id = typeof f.id === 'string' && /^[a-z0-9]{1,12}$/.test(f.id) ? f.id : '';
    if (!id || ids.has(id)) { let n = out.length + 1; while (ids.has(`q${n}`)) n++; id = `q${n}`; }
    ids.add(id);
    out.push({ id, label, kind, options, required: f.required === true });
  }
  return out;
}

/** Answers to the fields, checked: every required one given, a choice one of its options. Throws a plain message. */
export function checkAnswers(fields: WebinarField[], input: unknown): FieldAnswers {
  const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: FieldAnswers = {};
  for (const f of fields) {
    const v = clean(d[f.id], 1000);
    if (!v) { if (f.required) throw new Error(`Answer "${f.label}".`); continue; }
    if (f.kind === 'choice' && !f.options.includes(v)) throw new Error(`Choose one of the answers to "${f.label}".`);
    out[f.id] = v;
  }
  return out;
}

export function cleanName(v: unknown): string { return clean(v, 80).replace(/[<>]/g, ''); }
export function cleanEmail(v: unknown): string { return clean(v, 254).toLowerCase(); }

// ---------------------------------------------------------------- links
const base = (gateway: string) => gateway.replace(/\/+$/, '');
export const webinarRegisterUrl = (gateway: string, meetingId: string): string => `${base(gateway)}/w/${meetingId}`;
/** The personal link: the token is in the fragment, so no server log ever has it. */
export const webinarWatchUrl = (gateway: string, meetingId: string, token: string): string => `${base(gateway)}/w/${meetingId}/watch#${token}`;
export const webinarSurveyUrl = (gateway: string, meetingId: string, token: string): string => `${base(gateway)}/w/${meetingId}/survey#${token}`;
export const webinarAppLink = (meetingId: string, what?: 'survey'): string => `dexconnect://webinar/${meetingId}${what ? `/${what}` : ''}`;

// ---------------------------------------------------------------- what the organiser sends
export interface WebinarMail { registrantId: string; name: string; email: string; subject: string; text: string; ics: string | null }

export interface WebinarMailInput {
  meetingId: string;
  title: string;
  description: string;
  startsAt: number;
  durationMin: number;
  organizer: { id: string; name: string; email: string | null };
  office: string;
  /** "Tuesday 18 November, 3:00 to 4:00 PM (IST)", as the organiser's PC writes it. */
  when: string;
  registerUrl: string | null;
}

/** The invitation as an .ics with the registrant's own link. */
function personalIcs(w: WebinarMailInput, joinUrl: string, sequence: number): string {
  const inv: Invitation = {
    uid: `webinar-${w.meetingId}@dexconnect`, title: w.title, startAt: w.startsAt, endAt: w.startsAt + w.durationMin * 60_000,
    organizer: w.organizer, office: w.office, meetingId: w.meetingId, guestUrl: joinUrl, passcode: null,
    appLink: webinarAppLink(w.meetingId), description: w.description, location: joinUrl, sequence,
    text: [w.title, w.when, '', 'Your personal link (keep it to yourself):', joinUrl, ...(w.description.trim() ? ['', w.description.trim()] : [])].join('\n'),
  };
  return buildIcs(inv, w.when);
}

/** The invitation (or a reminder) for one approved registrant: email text and an .ics with their own link. */
export function webinarInvitation(w: WebinarMailInput, r: { id: string; name: string; email: string; joinUrl: string }, kind: 'invite' | 'reminder'): WebinarMail {
  const first = r.name.split(' ')[0] || r.name;
  const subject = kind === 'invite' ? `Your place at ${w.title}` : `Reminder: ${w.title} starts ${w.when.split(',')[0]}`;
  const lines = [
    `Dear ${first},`,
    '',
    kind === 'invite' ? `Thank you for registering. Your place at ${w.title} is confirmed.` : `${w.title} is coming up.`,
    w.when,
    '',
    'Watch from your browser with your personal link (nothing to install):',
    r.joinUrl,
    'The link is yours alone: it shows the organiser that you came. Ask questions and answer polls from the same page.',
    ...(w.description.trim() ? ['', w.description.trim()] : []),
    '',
    `${w.organizer.name}`,
    w.office,
  ];
  return { registrantId: r.id, name: r.name, email: r.email, subject, text: lines.join('\n'), ics: personalIcs(w, r.joinUrl, kind === 'invite' ? 0 : 1) };
}

/** After the webinar: a thank-you (or a note to someone who could not come) with the recording and the survey. */
export function webinarFollowUp(w: WebinarMailInput, r: { id: string; name: string; email: string; attended: boolean; surveyUrl: string | null }, note: string, recordingUrl: string | null): WebinarMail {
  const first = r.name.split(' ')[0] || r.name;
  const lines = [
    `Dear ${first},`,
    '',
    r.attended ? `Thank you for attending ${w.title}.` : `We missed you at ${w.title}.`,
    ...(note.trim() ? ['', note.trim()] : []),
    ...(recordingUrl ? ['', r.attended ? 'The recording, to watch again:' : 'You can watch the recording:', recordingUrl] : []),
    ...(r.surveyUrl ? ['', 'Tell us what you thought (two minutes):', r.surveyUrl] : []),
    '',
    `${w.organizer.name}`,
    w.office,
  ];
  return { registrantId: r.id, name: r.name, email: r.email, subject: r.attended ? `Thank you for attending ${w.title}` : `${w.title}: the recording`, text: lines.join('\n'), ics: null };
}

/** The follow-up for colleagues, as the system bot writes it in the app (Markdown). */
export function webinarFollowUpMessage(title: string, organizer: string, note: string, recordingLink: string | null, survey: boolean, meetingId: string): string {
  return [
    `**Thank you for attending ${title}**`,
    ...(note.trim() ? ['', note.trim()] : []),
    ...(recordingLink ? ['', `The recording: ${recordingLink}`] : []),
    ...(survey ? ['', `A short survey: ${webinarAppLink(meetingId, 'survey')}`] : []),
    '',
    `— ${organizer}`,
  ].join('\n');
}

/** For a mail merge: one row per registrant, with their link. */
export function mailMergeCsv(mails: WebinarMail[], links: Map<string, string>): string {
  return toCsv([['Name', 'Email', 'Subject', 'Personal link', 'Message'], ...mails.map((m) => [m.name, m.email, m.subject, links.get(m.registrantId) ?? '', m.text])]);
}

// ---------------------------------------------------------------- CSV
const iso = (t: number | null) => (t === null ? '' : new Date(t).toISOString().replace('T', ' ').slice(0, 19));

export function registrantsCsv(fields: WebinarField[], list: Registrant[]): string {
  return toCsv([
    ['Name', 'Email', 'Status', 'Registered (UTC)', 'Attended', 'Minutes watched', 'Personal link', ...fields.map((f) => f.label)],
    ...list.map((r) => [r.name, r.email, r.status, iso(r.createdAt), r.attended === null ? '' : r.attended ? 'attended' : 'no-show', r.minutes, r.joinUrl ?? '', ...fields.map((f) => r.answers[f.id] ?? '')]),
  ]);
}

/** The webinar's own sections: registrants, attendance, questions, polls with each person's answers, handouts, the survey. */
export function webinarReportCsv(w: WebinarReport): string { return toCsv(webinarReportRows(w)); }

/** The same sections as rows, for the meeting report's CSV (meet-csv.ts). */
export function webinarReportRows(w: WebinarReport): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = [
    ['Webinar', w.title],
    ['Meeting ID', w.meetingId],
    ['Planned start (UTC)', iso(w.startsAt)],
    ['Went live (UTC)', iso(w.wentLiveAt)],
    ['Ended (UTC)', iso(w.endedAt)],
    ['Most attendees at once', w.peakAudience],
    [],
    ['Registrant', 'Email', 'Status', 'Registered (UTC)', 'Attended', 'Minutes watched'],
    ...w.registrants.map((r) => [r.name, r.email, r.status, iso(r.registeredAt), r.attended === null ? '' : r.attended ? 'attended' : 'no-show', r.minutes]),
    [],
    ['Attendee', 'Email', 'From', 'First seen (UTC)', 'Minutes watched', 'Hands raised'],
    ...w.attendees.map((a) => [a.name, a.email ?? '', a.office ? 'office' : 'registered', iso(a.firstSeen), a.minutes, a.hands]),
    [],
    ['Question', 'Asked by', 'Votes', 'Status', 'Answer', 'Answered by'],
    ...w.questions.map((q) => [q.text, q.anonymous ? '(anonymous)' : q.author, q.votes, q.status === 'live' ? 'answered live' : q.status, q.answer?.text ?? '', q.answer?.by ?? '']),
  ];
  for (const p of w.polls) {
    rows.push([], ['Poll', p.question, `${p.voters} voted`], ...p.options.map((o) => ['', o.text, o.votes]));
    if (p.answers.length) rows.push(['', 'Who', 'Answer'], ...p.answers.map((a) => ['', a.name, a.choices.join('; ')]));
  }
  if (w.handouts.length) {
    rows.push([], ['Handout', 'Downloads', 'Downloaded by']);
    for (const h of w.handouts) rows.push([h.name, h.downloads.length, h.downloads.map((d) => d.name).join('; ')]);
  }
  if (w.survey.fields.length) {
    rows.push([], ['Survey', 'Answered (UTC)', ...w.survey.fields.map((f) => f.label)]);
    for (const a of w.survey.answers) rows.push([a.name, iso(a.at), ...w.survey.fields.map((f) => a.answers[f.id] ?? '')]);
  }
  return rows;
}

// ---------------------------------------------------------------- the gateway's webinar pages
/** What the registration page shows (GET /w/<ID>/info). */
export interface WebinarPublic {
  meetingId: string;
  title: string;
  description: string;
  startsAt: number;
  durationMin: number;
  organizer: string;
  office: string;
  fields: WebinarField[];
  approval: 'auto' | 'manual';
  /** Registration is open; otherwise why not. */
  open: boolean;
  closed: string | null;
  state: WebinarState;
}

/** Frames from a browser attendee (watch page), through the gateway, to the hub. */
export type WebinarUp =
  | { t: 'watch'; token: string }
  | { t: 'ask'; text: string; anonymous: boolean }
  | { t: 'vote'; questionId: string; up: boolean }
  | { t: 'pollVote'; pollId: string; choices: number[] }
  | { t: 'hand'; up: boolean }
  | { t: 'react'; emoji: string }
  | { t: 'signal'; to: string; data: unknown }
  | { t: 'handout'; id: string }
  | { t: 'speak'; accept: boolean }
  | { t: 'leave' }
  | { t: 'ping' };

/** Frames from the hub to a browser attendee. */
export type WebinarDown =
  | { t: 'registration'; status: 'pending' | 'rejected'; name: string; title: string; startsAt: number }
  | { t: 'webinar'; self: { deviceId: string; name: string }; live: WebinarLive; questions: WebinarQuestion[]; route: StageRoute; iceServers: IceServer[]; hand: boolean }
  /** Events (the same names and data the app gets: web.update, web.route, web.signal, web.promote, web.ended). */
  | { t: 'w'; name: string; data: unknown }
  | { t: 'file'; id: string; name: string; mime: string; size: number; chunks: number }
  | { t: 'fileChunk'; id: string; i: number; data: string }
  /** Invited to speak and accepted: the page opens the meeting page with a one-time pass. */
  | { t: 'speak'; url: string }
  | { t: 'denied'; reason: string }
  | { t: 'error'; message: string }
  | { t: 'pong' };

/** A changed piece of a webinar for everyone watching it (sent at most once a second). */
export interface WebinarUpdate {
  meetingId: string;
  live?: WebinarLive;
  questions?: WebinarQuestion[];
  /** Question ids that are gone (dismissed, for attendees). */
  removed?: string[];
  reactions?: Record<string, number>;
  /** Hosts only: the audience changed (reload the Audience tab). */
  audience?: number;
}

// ---------------------------------------------------------------- the protocol, extended
declare module './protocol.ts' {
  interface Ops {
    'web.create': { req: { title: string; description?: string; startsAt: number; durationMin: number; panelists?: string[]; settings?: Partial<WebinarSettings>; fields?: WebinarFieldInput[] }; res: WebinarInfo };
    'web.update': { req: { id: string; title?: string; description?: string; startsAt?: number; durationMin?: number; panelists?: string[]; settings?: Partial<WebinarSettings>; fields?: WebinarFieldInput[]; survey?: WebinarFieldInput[] }; res: WebinarInfo };
    'web.get': { req: { id: string }; res: WebinarInfo };
    'web.list': { req: void; res: WebinarCard[] };
    'web.state': { req: { id: string; state: 'live' | 'ended' }; res: WebinarInfo };
    'web.registrants': { req: { id: string }; res: Registrant[] };
    'web.decide': { req: { id: string; registrantIds: string[]; approve: boolean }; res: Registrant[] };
    'web.mail': { req: { id: string; kind: 'invite' | 'reminder'; registrantIds?: string[]; when: string }; res: WebinarMail[] };
    'web.watch': { req: { id: string }; res: { live: WebinarLive; questions: WebinarQuestion[]; route: StageRoute; hand: boolean } };
    'web.leave': { req: { id: string }; res: { ok: true } };
    'web.hand': { req: { id: string; up: boolean; deviceId?: string }; res: { ok: true } };
    'web.react': { req: { id: string; emoji: string }; res: { ok: true } };
    'web.questions': { req: { id: string }; res: WebinarQuestion[] };
    'web.ask': { req: { id: string; text: string; anonymous?: boolean }; res: WebinarQuestion };
    'web.vote': { req: { id: string; questionId: string; up: boolean }; res: WebinarQuestion };
    'web.answer': { req: { id: string; questionId: string; live?: boolean; text?: string }; res: WebinarQuestion };
    'web.moderate': { req: { id: string; questionId: string; action: 'dismiss' | 'reopen' | 'pin' | 'unpin' | 'stage' | 'unstage' }; res: WebinarQuestion };
    'web.poll.launch': { req: { id: string; question: string; options: string[]; multi?: boolean; showResults?: boolean }; res: WebinarPoll };
    'web.poll.vote': { req: { id: string; pollId: string; choices: number[] }; res: WebinarPoll };
    'web.poll.close': { req: { id: string; pollId: string; showResults?: boolean }; res: WebinarPoll };
    'web.polls': { req: { id: string }; res: WebinarPoll[] };
    'web.handout.add': { req: { id: string; fileId: string }; res: Handout[] };
    'web.handout.remove': { req: { id: string; handoutId: string }; res: Handout[] };
    'web.handout.open': { req: { id: string; handoutId: string }; res: { fileId: string; name: string } };
    'web.audience': { req: { id: string }; res: AudienceMember[] };
    'web.promote': { req: { id: string; deviceId: string }; res: { ok: true } };
    'web.promoteAnswer': { req: { id: string; accept: boolean }; res: { ok: true; meetingId?: string } };
    'web.demote': { req: { id: string; userId: string }; res: { ok: true } };
    'web.signal': { req: { id: string; toDevice: string; data: unknown }; res: { ok: true } };
    'web.stream.set': { req: { id: string; url?: string; key?: string; watchUrl?: string }; res: WebinarInfo };
    'web.stream.start': { req: { id: string }; res: StreamStatus };
    'web.stream.stop': { req: { id: string }; res: StreamStatus };
    'web.stream.status': { req: { id: string }; res: StreamStatus };
    'web.stream.chunk': { req: { id: string; seq: number; data: string }; res: { ok: true } };
    'web.followup': { req: { id: string; note: string; recordingId?: string | null; outsideLink?: string | null; survey?: WebinarFieldInput[]; when: string }; res: { sentInApp: number; mails: WebinarMail[] } };
    'web.survey': { req: { id: string }; res: { title: string; fields: WebinarField[]; answered: boolean } };
    'web.survey.answer': { req: { id: string; answers: FieldAnswers }; res: { ok: true } };
    'web.report': { req: { id: string }; res: WebinarReport };
    /** Where the hub finds ffmpeg for live streams (administrators set a path). */
    'web.ffmpeg': { req: { path?: string | null } | void; res: { found: boolean; path: string | null; version: string | null; encoder: string | null; configured: string | null } };
  }
  interface Events {
    'web.update': WebinarUpdate;
    /** To one viewer: how they get the stage now. */
    'web.route': { meetingId: string; route: StageRoute; broadcaster: string | null };
    /** To the PC composing the stage: the viewers it sends to directly. */
    'web.viewers': { meetingId: string; viewers: Array<{ deviceId: string; name: string }>; relay: boolean; live: boolean; stream: boolean; /** A new number: record the live stream afresh. */ epoch: number };
    'web.signal': { meetingId: string; fromDevice: string; data: unknown };
    /** To an attendee: the organiser invites you to speak. */
    'web.promote': { meetingId: string; by: string };
    /** To someone who was invited to speak: back to the audience. */
    'web.demoted': { meetingId: string };
    'web.ended': { meetingId: string };
    'web.registered': { meetingId: string; registrant: Registrant };
    'web.streamStatus': { meetingId: string; status: StreamStatus };
  }
}


declare module './meet.ts' {
  interface MeetingReport {
    /** A webinar's own part: registrants, attendance, questions, polls, handouts and the survey. */
    webinar?: WebinarReport;
  }
}

/** A meeting report of a webinar, with its own part (the same type: MeetingReport carries it). */
export type WebinarMeetingReport = MeetingReport;
