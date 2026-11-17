// Meeting reports and the office's meeting totals as CSV (the core CSV writer: quoted where
// needed, safe from spreadsheet formulas, UTF-8 with a BOM so Excel and Dexterity Sheets open it).
import { toCsv } from './csv.ts';
import type { MeetingReport, MeetingUsage } from './meet.ts';
import { webinarReportRows } from './webinar.ts';

const iso = (t: number | null) => (t === null ? '' : new Date(t).toISOString().replace('T', ' ').slice(0, 19));
const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

/** One row per person (time in the meeting with rejoins summed), then hands, reactions, polls and recordings (and a webinar's own sections). */
export function reportCsv(r: MeetingReport): string {
  const rows: Array<Array<string | number | null>> = [
    ['Meeting', r.title || 'Meeting'],
    ['Meeting ID', r.meetingId ?? ''],
    ['Started (UTC)', iso(r.startedAt)],
    ['Ended (UTC)', iso(r.endedAt)],
    ['Length (minutes)', minutes(r.durationMs)],
    ['Most people at once', r.peak],
    ['Breakout rooms', r.breakouts],
    [],
    ['Name', 'Guest', 'First joined (UTC)', 'Last left (UTC)', 'Minutes in the meeting', 'Times joined', 'Hands raised', 'Reactions'],
    ...r.people.map((p) => [p.name, p.guest ? 'yes' : 'no', iso(p.firstJoin), iso(p.lastLeave), minutes(p.totalMs), p.joins, p.hands, p.reactions]),
    [],
    ['Reaction', 'Count'],
    ...Object.entries(r.reactions).sort((a, b) => b[1] - a[1]).map(([e, n]) => [e, n]),
  ];
  for (const poll of r.polls) {
    rows.push([], ['Poll', poll.question, `${poll.voters} voted`], ...poll.options.map((o) => ['', o.text, o.votes]));
  }
  if (r.recordings.length) {
    rows.push([], ['Recording', 'Recorded by', 'Minutes', 'Chapters']);
    for (const rec of r.recordings) rows.push([rec.title, rec.recordedByName, minutes(rec.durationMs), rec.chapters.length]);
  }
  // a webinar: its registrants, attendees, questions, polls, handouts and survey after the meeting's own rows
  if (r.webinar) rows.push([], ...webinarReportRows(r.webinar));
  return toCsv(rows);
}

/** The office's meetings by week: count, hours, average size and guests from a browser. */
export function usageCsv(u: MeetingUsage): string {
  return toCsv([
    ['Week starting', 'Meetings', 'Hours', 'Average people', 'Guests from a browser'],
    ...u.weeks.map((w) => [w.week, w.meetings, w.hours, w.averageSize, w.guests]),
    ['Total', u.totals.meetings, u.totals.hours, u.totals.averageSize, u.totals.guests],
  ]);
}
