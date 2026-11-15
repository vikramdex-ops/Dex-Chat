// Invitations as an email draft (.eml): headers, the MIME structure, CRLF line ends, encoded
// headers for Hindi and Tamil, the .ics attachment, a long title, and the mailto: fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEml, encodeHeader, invitationEmail, mailtoLink, officeWhen } from '../src/eml.ts';
import { buildIcs } from '../src/ics.ts';
import type { Invitation } from '../src/ics.ts';

const inv: Invitation = {
  uid: 'meeting-482913207@dexconnect', title: 'P-12 design review', startAt: Date.UTC(2026, 10, 18, 9, 30), endAt: Date.UTC(2026, 10, 18, 10, 30),
  organizer: { name: 'प्रिया रमन', email: 'priya@dexteritydesign.co.in', id: 'u1' }, office: 'Dexterity Design Services', meetingId: '482913207',
  guestUrl: 'https://dexterity-meet.pages.dev/p12-design-review#Hx7kP2qR', pageUrl: 'https://dexterity-meet.pages.dev/p12-design-review', passcode: 'Hx7kP2qR',
  appLink: 'dexconnect://meet/482-913-207',
};
const decodeParts = (eml: string) => eml.split(/\r\n--=_dex_(?:mixed|alt)_T(?:--)?\r\n/).slice(1).map((p) => { const [hd, ...rest] = p.split('\r\n\r\n'); return { hd, body: rest.join('\r\n\r\n') }; })
  .filter((p) => /Content-Transfer-Encoding: base64/.test(p.hd)).map((p) => ({ type: /Content-Type: ([^;\r\n]+)/.exec(p.hd)![1], body: Buffer.from(p.body.replace(/\r\n/g, '').replace(/--=_dex.*$/, ''), 'base64').toString('utf8') }));

test('the office time with its zone, and the subject', () => {
  assert.equal(officeWhen(inv.startAt, 'Asia/Kolkata'), 'Wed 18 Nov, 3:00 PM IST');
  const m = invitationEmail(inv, { when: 'Wednesday 18 November 2026, 15:00 – 16:00 (Asia/Kolkata)', zone: 'Asia/Kolkata' });
  assert.equal(m.subject, 'Invitation: P-12 design review · Wed 18 Nov, 3:00 PM IST');
  assert.match(m.text, /Passcode: Hx7kP2qR/);
  assert.match(m.html, /href="https:\/\/dexterity-meet\.pages\.dev\/p12-design-review#Hx7kP2qR"/);
  assert.match(m.html, /Join from your browser/);
  assert.match(m.html, /Hx7kP2qR/);
  // email-safe: inline styles and tables, nothing loaded from anywhere
  assert.doesNotMatch(m.html, /<img|<link|<script|@import|url\(/);
  // no guest link: no passcode anywhere
  const inside = invitationEmail({ ...inv, guestUrl: null, passcode: null }, { when: 'x', zone: 'Asia/Kolkata' });
  assert.ok(!inside.text.includes('Hx7kP2qR') && !inside.html.includes('Hx7kP2qR') && !inside.html.includes('Join from your browser'));
});

test('a draft .eml: headers, MIME parts, CRLF, encoded words, the .ics attached', () => {
  const m = invitationEmail(inv, { when: 'Wednesday 18 November 2026, 15:00 – 16:00 (Asia/Kolkata)', zone: 'Asia/Kolkata' });
  const ics = buildIcs(inv, 'when');
  const eml = buildEml({ to: [{ name: 'தானா ரைட்', email: 'dana@client.example' }, { email: 'not an address' }], subject: `${m.subject} · நன்றி`, text: m.text, html: m.html, attachments: [{ name: 'P-12 design review.ics', type: 'text/calendar; method=PUBLISH; charset=UTF-8', data: ics }], seed: 'T', date: new Date(Date.UTC(2026, 10, 15, 12)) });
  assert.ok(!/[^\r]\n/.test(eml), 'CRLF only');
  const [head] = eml.split('\r\n\r\n');
  assert.match(head, /^MIME-Version: 1\.0\r\n/);
  assert.match(head, /\r\nX-Unsent: 1\r\n/);
  assert.match(head, /\r\nDate: Sun, 15 Nov 2026 12:00:00 \+0000\r\n/);
  assert.match(head, /\r\nTo: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <dana@client\.example>\r\n/);
  assert.ok(!head.includes('not an address'), 'a bad address is left out');
  assert.match(head, /Content-Type: multipart\/mixed; boundary="=_dex_mixed_T"/);
  for (const line of eml.split('\r\n')) assert.ok(line.length <= 998, 'no line over 998 characters');
  // the subject decodes back to itself
  const subj = /\r\nSubject: ([^]*?)\r\n(?=\S)/.exec(`\r\n${head}`)![1];
  const decoded = subj.split(/\r\n /).map((w) => { const x = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w); return x ? Buffer.from(x[1], 'base64').toString('utf8') : w; }).join('');
  assert.equal(decoded, `${m.subject} · நன்றி`);
  assert.ok(subj.split('\r\n ').every((w) => w.length <= 75), 'encoded words of at most 75');
  // structure: alternative (text, then html) inside mixed, then the attachment
  assert.match(eml, /--=_dex_mixed_T\r\nContent-Type: multipart\/alternative; boundary="=_dex_alt_T"\r\n\r\n--=_dex_alt_T\r\nContent-Type: text\/plain; charset=UTF-8/);
  assert.match(eml, /--=_dex_alt_T--\r\n--=_dex_mixed_T\r\nContent-Type: text\/calendar; method=PUBLISH; charset=UTF-8; name="P-12 design review\.ics"\r\nContent-Disposition: attachment; filename="P-12 design review\.ics"/);
  assert.ok(eml.endsWith('--=_dex_mixed_T--\r\n'));
  const parts = decodeParts(eml);
  assert.deepEqual(parts.map((p) => p.type), ['text/plain', 'text/html', 'text/calendar']);
  assert.match(parts[0].body, /प्रिया रमन invites you to a meeting/);
  assert.equal(parts[2].body, ics);
  assert.match(parts[2].body, /\r\nURL:https:\/\/dexterity-meet\.pages\.dev\/p12-design-review#Hx7kP2qR\r\n/);
});

test('a long title is encoded and folded, never split inside a character', () => {
  const long = 'समीक्षा '.repeat(30) + 'P-12';
  const e = encodeHeader(long);
  assert.ok(e.split('\r\n ').every((w) => w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w)));
  assert.equal(e.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), long);
  assert.equal(encodeHeader('Plain ASCII title'), 'Plain ASCII title');
});

test('the mailto: fallback: subject and text, no attachment, cut to a safe length', () => {
  const u = mailtoLink(['dana@client.example'], 'Invitation: P-12', 'Line one\nLine two');
  assert.equal(u, 'mailto:dana%40client.example?subject=Invitation%3A%20P-12&body=Line%20one%0D%0ALine%20two');
  const big = mailtoLink([], 'S', Array.from({ length: 400 }, (_, i) => `Line ${i} of the invitation text`).join('\n'));
  assert.ok(big.length <= 1900, String(big.length));
  assert.ok(decodeURIComponent(big.split('body=')[1]).endsWith('…'));
});
