// When the app says the hub connection is down (conn-notice.ts): not for a quick reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_DELAY_MS, nextDownSince, noticeDue, noticeIn } from '../src/renderer/conn-notice.ts';

test('a reconnect shorter than the delay is never announced', () => {
  let since: number | null = null;
  since = nextDownSince(since, 'ready', 1000);
  assert.equal(since, null);
  since = nextDownSince(since, 'offline', 2000); // the phone came back; its socket had closed
  since = nextDownSince(since, 'connecting', 2100);
  assert.equal(since, 2000, 'offline then connecting is one outage');
  assert.equal(noticeDue('connecting', since, 2000 + 400), false);
  assert.equal(noticeIn('connecting', since, 2400), NOTICE_DELAY_MS - 400);
  since = nextDownSince(since, 'ready', 2500);
  assert.equal(since, null);
  assert.equal(noticeDue('ready', since, 9000), false);
});

test('an outage longer than the delay is announced, and only while it lasts', () => {
  const since = nextDownSince(null, 'offline', 0);
  assert.equal(noticeDue('offline', since, NOTICE_DELAY_MS - 1), false);
  assert.equal(noticeDue('offline', since, NOTICE_DELAY_MS), true);
  assert.equal(noticeIn('offline', since, NOTICE_DELAY_MS + 50), 0);
  assert.equal(noticeDue('ready', null, NOTICE_DELAY_MS * 2), false);
});

test('states that are not a reconnect are left to their own screens', () => {
  for (const p of ['pending', 'rejected', 'mismatch', 'welcome'] as const) {
    assert.equal(nextDownSince(5, p, 10), null);
    assert.equal(noticeDue(p, 0, 99_999), false);
    assert.equal(noticeIn(p, 0, 10), null);
  }
});
