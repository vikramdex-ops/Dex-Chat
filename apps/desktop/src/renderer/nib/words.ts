// Nib's voice: brief, warm, a little dry, in the words of a drawing office (docs/NIB.md §1).
// Each line is a whole sentence so it translates as one.
import type { NibItem, NibItemLite, NibMe, NibQty } from '@dex/core';
import { formatTime } from '../time.ts';

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** "18:15" as the person reads times. */
export function clockOf(date: string, hm: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return formatTime(new Date(y, (m || 1) - 1, d || 1, h || 0, mi || 0).getTime());
}
export const wrapTimeText = (me: NibMe) => clockOf(me.date, me.wrapAt);
export const digestTimeText = (me: NibMe) => clockOf(me.date, me.digestAt);

export function dayLabel(date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], opts);
}

/** The line at the top of the tray. */
export function greetingLine(me: NibMe, name: string, now = new Date()): string {
  const h = now.getHours();
  const open = me.items.filter((x) => x.status !== 'done').length;
  const done = me.items.length - open;
  if (me.leave && me.leave.from <= me.date && me.leave.to >= me.date) return 'You are on leave today. I’m keeping your desk.';
  if (!me.workday) return 'Not a workday. Nothing for me to ask you.';
  if (me.exempt) return h < 12 ? `Morning, ${name}. The register comes at ${digestTimeText(me)}.` : `The register comes at ${digestTimeText(me)}.`;
  if (me.day.state === 'sent') return me.day.changedAt ? 'Sent, and changed since. Your leads see the latest.' : 'Your sheet is sent. Pens down when you like.';
  if (me.day.state === 'nothing') return 'Nothing today. Fair enough.';
  if (!me.items.length) return h < 12 ? `Morning, ${name}. Your sheet is blank so far.` : 'Your sheet is blank so far. Tell me what came in.';
  if (open === 0) return done === 1 ? 'One item, done. Send it when you’re ready.' : `${done} items, all done. Send it when you’re ready.`;
  if (h < 12) return open === 1 ? `Morning, ${name}. One thing on your sheet.` : `Morning, ${name}. ${open} things on your sheet.`;
  return open === 1 ? `One thing still going. Wrap-up at ${wrapTimeText(me)}.` : `${open} things still going. Wrap-up at ${wrapTimeText(me)}.`;
}

const UNIT_WORDS: Record<string, [string, string]> = {
  sheets: ['sheet', 'sheets'], isos: ['iso', 'isos'], drawings: ['drawing', 'drawings'], GAs: ['GA', 'GAs'], MTOs: ['MTO', 'MTOs'], lines: ['line', 'lines'],
  spools: ['spool', 'spools'], supports: ['support', 'supports'], models: ['model', 'models'], 'mark-ups': ['mark-up', 'mark-ups'], nozzles: ['nozzle', 'nozzles'], hours: ['hour', 'hours'],
};
const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
/** "18 / 40 sheets", "12 isos", "60%", "4 hours". */
export function qtyWords(q: NibQty | null): string {
  if (!q) return '';
  if (q.unit === '%') return `${n(q.done ?? 0)}%`;
  const w = q.unit ? UNIT_WORDS[q.unit] ?? [q.unit, q.unit] : null;
  const count = q.total ?? q.done ?? 0;
  const unit = w ? ` ${count === 1 ? w[0] : w[1]}` : '';
  if (q.done !== null && q.total !== null && q.unit !== 'hours') return `${n(q.done)} / ${n(q.total)}${unit}`;
  return `${n(count)}${unit}`;
}
/** 0 to 1, or null when the item has no numbers. */
export function fractionOf(x: Pick<NibItem | NibItemLite, 'qty' | 'status'>): number | null {
  if (x.status === 'done') return 1;
  if (!x.qty || !x.qty.total || x.qty.unit === 'hours') return null;
  return Math.max(0, Math.min(1, (x.qty.done ?? 0) / x.qty.total));
}
export const STATUS_WORD: Record<string, string> = { going: 'Ongoing', done: 'Done', blocked: 'Blocked' };
export const LEAVE_WORD: Record<string, string> = { annual: 'Annual leave', sick: 'Sick leave', comp: 'Comp-off', half: 'Half day' };
