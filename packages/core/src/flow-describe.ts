// Describe-to-Automation: plain words in, a proposed rule graph out. The words are split into a
// trigger clause ("when …"), condition clauses ("only during office hours") and action clauses
// ("then notify …"), in order. Which kind of trigger or action each clause is comes from a
// ranker: keyword cues here, blended with a small on-device sentence model when the app has
// one loaded (it passes `rank`). Everything specific (conversations, people, groups, file types,
// reactions, quoted words, times, web addresses) is found deterministically and resolved
// against the office's own lists. Nothing here runs a rule: the result is a draft for a person
// to check, with a confidence for each node and the parts it could not fill marked.
import type { ActionKind, ActionNode, ConditionKind, ConditionNode, FlowGraph, PersonRef, TriggerKind, TriggerNode } from './flows.ts';

export interface DescribeContext {
  conversations: Array<{ id: string; name: string; kind: 'space' | 'direct' }>;
  people: Array<{ id: string; name: string; account?: string }>;
  groups: Array<{ id: string; name: string }>;
  meId: string;
  /** The conversation the panel was opened from; null in the Control room (office-wide). */
  convId: string | null;
}

/** Similarity (any scale; higher is closer) between a clause and each candidate's example phrases. */
export type Ranker = (clause: string, candidates: Array<{ kind: string; examples: string[] }>) => Promise<number[]>;

export interface DraftNode {
  /** 0 to 1: how sure the drafter is about this node. */
  confidence: number;
  /** Fields the person needs to fill or check (e.g. "to", "emoji", "url", "conversation"). */
  missing: string[];
  /** The words this node came from. */
  source: string;
}

export interface DraftFlow {
  name: string;
  /** The conversation the rule watches; null for office-wide. */
  convId: string | null;
  graph: FlowGraph;
  nodes: Record<string, DraftNode>;
  notes: string[];
  method: 'model' | 'keywords';
}

// ------------------------------------------------------------------ examples for the sentence model
export const TRIGGER_EXAMPLES: Record<TriggerKind, string[]> = {
  'file.added': ['someone uploads a file', 'a PDF is attached to a message', 'a new drawing is shared', 'a document is posted in the channel', 'someone attaches a spreadsheet'],
  'reaction.added': ['someone reacts with an emoji', 'a message gets a thumbs up', 'someone adds a tick reaction', 'a message is stamped with a check mark'],
  'response.confirmed': ['someone votes in a poll', 'a form is submitted', 'someone answers the form', 'someone picks an option in a poll'],
  'message.matched': ['a message contains a keyword', 'someone writes the word urgent', 'a message says a particular phrase', 'the text matches a pattern'],
  'message.mentioned': ['someone mentions a person', 'a message mentions me', 'someone tags a colleague with @', 'a team is mentioned in a message'],
};
export const ACTION_EXAMPLES: Record<ActionKind, string[]> = {
  notify: ['notify a person', 'tell the team', 'send a direct message to someone', 'alert the group', 'let them know'],
  post: ['post a message in a channel', 'announce it in a space', 'share a note in the conversation', 'write in another channel'],
  task: ['create a task for someone', 'remind someone later', 'set a reminder', 'add a to-do on their desk', 'assign a follow-up'],
  tag: ['tag the message', 'add a hashtag', 'label the message', 'mark it with a tag'],
  webhook: ['call a webhook', 'send the details to a URL', 'post to an API endpoint', 'trigger an outside system'],
  extract: ['extract the title and revision', 'read the drawing title block', 'get the PDF title', 'pull the revision number from the file'],
};
export const CONDITION_EXAMPLES: Record<ConditionKind, string[]> = {
  time: ['during office hours', 'on weekdays between nine and six', 'outside working hours', 'only at the weekend'],
  author: ['only from a certain person', 'only when someone in the team posts it', 'except for one person'],
  file: ['only PDF files', 'only files named like a pattern', 'only drawings'],
  conversation: ['only in these channels', 'only in the design space'],
};

// ------------------------------------------------------------------ small text tools
const STOP = new Set(['the', 'a', 'an', 'of', 'and', '&', 'for', 'to']);
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
const bigrams = (s: string): string[] => { const out: string[] = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  const pool = [...B];
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length);
}
const sameWord = (a: string, b: string): boolean => a === b || a === `${b}s` || b === `${a}s` || (a.length >= 5 && b.length >= 5 && dice(a, b) >= 0.8);

const EMOJI_NAMES: Array<[RegExp, string]> = [
  [/\b(thumbs?[ -]?up|\+1|like)\b/i, '👍'], [/\b(thumbs?[ -]?down|-1)\b/i, '👎'],
  [/\b(green )?(tick|check ?mark|checkmark|check|done mark)\b/i, '✅'], [/\b(red )?(cross|x ?mark)\b/i, '❌'],
  [/\b(heart|love)\b/i, '❤️'], [/\beyes\b/i, '👀'], [/\bfire\b/i, '🔥'], [/\bstar\b/i, '⭐'],
  [/\b(red )?flag\b/i, '🚩'], [/\bwarning( sign)?\b/i, '⚠️'], [/\brocket\b/i, '🚀'], [/\b(push)?pin\b/i, '📌'],
  [/\bclap(ping)?\b/i, '👏'], [/\bquestion( mark)?\b/i, '❓'], [/\b(party|tada|celebrat\w*)\b/i, '🎉'],
  [/\bhundred|💯/i, '💯'], [/\bok hand\b/i, '👌'], [/\b(stop sign|no entry)\b/i, '⛔'], [/\bbell\b/i, '🔔'], [/\bhourglass\b/i, '⏳'],
];

const FILE_WORDS: Array<[RegExp, string[], number]> = [
  [/\bpdfs?\b/i, ['pdf'], 1], [/\b(dwgs?|autocad)\b/i, ['dwg'], 1], [/\bdxfs?\b/i, ['dxf'], 1],
  [/\b(xlsx|excel( files?| sheets?)?|spreadsheets?|workbooks?)\b/i, ['xlsx', 'xls', 'csv'], 0.9], [/\bcsvs?\b/i, ['csv'], 1],
  [/\b(docx|word (files?|documents?))\b/i, ['docx', 'doc'], 0.9], [/\b(images?|photos?|pictures?|screenshots?|jpe?gs?|pngs?)\b/i, ['png', 'jpg', 'jpeg'], 0.85],
  [/\b(zips?|archives?)\b/i, ['zip'], 0.9], [/\bifcs?\b/i, ['ifc'], 1], [/\b(rvt|revit)\b/i, ['rvt'], 1], [/\b(nwd|navisworks)\b/i, ['nwd'], 1],
  [/\b(step|stp) files?\b/i, ['step', 'stp'], 0.9], [/\bdrawings?\b/i, ['pdf', 'dwg', 'dxf'], 0.6],
];

const VERB = String.raw`(?:notify|tell|alert|inform|ping|message|dm|send|post|announce|share|write|put|create|add|make|set|remind|assign|tag|label|mark|call|hit|trigger|extract|read|pull|grab|get|find|capture|let|give|log|record|forward|open|raise)`;
const COND = String.raw`(?:only|but only|except|unless|during|between|outside|on weekdays|on weekends|provided)`;
const OPENER = /^(?:and\s+)?(when(?:ever)?|if|once|each time|every time|any ?time|as soon as|after|on)\b\s*/i;

interface Spans { quotes: string[]; urls: string[]; regexes: string[] }

/** Take quoted words, web addresses and /patterns/ out of the text so commas inside them do not split it. */
function protect(text: string): { text: string; spans: Spans } {
  const spans: Spans = { quotes: [], urls: [], regexes: [] };
  let t = text.replace(/https?:\/\/[^\s"'<>]+/gi, (u) => { const clean = u.replace(/[.,;:!?)]+$/, ''); spans.urls.push(clean); return `⟦u${spans.urls.length - 1}⟧${u.slice(clean.length)}`; });
  t = t.replace(/(?<=^|\s)\/((?:\\.|[^/\s\\])(?:\\.|[^/\\])*?)\/(?=[\s,.;]|$)/g, (m, body: string) => {
    if (!/[\\^$.*+?()[\]{}|]/.test(body)) return m;
    spans.regexes.push(body);
    return `⟦r${spans.regexes.length - 1}⟧`;
  });
  t = t.replace(/"([^"]{1,200})"|“([^”]{1,200})”|(?<![\p{L}\p{N}])'([^']{1,120})'(?![\p{L}\p{N}])|‘([^’]{1,120})’/gu, (_m, a?: string, b?: string, c?: string, d?: string) => {
    spans.quotes.push((a ?? b ?? c ?? d ?? '').trim());
    return `⟦q${spans.quotes.length - 1}⟧`;
  });
  return { text: t, spans };
}
const quotesIn = (seg: string, spans: Spans): string[] => [...seg.matchAll(/⟦q(\d+)⟧/g)].map((m) => spans.quotes[Number(m[1])]).filter(Boolean);
const restore = (seg: string, spans: Spans): string => seg
  .replace(/⟦q(\d+)⟧/g, (_m, i: string) => `“${spans.quotes[Number(i)]}”`)
  .replace(/⟦u(\d+)⟧/g, (_m, i: string) => spans.urls[Number(i)])
  .replace(/⟦r(\d+)⟧/g, (_m, i: string) => `/${spans.regexes[Number(i)]}/`);

/** Split the description into clauses, in the order they were written. */
export function clauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|;\s*|\n+/)) {
    const s = sentence.trim().replace(/[.!?]+$/, '');
    if (!s) continue;
    const parts = s
      .split(new RegExp(String.raw`,?\s+(?:and\s+)?then\s+|,\s*(?:and\s+)?(?=(?:also\s+)?${VERB}\b|${COND}\b)|\s+and\s+(?=(?:also\s+)?${VERB}\b)|(?<!\bbut),?\s+(?=(?:but\s+)?only\b)|\s+(?=(?:whenever|when|each time|every time|as soon as)\s)`, 'i'))
      .map((p) => p.trim().replace(/^(and|then|also|,)\s+/i, '').replace(/,$/, '').trim())
      .filter((p) => p && !/^(and|but|then|also|or)$/i.test(p));
    out.push(...parts);
  }
  return out;
}

// ------------------------------------------------------------------ finding names
interface Hit { id: string; name: string; score: number; start: number; end: number }

/** Where a known name appears in the clause (fuzzy, word by word), best first. */
function findNames(clause: string, list: Array<{ id: string; name: string; account?: string }>, opts: { firstName?: boolean; drop?: RegExp } = {}): Hit[] {
  const ws = words(clause);
  const hits: Hit[] = [];
  for (const item of list) {
    const tokens = words(item.name).filter((w) => !STOP.has(w) && !(opts.drop?.test(w)));
    if (!tokens.length) continue;
    const variants: Array<{ toks: string[]; score: number }> = [{ toks: tokens, score: 1 }];
    if (opts.firstName && tokens.length > 1) variants.push({ toks: [tokens[0]], score: 0.85 });
    const user = item.account?.split('\\').pop()?.toLowerCase();
    if (user) variants.push({ toks: words(user.replace(/[._]/g, ' ')), score: 0.9 });
    for (const v of variants) {
      for (let i = 0; i + v.toks.length <= ws.length; i++) {
        let ok = true;
        for (let k = 0; k < v.toks.length && ok; k++) ok = sameWord(ws[i + k], v.toks[k]);
        if (ok) hits.push({ id: item.id, name: item.name, score: v.score * (v.toks.every((t, k) => t === ws[i + k]) ? 1 : 0.92), start: i, end: i + v.toks.length });
      }
    }
  }
  // the longest, surest match wins where they overlap
  hits.sort((a, b) => b.score * (b.end - b.start) - a.score * (a.end - a.start) || b.score - a.score);
  const taken: Hit[] = [];
  for (const h of hits) if (!taken.some((t) => h.start < t.end && t.start < h.end) && !taken.some((t) => t.id === h.id)) taken.push(h);
  return taken;
}

const CONV_WORDS = /^(channel|space|room|conversation|chat|thread)s?$/;
const GROUP_WORDS = /^(group|team|department|dept|people|folks|squad|unit|section|reviewers?)$/;

interface Found { convs: Hit[]; groups: Hit[]; people: Hit[]; roles: Array<'author' | 'actor' | 'owner'>; me: boolean; unknownConv: string | null; unknownGroup: string | null }

/** People, groups and conversations named in a clause (a word before or after tells them apart). */
function findEntities(clause: string, ctx: DescribeContext): Found {
  const ws = words(clause);
  const before = (h: Hit) => ws.slice(Math.max(0, h.start - 2), h.start);
  const after = (h: Hit) => ws[h.end] ?? '';
  const spaces = ctx.conversations.filter((c) => c.kind === 'space');
  const convHits = findNames(clause, spaces, { drop: CONV_WORDS });
  const groupHits = findNames(clause, ctx.groups, { drop: GROUP_WORDS });
  const peopleHits = findNames(clause, ctx.people, { firstName: true });
  const convs: Hit[] = [];
  const groups: Hit[] = [];
  const people: Hit[] = [];
  const overlaps = (a: Hit, list: Hit[]) => list.some((b) => a.start < b.end && b.start < a.end);
  const hashed = (h: Hit) => new RegExp(`#${ws[h.start]}`, 'i').test(clause);
  for (const h of convHits) {
    const conv = CONV_WORDS.test(after(h)) || before(h).some((w) => ['in', 'into', 'to', 'on', 'inside', 'from', 'at'].includes(w)) || hashed(h);
    if (GROUP_WORDS.test(after(h))) continue;
    if (conv) convs.push(h);
  }
  for (const h of groupHits) {
    if (overlaps(h, convs)) continue;
    if (h.score < 0.9 && !GROUP_WORDS.test(after(h))) continue;
    groups.push(h);
  }
  for (const h of peopleHits) {
    if (overlaps(h, convs) || overlaps(h, groups)) continue;
    // a first name alone must point to one person
    if (h.score < 0.9 && peopleHits.filter((o) => o.start === h.start && o.score === h.score).length > 1) continue;
    people.push(h);
  }
  const roles: Found['roles'] = [];
  if (/\b(the (uploader|author|sender|poster)|whoever (posted|uploaded|wrote|sent|shared)( it)?|the person who (posted|uploaded|wrote|sent|shared)( it)?|(him|her) back)\b/i.test(clause)) roles.push('author');
  if (/\b(whoever (reacted|voted|answered|responded|submitted)|the (voter|responder|person who (reacted|voted|answered|responded)))\b/i.test(clause)) roles.push('actor');
  const me = /(^|[^\p{L}])(me|myself|my desk|i)([^\p{L}]|$)/iu.test(clause.replace(/⟦[qur]\d+⟧/g, ''));
  let unknownConv: string | null = null;
  if (!convs.length) {
    const m = /\b(?:in|into|to|on)\s+(?:the\s+)?(#?[\p{L}\p{N}][\p{L}\p{N} &'-]{0,40}?)\s+(?:channel|space|room)\b/iu.exec(clause) ?? /(?:^|\s)#([\p{L}][\p{L}\p{N}_-]{1,40})\s+(?:channel|space)\b/iu.exec(clause);
    if (m) unknownConv = m[1].replace(/^#/, '');
  }
  let unknownGroup: string | null = null;
  if (!groups.length) {
    const m = /\b(?:the\s+)([\p{L}][\p{L} &'-]{1,40}?)\s+(?:group|team|department)\b/iu.exec(clause);
    if (m && !convs.length) unknownGroup = m[1];
  }
  return { convs, groups, people, roles, me, unknownConv, unknownGroup };
}

// ------------------------------------------------------------------ ranking
type Cue = [RegExp, number];
const TRIGGER_CUES: Record<TriggerKind, Cue[]> = {
  'file.added': [[/\b(upload(s|ed|ing)?|attach(es|ed|ing|ment|ments)?|drops?|dropped|adds? a (file|pdf|drawing|document|dwg|sheet)|(shares?|shared|posts?|posted|sends?|sent|puts?) (a |an |the |any |new )*(file|pdf|drawing|document|dwg|dxf|spreadsheet|sheet|image|photo|revision)s?|new (file|pdf|drawing|document|revision)s?)\b/i, 3], [/\b(pdfs?|dwgs?|dxfs?|files?|drawings?|documents?|spreadsheets?|excel|images?|photos?|ifc|zip)\b/i, 1.2]],
  'reaction.added': [[/\breact(s|ed|ing|ion|ions)?\b/i, 3], [/\p{Extended_Pictographic}/u, 2], [/\b(thumbs?[ -]?up|tick|check ?mark|stamps?|stamped|emoji)\b/i, 1.5]],
  'response.confirmed': [[/\b(votes?|voted|voting|poll|polls|form|forms|answers?|answered|responds?|responded|responses?|submits?|submitted|submission|picks?|picked|chooses?|chose|rsvps?)\b/i, 3]],
  'message.matched': [[/\b(says?|said|saying|contains?|containing|includes?|including|writes?|wrote|keywords?|words?|phrases?|matches|matching|pattern|regex|text)\b/i, 2], [/⟦q\d+⟧/, 2.5], [/⟦r\d+⟧/, 3.5]],
  'message.mentioned': [[/\b(mention(s|ed|ing)?|@-?mentions?)\b/i, 3], [/(^|\s)@[\p{L}]/u, 2], [/\btags? (me|someone|a colleague)\b/i, 1.5]],
};
const ACTION_CUES: Record<ActionKind, Cue[]> = {
  extract: [[/\b(extract|read|pull|grab|get|find|capture|fetch)\b[^.]*\b(title|revision|rev|number|title ?block)s?\b/i, 4], [/\btitle ?block\b/i, 2], [/\b(title|revision)s?\b/i, 1]],
  notify: [[/\b(notify|tell|alert|inform|ping|dm|let\b[^.]*\bknow|direct message|warn)\b/i, 3], [/\b(message|send|email|forward)\b/i, 1.2]],
  post: [[/\b(post|announce|share|write|put|publish|drop)\b/i, 2], [/\b(post|announce|write|share) (it |a (message|note|summary) )?(in|into|to|on)\b/i, 1.5], [/\b(here|this (channel|space|conversation))\b/i, 1]],
  task: [[/\b(remind(er)?s?|tasks?|to-?dos?|follow[- ]?ups?|assign|desk)\b/i, 3.5]],
  tag: [[/\b(tag|label|hashtag|mark) (it|the message|them|this)\b/i, 3], [/(^|\s)#[\p{L}]/u, 2.5], [/\b(tag|label|hashtag)\b/i, 1.5]],
  webhook: [[/⟦u\d+⟧/, 3.5], [/\b(webhook|endpoint|api|url|web address|hit|call)\b/i, 2.5]],
};
const CONDITION_CUES: Record<ConditionKind, Cue[]> = {
  time: [[/\b(office|working|work|business) hours\b|\bafter hours\b|\bweekdays?\b|\bweekends?\b|\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\bbetween \d|\b(before|after) \d|\bnights?\b|\bmornings?\b/i, 3]],
  author: [[/\b(from|by|except|unless|not) /i, 1.5], [/\b(posted|uploaded|written|sent|shared) by\b/i, 2]],
  file: [[/\b(pdfs?|dwgs?|files?|named|called|name)\b/i, 2]],
  conversation: [[/\b(channels?|spaces?|conversations?)\b/i, 2]],
};

function cueScores<K extends string>(clause: string, cues: Record<K, Cue[]>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of Object.keys(cues) as K[]) out[k] = cues[k].reduce((s: number, [re, w]: Cue) => s + (re.test(clause) ? w : 0), 0);
  return out;
}

const softmax = (xs: number[], temp: number): number[] => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp((x - m) / temp));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
};

interface Ranked<K> { kind: K; p: number; margin: number }

async function rank<K extends string>(clause: string, cues: Record<K, Cue[]>, examples: Record<K, string[]>, ranker: Ranker | null, adjust: Partial<Record<K, number>> = {}): Promise<{ ranked: Ranked<K>; usedModel: boolean }> {
  const kinds = Object.keys(cues) as K[];
  const kw = cueScores(clause, cues);
  for (const k of kinds) kw[k] = Math.max(0, kw[k] + (adjust[k] ?? 0));
  const kwSum = kinds.reduce((s, k) => s + kw[k], 0);
  let probs = kinds.map((k) => (kwSum > 0 ? kw[k] / kwSum : 1 / kinds.length));
  let usedModel = false;
  if (ranker) {
    try {
      const sims = await ranker(clause.replace(/⟦q\d+⟧/g, '"…"').replace(/⟦u\d+⟧/g, 'a web address').replace(/⟦r\d+⟧/g, 'a pattern'), kinds.map((k) => ({ kind: k, examples: examples[k] })));
      if (sims.length === kinds.length && sims.every((x) => Number.isFinite(x))) {
        const model = softmax(sims, 0.05);
        probs = kwSum > 0 ? probs.map((p, i) => 0.6 * p + 0.4 * model[i]) : model;
        usedModel = true;
      }
    } catch { /* the keyword ranking stands */ }
  }
  const order = kinds.map((k, i) => ({ k, p: probs[i] })).sort((a, b) => b.p - a.p);
  return { ranked: { kind: order[0].k, p: order[0].p, margin: order[0].p - (order[1]?.p ?? 0) }, usedModel };
}

const confidenceOf = (r: Ranked<string>, cueHit: boolean) => Math.max(0.05, Math.min(0.99, (cueHit ? 0.55 : 0.3) + r.margin * 0.6 + (r.p > 0.6 ? 0.1 : 0)));

// ------------------------------------------------------------------ slots
function fileTypes(raw: string): { types: string[]; sure: number } | null {
  // the words of a name pattern ("named like *-IFC-*") are not file types
  const clause = raw.replace(/\b(?:named|called)\s+(?:like\s+)?\S+|\bnames?\s+(?:that\s+)?(?:starts?|begins?|starting|beginning|ends?|ending|contains?|containing|includes?|including|with)\s+(?:with\s+|in\s+)?\S+/gi, ' ');
  const explicit = [...clause.matchAll(/(?:^|\s)\.([a-z0-9]{2,5})\b/gi)].map((m) => m[1].toLowerCase());
  const found: string[] = [...explicit];
  let sure = explicit.length ? 1 : 0;
  for (const [re, types, s] of FILE_WORDS) if (re.test(clause)) { found.push(...types); sure = Math.max(sure, s); }
  // "drawing" adds nothing when a precise type is also named
  const precise = FILE_WORDS.filter(([re, , s]) => s >= 0.85 && re.test(clause)).flatMap(([, t]) => t);
  const types = [...new Set(precise.length || explicit.length ? [...explicit, ...precise] : found)];
  return types.length ? { types, sure } : null;
}

function namePattern(clause: string, spans: Spans): string | null {
  const q = (s: string) => s.replace(/⟦q(\d+)⟧/g, (_m, i: string) => spans.quotes[Number(i)]);
  let m = /\b(?:named|called)\s+(?:like\s+)?(⟦q\d+⟧|[\w*?.-]*[*?][\w*?.-]*)/i.exec(clause);
  if (m) return q(m[1]);
  m = /\bnames?\s+(?:that\s+)?(?:starts?|begins?|starting|beginning)\s+with\s+(⟦q\d+⟧|[\w.-]+)/i.exec(clause);
  if (m) return `${q(m[1])}*`;
  m = /\bnames?\s+(?:that\s+)?(?:ends?|ending)\s+(?:with|in)\s+(⟦q\d+⟧|[\w.-]+)/i.exec(clause);
  if (m) return `*${q(m[1])}`;
  m = /\bnames?\s+(?:that\s+)?(?:contains?|containing|includes?|including|with)\s+(⟦q\d+⟧|[\w.-]+)/i.exec(clause);
  if (m) return q(m[1]);
  return null;
}

function emojiIn(clause: string): string | null {
  const custom = /:([a-z0-9][a-z0-9_-]{1,31}):/i.exec(clause);
  if (custom) return `:${custom[1].toLowerCase()}:`;
  const e = /(\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|️|\p{Emoji_Modifier})*)/u.exec(clause);
  if (e) return e[1];
  for (const [re, emoji] of EMOJI_NAMES) if (re.test(clause)) return emoji;
  return null;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
function clock(raw: string): { h: number; m: number; ampm: boolean } | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, m: min, ampm: !!ap };
}

/** "during office hours", "on weekdays between 9 and 6", "after 6pm", "at the weekend". */
export function timeCondition(text: string): Omit<Extract<ConditionNode, { kind: 'time' }>, 'id'> | null {
  const t = text.toLowerCase();
  let days: number[] | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let outside = false;
  if (/\b(outside|out of|after|beyond) (the )?(office|working|work|business) hours\b|\bafter hours\b|\bout of hours\b/.test(t)) { days = [1, 2, 3, 4, 5]; from = '09:00'; to = '18:00'; outside = true; }
  else if (/\b(office|working|work|business) hours\b/.test(t)) { days = [1, 2, 3, 4, 5]; from = '09:00'; to = '18:00'; }
  if (/\bweekdays?\b|\bmonday to friday\b|\bmon-fri\b/.test(t)) days = [1, 2, 3, 4, 5];
  if (/\b(weekends?|saturdays? and sundays?)\b/.test(t)) days = [0, 6];
  const named = [...t.matchAll(/\b(sun|mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?)(day)?s?\b/g)].map((m) => DAY_NAMES.indexOf(m[1].slice(0, 3)));
  if (named.length && !/\bweekdays?\b|\bweekends?\b|\bmonday to friday\b/.test(t)) days = [...new Set(named.filter((d) => d >= 0))].sort();
  const between = /\b(?:between|from)\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s+(?:and|to|till|until|-)\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/i.exec(t);
  if (between) {
    const a = clock(between[1]);
    const b = clock(between[2]);
    if (a && b) {
      // "between 9 and 6" means 9 in the morning to 6 in the evening
      if (!b.ampm && b.h <= 12 && (b.h < a.h || (b.h === a.h && b.m <= a.m))) b.h += 12;
      from = hhmm(a.h, a.m); to = hhmm(b.h % 24, b.m);
    }
  }
  const afterM = /\bafter\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)(?!\s*(?:minutes?|hours?|days?))/i.exec(t);
  if (afterM && !between) { const a = clock(afterM[1]); if (a) { if (!a.ampm && a.h < 8) a.h += 12; from = hhmm(a.h, a.m); to = '00:00'; } }
  const beforeM = /\bbefore\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)(?!\s*(?:minutes?|hours?|days?))/i.exec(t);
  if (beforeM && !between) { const b = clock(beforeM[1]); if (b) { from = '00:00'; to = hhmm(b.h, b.m); } }
  if (/\b(at )?night\b/.test(t) && !from) { from = '20:00'; to = '07:00'; }
  if (!days && !from) return null;
  return { kind: 'time', days: days ?? [0, 1, 2, 3, 4, 5, 6], from: from ?? '00:00', to: to ?? from ?? '00:00', ...(outside ? { outside: true } : {}) };
}

function dueMinutes(clause: string): number | null {
  const m = /\bin\s+(an?|one|two|three|four|five|six|\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i.exec(clause);
  if (m) {
    const nums: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = nums[m[1].toLowerCase()] ?? Number(m[1]);
    const unit = m[2].toLowerCase();
    return n * (unit.startsWith('w') ? 10080 : unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1);
  }
  if (/\btomorrow\b/i.test(clause)) return 1440;
  if (/\bnext week\b/i.test(clause)) return 10080;
  if (/\b(later today|this afternoon)\b/i.test(clause)) return 240;
  return null;
}

// ------------------------------------------------------------------ the draft
const person = (id: string): PersonRef => ({ kind: 'user', id });

export async function draftFlow(description: string, ctx: DescribeContext, ranker: Ranker | null = null): Promise<DraftFlow> {
  const original = description.replace(/\s+/g, ' ').trim().slice(0, 800);
  const { text, spans } = protect(original);
  const parts = clauses(text);
  const notes: string[] = [];
  const nodes: Record<string, DraftNode> = {};
  let usedModel = false;

  // which clause starts it all
  let triggerAt = parts.findIndex((p) => OPENER.test(p));
  if (triggerAt < 0) {
    const scored = parts.map((p) => Object.values(cueScores(p, TRIGGER_CUES)).reduce((a, b) => a + b, 0) - Object.values(cueScores(p, ACTION_CUES)).reduce((a, b) => a + b, 0));
    triggerAt = scored.length ? scored.indexOf(Math.max(...scored)) : -1;
  }
  const triggerText = triggerAt >= 0 ? parts[triggerAt].replace(OPENER, '') : text;
  const rest = parts.filter((_, i) => i !== triggerAt);
  const isCond = (p: string) => new RegExp(`^(?:but\\s+)?${COND}\\b|^(?:if|when) (?:it(?:'s| is)|the file|the message)\\b`, 'i').test(p) || /\bonly$/i.test(p);
  const condTexts = rest.filter(isCond);
  const actionTexts = rest.filter((p) => !isCond(p));

  // ---- trigger
  const tEnt = findEntities(triggerText, ctx);
  const adjust: Partial<Record<TriggerKind, number>> = {};
  // "mentions 'urgent'" is about words; "mentions Priya" is about a person
  if (/\bmention(s|ed)?\s+(the word|⟦q)/i.test(triggerText)) { adjust['message.matched'] = 3; adjust['message.mentioned'] = -3; }
  if (/\bmention/i.test(triggerText) && (tEnt.people.length || tEnt.groups.length || tEnt.me)) adjust['message.mentioned'] = (adjust['message.mentioned'] ?? 0) + 1.5;
  const tr = await rank(triggerText, TRIGGER_CUES, TRIGGER_EXAMPLES, ranker, adjust);
  usedModel ||= tr.usedModel;
  const tKind = tr.ranked.kind;
  const tMissing: string[] = [];
  let trigger: TriggerNode;
  const refsOf = (f: Found): PersonRef[] => [...f.people.map((h) => person(h.id)), ...f.groups.map((h): PersonRef => ({ kind: 'group', id: h.id })), ...(f.me ? [person(ctx.meId)] : [])];
  switch (tKind) {
    case 'file.added': {
      const ft = fileTypes(triggerText);
      const np = namePattern(triggerText, spans);
      trigger = { id: 't1', kind: 'file.added', ...(ft ? { types: ft.types } : {}), ...(np ? { namePattern: np } : {}) };
      break;
    }
    case 'reaction.added': {
      const emoji = emojiIn(restore(triggerText, spans));
      if (!emoji) tMissing.push('emoji');
      // "to a message from Priya" / "on Priya's messages": whose messages
      const byClause = /\b(?:messages?|posts?|notes?)\s+(?:from|by|written by)\s+(.+)$/i.exec(triggerText)?.[1] ?? /\b(.+?)['’]s\s+(?:messages?|posts?)\b/i.exec(triggerText)?.[1] ?? '';
      const by = byClause ? refsOf(findEntities(byClause, ctx)) : [];
      trigger = { id: 't1', kind: 'reaction.added', emoji: emoji ?? '', ...(by.length ? { by } : {}) };
      break;
    }
    case 'response.confirmed': {
      const q = quotesIn(triggerText, spans);
      const choice = q[0] ?? /\b(?:votes?|picks?|chooses?|answers?|selects?|says?)\s+(?:for\s+)?(yes|no|maybe|approved?|reject(?:ed)?|[A-Z][\w-]*)\b/.exec(restore(triggerText, spans))?.[1] ?? '';
      const source = /\bpoll/i.test(triggerText) || /\bvot/i.test(triggerText) ? 'poll' : /\bform|submi/i.test(triggerText) ? 'form' : 'any';
      trigger = { id: 't1', kind: 'response.confirmed', source, ...(choice ? { choice } : {}) };
      break;
    }
    case 'message.matched': {
      const q = quotesIn(triggerText, spans);
      const re = [...triggerText.matchAll(/⟦r(\d+)⟧/g)].map((m) => spans.regexes[Number(m[1])]);
      let pattern = '';
      let mode: 'keywords' | 'regex' = 'keywords';
      if (re.length) { pattern = re[0]; mode = 'regex'; }
      else if (q.length) pattern = q.join(', ');
      else {
        const w = /\b(?:the words?|keywords?|says?|contains?|containing|includes?|writes?|with)\s+([\p{L}\p{N}][\p{L}\p{N}-]{1,30}(?:\s*(?:,|or)\s*[\p{L}\p{N}][\p{L}\p{N}-]{1,30})*)/iu.exec(triggerText);
        if (w) pattern = w[1].split(/\s*(?:,|\bor\b)\s*/).filter((x) => !/^(a|an|the|it|something)$/i.test(x)).join(', ');
      }
      if (!pattern) tMissing.push('pattern');
      trigger = { id: 't1', kind: 'message.matched', mode, pattern };
      break;
    }
    case 'message.mentioned': {
      const handles = [...restore(triggerText, spans).matchAll(/@([\p{L}][\p{L}\p{N}._-]*)/gu)].map((m) => m[1]);
      const extra = handles.flatMap((h) => findEntities(h.replace(/[._]/g, ' '), ctx).people.map((p) => person(p.id)));
      const targets = [...refsOf(tEnt), ...extra].filter((r, i, all) => all.findIndex((x) => x.kind === r.kind && x.id === r.id) === i);
      if (!targets.length) tMissing.push('targets');
      trigger = { id: 't1', kind: 'message.mentioned', targets };
      break;
    }
  }
  nodes.t1 = { confidence: confidenceOf(tr.ranked, Object.values(cueScores(triggerText, TRIGGER_CUES)).some((x) => x > 0)) * (tMissing.length ? 0.6 : 1), missing: tMissing, source: restore(triggerText, spans) };

  // ---- the conversation it watches
  let convId = ctx.convId;
  const named = tEnt.convs;
  const conditions: ConditionNode[] = [];
  if (named.length === 1) convId = named[0].id;
  else if (named.length > 1) { convId = null; conditions.push({ id: `c${conditions.length + 1}`, kind: 'conversation', convIds: named.map((h) => h.id) }); nodes[conditions[conditions.length - 1].id] = { confidence: 0.85, missing: [], source: named.map((h) => h.name).join(', ') }; }
  if (!named.length && tEnt.unknownConv) {
    notes.push(`No Space called “${tEnt.unknownConv}” was found. Choose where the rule should watch.`);
    nodes.t1.missing.push('conversation');
    nodes.t1.confidence = Math.min(nodes.t1.confidence, 0.5);
  }

  // ---- conditions: who did it (the subject of the trigger clause, or "from …")
  const subject = /^(?:(?:someone|anyone|somebody|a person)\s+(?:in|from)\s+(.+?)|([\p{Lu}][\p{L}.]+(?:\s+[\p{Lu}][\p{L}]+)?))\s+(?:uploads?|attaches|shares?|posts?|sends?|reacts?|votes?|answers?|submits?|writes?|mentions?|says?|drops?|adds?)\b/u.exec(triggerText);
  const fromClause = /\b(?:from|by|posted by|uploaded by|sent by|shared by)\s+(?:(?:someone|anyone|somebody|a person|people)\s+(?:in|from)\s+)?(?!the\b|a\b|an\b)(.+?)(?=\s+(?:in|into|on|during|between|after|before|with|that|which|to)\b|$)/i.exec(triggerText);
  const authorText = subject?.[1] ?? subject?.[2] ?? (tKind !== 'reaction.added' ? fromClause?.[1] : undefined);
  if (authorText) {
    const f = findEntities(authorText, ctx);
    const refs = refsOf(f);
    if (refs.length) {
      const id = `c${conditions.length + 1}`;
      conditions.push({ id, kind: 'author', people: refs });
      nodes[id] = { confidence: 0.85, missing: [], source: authorText };
    }
  }
  for (const c of condTexts) {
    const cr = await rank(c, CONDITION_CUES, CONDITION_EXAMPLES, ranker);
    usedModel ||= cr.usedModel;
    const id = `c${conditions.length + 1}`;
    const exclude = /\b(except|unless|not from|not by|apart from)\b/i.test(c);
    const tc = timeCondition(c);
    const f = findEntities(c, ctx);
    if (tc) { conditions.push({ id, ...tc }); nodes[id] = { confidence: 0.9, missing: [], source: restore(c, spans) }; continue; }
    if (cr.ranked.kind === 'file' || fileTypes(c) || namePattern(c, spans)) {
      const ft = fileTypes(c);
      const np = namePattern(c, spans);
      if (ft || np) { conditions.push({ id, kind: 'file', ...(ft ? { types: ft.types } : {}), ...(np ? { namePattern: np } : {}) }); nodes[id] = { confidence: 0.85, missing: [], source: restore(c, spans) }; continue; }
    }
    if (f.convs.length) { conditions.push({ id, kind: 'conversation', convIds: f.convs.map((h) => h.id) }); nodes[id] = { confidence: 0.85, missing: [], source: restore(c, spans) }; continue; }
    const refs = refsOf(f);
    conditions.push({ id, kind: 'author', people: refs, ...(exclude ? { exclude: true } : {}) });
    nodes[id] = { confidence: refs.length ? 0.8 : 0.3, missing: refs.length ? [] : ['people'], source: restore(c, spans) };
  }
  // a time phrase inside the trigger clause ("… during office hours")
  const tTime = timeCondition(triggerText);
  if (tTime && !conditions.some((c) => c.kind === 'time')) {
    const id = `c${conditions.length + 1}`;
    conditions.push({ id, ...tTime });
    nodes[id] = { confidence: 0.9, missing: [], source: restore(triggerText, spans) };
  }

  // ---- actions, in order
  const actions: ActionNode[] = [];
  const hasExtract = () => actions.some((a) => a.kind === 'extract');
  const actorWord = tKind === 'reaction.added' || tKind === 'response.confirmed' ? 'actor' : 'author';
  const defaultText = (): string => {
    if (hasExtract()) return '{{author.name}} shared {{file.name}} in {{conversation.name}}.\nTitle: {{file.title}}\nRevision: {{file.revision}}';
    switch (tKind) {
      case 'file.added': return '{{author.name}} shared {{file.name}} in {{conversation.name}}.';
      case 'reaction.added': return '{{actor.name}} reacted {{reaction.emoji}} to {{author.name}}\'s message in {{conversation.name}}: {{message.text}}';
      case 'response.confirmed': return '{{actor.name}} chose “{{response.choice}}” in {{conversation.name}}.';
      case 'message.mentioned': return '{{author.name}} mentioned {{mention.names}} in {{conversation.name}}: {{message.text}}';
      default: return '{{author.name}} wrote in {{conversation.name}}: {{message.text}}';
    }
  };
  for (const raw of actionTexts) {
    const f = findEntities(raw, ctx);
    const adjustA: Partial<Record<ActionKind, number>> = {};
    const toPeople = f.people.length || f.groups.length || f.me || f.roles.length;
    if (f.convs.length && !toPeople) { adjustA.post = 2; adjustA.notify = -1; }
    if (toPeople && !f.convs.length) adjustA.notify = 1;
    if (/\b(remind|reminder|to-?do)\b/i.test(raw)) adjustA.notify = -2;
    const ar = await rank(raw, ACTION_CUES, ACTION_EXAMPLES, ranker, adjustA);
    usedModel ||= ar.usedModel;
    const cueHit = Object.values(cueScores(raw, ACTION_CUES)).some((x) => x > 0);
    if (!cueHit && (!ar.usedModel || ar.ranked.p < 0.45)) { notes.push(`“${restore(raw, spans)}” was not understood as a step; add it by hand if it is needed.`); continue; }
    const id = `a${actions.length + 1}`;
    const missing: string[] = [];
    const quoted = quotesIn(raw, spans);
    const refs: PersonRef[] = [...refsOf(f), ...f.roles.map((r): PersonRef => ({ kind: 'role', id: r }))];
    if (/\b(them|him|her)\b/i.test(raw) && !refs.length) refs.push({ kind: 'role', id: actorWord });
    switch (ar.ranked.kind) {
      case 'extract':
        actions.push({ id, kind: 'extract' });
        if (tKind !== 'file.added' && !conditions.some((c) => c.kind === 'file')) notes.push('Reading a title block needs a PDF on the message.');
        break;
      case 'notify':
        if (!refs.length) missing.push('to');
        if (f.unknownGroup && !f.groups.length) notes.push(`No group called “${f.unknownGroup}” was found. Choose who to notify.`);
        actions.push({ id, kind: 'notify', to: refs, text: quoted[0] ?? defaultText() });
        break;
      case 'post': {
        const here = /\b(here|this (channel|space|conversation)|the same (channel|space))\b/i.test(raw);
        const target = f.convs[0]?.id ?? null;
        if (!target && !here && f.unknownConv) { missing.push('convId'); notes.push(`No Space called “${f.unknownConv}” was found. Choose where to post.`); }
        actions.push({ id, kind: 'post', convId: target, text: quoted[0] ?? defaultText() });
        break;
      }
      case 'task': {
        const todo = /\b(to-?do|desk|keep)\b/i.test(raw) && !/\bremind/i.test(raw);
        if (!refs.length) refs.push(f.me || /\bme\b/i.test(raw) ? person(ctx.meId) : { kind: 'role', id: actorWord });
        const what = quoted[0] ?? /\bto\s+((?!do\b)[\p{L}].{2,120})$/iu.exec(raw.replace(/\b(in|within)\s+(an?|one|two|three|\d+)\s+(minutes?|hours?|days?|weeks?)\b|\btomorrow\b|\bnext week\b/gi, '').trim())?.[1];
        // "remind Ravi to check it": it is the file
        const said = what && (tKind === 'file.added' || hasExtract()) ? what.replace(/\b(it|the file|the drawing|the pdf)\b/i, '{{file.name}}') : what;
        const text = said ? said.charAt(0).toUpperCase() + said.slice(1) : hasExtract() ? 'Review {{file.name}} ({{file.title}}, revision {{file.revision}})' : tKind === 'file.added' ? 'Look at {{file.name}} from {{author.name}}' : 'Follow up on the message from {{author.name}}';
        actions.push({ id, kind: 'task', to: refs, text: todo ? '' : text, mode: todo ? 'todo' : 'reminder', dueInMinutes: dueMinutes(raw) ?? (todo ? 0 : 60) });
        break;
      }
      case 'tag': {
        const tag = /(?:^|\s)#([\p{L}][\p{L}\p{N}_-]{1,48})/u.exec(raw)?.[1] ?? quoted[0] ?? /\b(?:tag|label|mark)\s+(?:it|the message|this|them)\s+(?:as|with)\s+([\p{L}][\p{L}\p{N}_-]{1,48})/iu.exec(raw)?.[1] ?? '';
        if (!tag) missing.push('tag');
        actions.push({ id, kind: 'tag', tag: tag.toLowerCase().replace(/\s+/g, '-') });
        break;
      }
      case 'webhook': {
        const url = [...raw.matchAll(/⟦u(\d+)⟧/g)].map((m) => spans.urls[Number(m[1])])[0] ?? '';
        if (!url) missing.push('url');
        actions.push({ id, kind: 'webhook', url, body: '' });
        break;
      }
    }
    nodes[id] = { confidence: confidenceOf(ar.ranked, cueHit) * (missing.length ? 0.6 : 1), missing, source: restore(raw, spans) };
  }
  if (!actions.length) {
    notes.push('Nothing to do was found. Add a step, for example “then notify me”.');
    actions.push({ id: 'a1', kind: 'notify', to: [person(ctx.meId)], text: defaultText() });
    nodes.a1 = { confidence: 0.2, missing: ['to'], source: '' };
  }
  const graph: FlowGraph = { trigger, conditions: conditions.slice(0, 6), actions: actions.slice(0, 8) };
  return { name: draftName(graph, ctx, convId), convId, graph, nodes, notes, method: usedModel ? 'model' : 'keywords' };
}

function draftName(g: FlowGraph, ctx: DescribeContext, convId: string | null): string {
  const where = convId ? ctx.conversations.find((c) => c.id === convId)?.name : null;
  const t = g.trigger;
  const what = t.kind === 'file.added' ? `New ${t.types?.length ? t.types.slice(0, 2).map((x) => x.toUpperCase()).join('/') : 'file'}`
    : t.kind === 'reaction.added' ? `${t.emoji || 'Reaction'} on a message`
      : t.kind === 'response.confirmed' ? (t.choice ? `“${t.choice}” answers` : t.source === 'form' ? 'Form answers' : 'Poll votes')
        : t.kind === 'message.matched' ? (t.pattern ? `“${t.pattern.slice(0, 24)}” in a message` : 'Matching messages')
          : 'Mentions';
  const doing = g.actions.map((a) => a.kind === 'extract' ? 'read title block' : a.kind === 'notify' ? 'notify' : a.kind === 'post' ? 'post' : a.kind === 'task' ? (a.mode === 'todo' ? 'To do' : 'remind') : a.kind === 'tag' ? (a.tag ? `#${a.tag}` : 'tag') : 'webhook').join(', ');
  return `${what}${where ? ` in ${where}` : ''} → ${doing}`.slice(0, 80);
}
