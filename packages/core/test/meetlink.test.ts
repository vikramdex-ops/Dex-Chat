// Dexterity Meet's links: meeting names (slugs) and their rules, what a path names, and the
// addresses built from them (the passcode only ever after #).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_SLUGS, SLUG_MAX, calendarLinks, meetPageUrl, normalizeSlug, parseMeetRef, refSegment, siteUrlProblem, slugFrom, slugProblem, webinarPageUrl } from '../src/meetlink.ts';

test('names are made from what people type: accents dropped, lower case, hyphens between words', () => {
  assert.equal(normalizeSlug('  P12 Design Review '), 'p12-design-review');
  assert.equal(normalizeSlug('Café_Meeting.notes'), 'cafe-meeting-notes');
  assert.equal(normalizeSlug('--Site---visit--'), 'site-visit');
  assert.equal(normalizeSlug('Vikram'), 'vikram');
});

test('names are a-z, digits and single hyphens, start with a letter, 3 to 40 long', () => {
  for (const ok of ['p12-design-review', 'vikram', 'abc', 'a'.repeat(SLUG_MAX), 'site-visit-2026']) assert.equal(slugProblem(ok), null, ok);
  assert.match(slugProblem('ab')!, /at least 3/);
  assert.match(slugProblem('a'.repeat(SLUG_MAX + 1))!, /up to 40/);
  assert.match(slugProblem('12-review')!, /starts with a letter/);
  assert.match(slugProblem('482913207')!, /starts with a letter/);
  assert.match(slugProblem('review-')!, /Hyphens/);
  assert.match(slugProblem('re--view')!, /Hyphens/);
  assert.match(slugProblem('re view')!, /letters a to z/);
});

test('look-alike letters are refused, never turned into Latin ones', () => {
  // Cyrillic а (U+0430) and Greek ο (U+03BF) look like a and o
  for (const s of ['vikrаm', 'rοom-one', 'ｖｉｋｒａｍ'.normalize('NFKD') === 'vikram' ? 'vikrаm' : 'x', 'dex​connect', 'p12‐review']) {
    const n = normalizeSlug(s);
    assert.notEqual(slugProblem(n), null, `${s} -> ${n}`);
  }
  // full-width letters are the same letters in another width: NFKD makes them plain ASCII
  assert.equal(normalizeSlug('ｖｉｋｒａｍ'), 'vikram');
  // punycode-looking names are kept for the site
  assert.notEqual(slugProblem('xn-abc'), null);
});

test('the site keeps its own paths and official-looking words', () => {
  for (const r of ['api', 'w', 'm', 'assets', 'admin', 'login', 'dexterity', 'zoom', 'teams', 'support']) {
    assert.ok(RESERVED_SLUGS.has(r), r);
    if (r.length >= 3) assert.match(slugProblem(r)!, /kept for the site/);
  }
  assert.match(slugProblem('admin-panel')!, /kept/);
  assert.match(slugProblem('dexterity-billing')!, /kept/);
});

test('a suggestion from a title, cut at a word', () => {
  assert.equal(slugFrom('P-12 Design review'), 'p-12-design-review');
  assert.equal(slugFrom('2026 kickoff'), 'kickoff');
  assert.equal(slugFrom('Монтаж'), '');
  assert.equal(slugFrom('Login'), '');
  const long = slugFrom('Quarterly design coordination review for the north pump station');
  assert.ok(long.length <= SLUG_MAX && !long.endsWith('-'), long);
});

test('a path segment names a meeting ID (with or without dashes) or a name', () => {
  assert.deepEqual(parseMeetRef('482-913-207'), { kind: 'id', id: '482913207' });
  assert.deepEqual(parseMeetRef('482913207'), { kind: 'id', id: '482913207' });
  assert.deepEqual(parseMeetRef('p12-design-review'), { kind: 'slug', slug: 'p12-design-review' });
  for (const bad of ['082913207', '48291320', 'P12-Review', 'api', '../etc', 'a'.repeat(80), '', 'vikr%D0%B0m']) assert.equal(parseMeetRef(bad), null, bad);
});

test('addresses: the dashed ID or the name, the passcode only after #', () => {
  assert.equal(refSegment('482913207'), '482-913-207');
  const u = new URL(meetPageUrl('https://dexterity-meet.pages.dev/', 'p12-design-review', 'Hx7kP2qR'));
  assert.equal(u.host, 'dexterity-meet.pages.dev');
  assert.equal(u.pathname, '/p12-design-review');
  assert.equal(u.search, '');
  assert.equal(u.hash, '#Hx7kP2qR');
  assert.equal(meetPageUrl('https://meet.example.com', '482913207'), 'https://meet.example.com/482-913-207');
  assert.equal(webinarPageUrl('https://meet.example.com/', '482913207'), 'https://meet.example.com/w/482-913-207');
});

test('the meeting site address is https with no path (a local address for tests)', () => {
  assert.equal(siteUrlProblem('https://dexterity-meet.pages.dev'), null);
  assert.equal(siteUrlProblem('https://meet.dexteritydesign.co.in'), null);
  assert.equal(siteUrlProblem('http://localhost:8788'), null);
  assert.notEqual(siteUrlProblem('http://dexterity-meet.pages.dev'), null);
  assert.notEqual(siteUrlProblem('https://dexterity-meet.pages.dev/meet'), null);
  assert.notEqual(siteUrlProblem('javascript:alert(1)'), null);
});

test('calendar links carry the address without the passcode', () => {
  const l = calendarLinks({ title: 'P-12 review', startAt: Date.UTC(2026, 10, 18, 4, 30), endAt: Date.UTC(2026, 10, 18, 5, 30), url: 'https://dexterity-meet.pages.dev/p12-review', details: 'Join: https://dexterity-meet.pages.dev/p12-review' });
  const g = new URL(l.google);
  assert.equal(g.host, 'calendar.google.com');
  assert.equal(g.searchParams.get('dates'), '20261118T043000Z/20261118T053000Z');
  assert.equal(g.searchParams.get('location'), 'https://dexterity-meet.pages.dev/p12-review');
  assert.ok(!l.google.includes('#') && !l.outlook.includes('%23'));
  const o = new URL(l.outlook);
  assert.equal(o.host, 'outlook.live.com');
  assert.equal(o.searchParams.get('subject'), 'P-12 review');
});
