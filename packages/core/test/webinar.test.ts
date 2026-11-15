// Webinars in core: the organiser's form questions and the answers checked against them, the
// personal links (the token in the fragment), invitations and reminders with an .ics carrying each
// registrant's own link, the follow-up texts, and the CSVs (registrants, the webinar's report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswers, cleanFields, mailMergeCsv, registrantsCsv, webinarFollowUp, webinarFollowUpMessage, webinarInvitation, webinarReportCsv, webinarSurveyUrl, webinarWatchUrl } from '../src/webinar.ts';
import type { Registrant, WebinarMailInput, WebinarReport } from '../src/webinar.ts';

test('the organiser\'s questions are cleaned and answers checked against them', () => {
  const fields = cleanFields([
    { label: '  Company  ', kind: 'text', required: true },
    { label: 'Role', kind: 'choice', options: ['Engineer', 'Engineer', ' Manager ', ''], required: false },
    { label: '', kind: 'text' },
    { id: 'q1', label: 'Same id again', kind: 'text' },
  ]);
  assert.deepEqual(fields.map((f) => [f.id, f.label, f.kind, f.options, f.required]), [
    ['q1', 'Company', 'text', [], true], ['q2', 'Role', 'choice', ['Engineer', 'Manager'], false], ['q3', 'Same id again', 'text', [], false],
  ]);
  assert.throws(() => cleanFields([{ label: 'Pick', kind: 'choice', options: ['only'] }]), /two choices/);
  assert.equal(cleanFields(Array.from({ length: 30 }, (_, i) => ({ label: `Q${i}`, kind: 'text' }))).length, 12);
  assert.deepEqual(checkAnswers(fields, { q1: ' Acme ', q2: 'Manager', extra: 'ignored' }), { q1: 'Acme', q2: 'Manager' });
  assert.throws(() => checkAnswers(fields, { q2: 'Manager' }), /Company/);
  assert.throws(() => checkAnswers(fields, { q1: 'Acme', q2: 'Astronaut' }), /Choose one/);
});

const input: WebinarMailInput = {
  meetingId: '482913207', title: 'Pump skid design review', description: 'Sizing, and your questions.', startsAt: Date.UTC(2026, 10, 18, 9, 30), durationMin: 60,
  organizer: { id: 'u1', name: 'Priya Raman', email: 'priya@dexterity.example' }, office: 'Dexterity Design Services', when: 'Wednesday 18 November 2026, 15:00 – 16:00 (Asia/Kolkata)', registerUrl: null,
};

test('invitations and reminders carry each person\'s own link, in the text and the .ics', () => {
  const url = webinarWatchUrl('https://gw.example.workers.dev/', '482913207', 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(url, 'https://gw.example.workers.dev/w/482913207/watch#AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(new URL(url).search, '', 'the token is never in the query');
  assert.equal(webinarSurveyUrl('https://gw.example.workers.dev', '482913207', 'T'), 'https://gw.example.workers.dev/w/482913207/survey#T');
  const inv = webinarInvitation(input, { id: 'r1', name: 'Dana Wright', email: 'dana@acme.example', joinUrl: url }, 'invite');
  assert.equal(inv.subject, 'Your place at Pump skid design review');
  assert.match(inv.text, /^Dear Dana,/);
  assert.ok(inv.text.includes(url));
  assert.ok(inv.text.includes('Wednesday 18 November 2026'));
  const ics = inv.ics!;
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:webinar-482913207@dexconnect/);
  assert.match(ics, /DTSTART:20261118T093000Z/);
  assert.match(ics, /DTEND:20261118T103000Z/);
  assert.match(ics, /SEQUENCE:0/);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`URL:${url}`));
  assert.ok(unfolded.includes('Your personal link (keep it to yourself):'));
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), 'lines folded at 75 octets');
  const rem = webinarInvitation(input, { id: 'r1', name: 'Dana Wright', email: 'dana@acme.example', joinUrl: url }, 'reminder');
  assert.match(rem.subject, /^Reminder: Pump skid design review starts Wednesday 18 November 2026$/);
  assert.match(rem.ics!, /SEQUENCE:1/);
});

test('the follow-up: thank-you or "we missed you", the recording and the survey; and the message in the app', () => {
  const came = webinarFollowUp(input, { id: 'r1', name: 'Dana Wright', email: 'dana@acme.example', attended: true, surveyUrl: 'https://gw/w/482913207/survey#T' }, 'Slides are attached.', 'https://videos.example.com/x');
  assert.match(came.subject, /^Thank you for attending/);
  assert.ok(came.text.includes('https://videos.example.com/x') && came.text.includes('survey#T') && came.text.includes('Slides are attached.'));
  const missed = webinarFollowUp(input, { id: 'r2', name: 'Kim Lee', email: 'kim@river.example', attended: false, surveyUrl: null }, '', null);
  assert.match(missed.text, /We missed you/);
  assert.ok(!/survey/i.test(missed.text) && !/recording/.test(missed.text));
  const msg = webinarFollowUpMessage('Pump skid design review', 'Priya Raman', 'Thanks!', 'dexconnect://recording/abc', true, '482913207');
  assert.match(msg, /^\*\*Thank you for attending Pump skid design review\*\*/);
  assert.ok(msg.includes('dexconnect://recording/abc') && msg.includes('dexconnect://webinar/482913207/survey'));
  const csv = mailMergeCsv([came, missed], new Map([['r1', 'https://gw/w/482913207/watch#A']]));
  assert.ok(csv.startsWith('﻿Name,Email,Subject,Personal link,Message'));
  assert.ok(csv.includes('Dana Wright,dana@acme.example,Thank you for attending Pump skid design review,https://gw/w/482913207/watch#A,"Dear Dana'));
});

test('registrants and the webinar report as CSV (formula-safe, attended or no-show)', () => {
  const fields = cleanFields([{ label: 'Company', kind: 'text' }]);
  const regs: Registrant[] = [
    { id: 'r1', name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: '=HYPERLINK("x")' }, status: 'approved', createdAt: Date.UTC(2026, 10, 10), decidedAt: null, joinUrl: 'https://gw/w/1/watch#A', attended: true, minutes: 52 },
    { id: 'r2', name: 'Kim Lee', email: 'kim@river.example', answers: {}, status: 'approved', createdAt: Date.UTC(2026, 10, 11), decidedAt: null, joinUrl: null, attended: false, minutes: 0 },
  ];
  const csv = registrantsCsv(fields, regs);
  assert.ok(csv.includes('Name,Email,Status,Registered (UTC),Attended,Minutes watched,Personal link,Company'));
  assert.ok(csv.includes(`Dana Wright,dana@acme.example,approved,2026-11-10 00:00:00,attended,52,https://gw/w/1/watch#A,"'=HYPERLINK(""x"")"`), 'a formula is written as text');
  assert.ok(csv.includes('Kim Lee,kim@river.example,approved,2026-11-11 00:00:00,no-show,0'));
  const rep: WebinarReport = {
    meetingId: '482913207', title: 'Pump skid design review', startsAt: input.startsAt, wentLiveAt: input.startsAt, endedAt: input.startsAt + 3600_000, peakAudience: 41,
    registrants: regs.map((r) => ({ ...r, registeredAt: r.createdAt })),
    attendees: [{ name: 'Dana Wright', email: 'dana@acme.example', office: false, registrantId: 'r1', minutes: 52, firstSeen: input.startsAt, hands: 1 }],
    questions: [{ id: 'q', text: 'Flow rate?', author: '', anonymous: true, votes: 3, at: input.startsAt, status: 'live', answer: { text: '', by: 'Ravi', at: input.startsAt }, pinned: false, onStage: false }],
    polls: [{ question: 'Useful?', options: [{ text: 'Yes', votes: 1 }, { text: 'No', votes: 0 }], voters: 1, answers: [{ name: 'Dana Wright', choices: ['Yes'] }] }],
    handouts: [{ name: 'slides.pdf', downloads: [{ name: 'Dana Wright', at: input.startsAt }] }],
    survey: { fields, answers: [{ name: 'Dana Wright', at: input.startsAt, answers: { q1: 'Acme' } }] },
  };
  const out = webinarReportCsv(rep);
  for (const s of ['Most attendees at once,41', 'Attendee,Email,From', 'Dana Wright,dana@acme.example,registered', 'Flow rate?,(anonymous),3,answered live', 'Poll,Useful?,1 voted', ',Dana Wright,Yes', 'slides.pdf,1,Dana Wright', 'Survey,Answered (UTC),Company']) assert.ok(out.includes(s), s);
});
