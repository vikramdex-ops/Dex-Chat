import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDlp, dlpMatches, ipAllowed, validCidr, validDlpRules } from '../src/dlp.ts';
import type { DlpRule } from '../src/dlp.ts';

const rule = (detector: DlpRule['detector'], action: DlpRule['action'] = 'block', extra: Partial<DlpRule> = {}): DlpRule =>
  ({ id: detector, name: detector, detector, action, scope: 'everywhere', ...extra });

test('detectors find real numbers and leave drawing and line numbers alone', () => {
  assert.equal(dlpMatches('card 4111 1111 1111 1111 please', rule('card')).length, 1);
  assert.equal(dlpMatches('4111 1111 1111 1112', rule('card')).length, 0, 'fails the Luhn check');
  assert.equal(dlpMatches('Aadhaar 2345 6789 0124', rule('aadhaar')).length, 1);
  assert.equal(dlpMatches('2345 6789 0125', rule('aadhaar')).length, 0, 'fails the Verhoeff check');
  assert.equal(dlpMatches('PAN ABCPE1234F', rule('pan')).length, 1);
  assert.equal(dlpMatches('IFSC HDFC0001234, a/c no 50100123456789', rule('bank')).length, 2);
  for (const safe of ['6"-P-1001-A1B', 'ISO-1001-01', 'PO 4500012345', 'call 98450 12345']) {
    for (const d of ['card', 'aadhaar', 'pan', 'bank'] as const) assert.equal(dlpMatches(safe, rule(d)).length, 0, `${d} on ${safe}`);
  }
  const words = rule('words', 'block', { words: 'Project Falcon, tender price' });
  assert.equal(dlpMatches('the TENDER PRICE is out', words).length, 1);
  assert.equal(dlpMatches('falconry', rule('words', 'block', { words: 'falcon' })).length, 0, 'whole words only');
});

test('block wins, masking replaces matches, guest scope', () => {
  const rules = [rule('card', 'mask'), rule('words', 'block', { words: 'Falcon', scope: 'with-guests' })];
  const m = applyDlp('Pay 4111-1111-1111-1111 today', rules, { withGuests: false });
  assert.equal(m.text, 'Pay •••• today');
  assert.deepEqual(m.masked, ['card']);
  assert.equal(applyDlp('Falcon review', rules, { withGuests: false }).blockedBy, null);
  assert.equal(applyDlp('Falcon review', rules, { withGuests: true }).blockedBy?.detector, 'words');
});

test('rules and networks typed by an administrator are checked', () => {
  const r = validDlpRules([{ detector: 'card', action: 'mask' }, { detector: 'words', words: '' }, { detector: 'nope' }, 'x']);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Payment card numbers');
  assert.ok(validCidr('203.0.113.0/24') && validCidr('2001:db8::/32') && validCidr('198.51.100.7'));
  assert.ok(!validCidr('300.1.1.1') && !validCidr('10.0.0.0/33') && !validCidr('hello'));
  assert.ok(ipAllowed('203.0.113.77', ['203.0.113.0/24']));
  assert.ok(!ipAllowed('203.0.114.1', ['203.0.113.0/24']));
  assert.ok(ipAllowed('2001:db8:1::5', ['2001:db8::/32']));
  assert.ok(!ipAllowed('unknown', ['0.0.0.0/1']));
  assert.ok(ipAllowed('anything', []));
});
