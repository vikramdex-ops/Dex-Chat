// The words of the bot network and the job sheet in the person's language. What a schedule
// means is worded here from the rule itself (day names from the language's own calendar), not
// from the hub's English. The hub's own lines about runs and hops are listed below so they are
// translated as they are drawn (the JSX runtime looks each one up whole, with its numbers).
import type { ScheduleRule } from '@dex/core/botjobs';
import { hm } from '@dex/core/botjobs';
import { tr } from '../../i18n/index.ts';

const fill = (pattern: string, ...xs: string[]) => tr(pattern).replace(/\{(\d)\}/g, (_m, n: string) => xs[Number(n)] ?? '');
/** A day of the week in the person's language (0 = Sunday). */
const dayName = (d: number) => new Date(Date.UTC(2026, 10, 15 + d)).toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' });
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : fill('{0} and {1}', xs.slice(0, -1).join(', '), xs[xs.length - 1]));

/** What a schedule means, in the person's language. */
export function scheduleWords(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'weekly':
      return rule.workdays ? fill('Every working day at {0}', list(rule.times.map(hm))) : fill('Every {0} at {1}', list(rule.days.map(dayName)), list(rule.times.map(hm)));
    case 'monthly': return fill('Each month on day {0} at {1} (the next working day when it is not one)', list(rule.dates.map((d) => (d === 31 ? tr('the last') : String(d)))), hm(rule.time));
    case 'edge':
      return rule.edge === 'first'
        ? fill(rule.working ? 'On the first working day of each month at {0}' : 'On the first day of each month at {0}', hm(rule.time))
        : fill(rule.working ? 'On the last working day of each month at {0}' : 'On the last day of each month at {0}', hm(rule.time));
    case 'interval': {
      const each = rule.every % 60 === 0 ? (rule.every === 60 ? tr('Every hour') : fill('Every {0} hours', String(rule.every / 60))) : fill('Every {0} minutes', String(rule.every));
      const days = rule.days ? list(rule.days.map(dayName)) : tr('working days');
      return rule.office ? fill('{0} in office hours, on {1}', each, days) : fill('{0} from {1} to {2}, on {3}', each, hm(rule.from), hm(rule.to), days);
    }
    case 'once': return fill('Once, on {0} at {1}', new Date(`${rule.date}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), hm(rule.time));
  }
}

/**
 * A line the hub wrote, in the person's language: each sentence is looked up on its own (the hub
 * puts several together: "Started for 6 people. 1 on leave was left out.").
 */
export function trLine(text: string): string {
  return text.split(/(?<=[.!?])\s+/).map((x) => {
    const t = tr(x);
    if (t !== x || !x.endsWith('.')) return t;
    const bare = tr(x.slice(0, -1));
    return bare !== x.slice(0, -1) ? `${bare}.` : x;
  }).join(' ');
}

/**
 * Lines the hub writes about runs, refusals and hops, kept here so they are listed for
 * translation (each sentence is looked up whole as it is drawn, numbers and names in place).
 */
export const HUB_WORDS = [
  'Started for 1 person.', 'Started for {0} people.', 'Reminded 1 person.', 'Reminded {0} people.',
  'Would start it for 1 person.', 'Would start it for {0} people.', 'Would remind 1 person.', 'Would remind {0} people.',
  '1 on leave was left out.', '{0} on leave were left out.', '1 was already answering it.', '{0} were already answering it.',
  'Skipped once, as asked.', 'Missed at {0}: the hub was off.', 'And {0} more runs missed while the hub was off.',
  'Caught up (due {0}, the hub was off).', 'Checked: {0}.', 'Nothing to tell.', 'Told {0}.', 'Posted to {0}.', 'Would tell: {0}', 'It would fail: {0}',
  'There is no one to do it for.', 'Nothing is open, so no register was posted.', 'Register posted to {0}.', 'Would post: {0}',
  'Its schedule does not read any more.', 'Its bot is paused.', 'Its bot is retired.', 'Its maker is not in the office any more.',
  'Would start {0} for {1}', 'Would remind {0}: {1}', 'Started for {0}', '{0} is already answering it', '{0} cannot use it', 'Reminded {0}', '{0} is on leave: left out',
  'Asked: {0}', 'Would say: {0}', 'Said: {0}',
  '{0} free', '{0} open', '{0} released', '{0} sent', '{0} away', 'on leave, back {0}', 'on leave', 'in the office', 'working day', 'day off: {0}', 'would {0}',
  'SEAT?', 'OPEN?', 'WHERE?', 'RELEASE', 'SENT?', 'LEAD?', 'AWAY?', 'WHO IS AWAY?', 'WORKDAY?', 'HAND ON', 'OPENED', 'CLOSED', 'AWAY',
  'Is a place free?', 'How many are open?', 'Where is a request?', 'Release their places', 'How many were sent?', 'Who is their lead?', 'Are they on leave?', 'Who is on leave?', 'Is it a working day?',
  '{0} has it: {1}.', '{0} has it.', '{0} carries on in its own conversation: a few more questions there.', '{0} could not take it: {1}',
  'From {0}: 1 answer carried across.', 'From {0}: {1} answers carried across.', 'From {0}.',
  '{0} did not answer in time.', '{0} asked too often in the last minute.', '{0} handed over too often in the last minute.', 'Try again in a minute.',
  '{0} is private to the person who made it.', '{0} answers only its own maker’s bots.', '{0} is not shared with this bot’s maker.', '{0} does that only for the person it is for.',
  '{0} does not take requests from other bots.', '{0} is not one this person can use.', 'Stopped a loop: {0} already had this request ({1}).', 'Stopped: a request may pass through {0} bots at most.',
  'There is no bot called {0} that {1} can ask.', 'There is no bot called {0} to hand it to.', '{0} is {1} by the person who made it.', '{0} needs “{1}”.',
  'It stops here; start it again later.', '{0} handed back {1}', '{0} could not run at {1}: {2}', 'Its job sheet has the details.',
  'Directory', 'Office calendar', 'Done before it was handed over', 'Handed over', 'Passed to a person',
];
