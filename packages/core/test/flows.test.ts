import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowError, inTimeWindow, keywordList, matchText, nameMatches, renderTemplate, unsafeRegex, validateGraph, variablesAt } from '../src/flows.ts';

const ok = { id: 'a1', kind: 'tag', tag: 'x1' };

test('rule graphs are checked and cleaned', () => {
  const g = validateGraph({
    trigger: { id: 't1', kind: 'file.added', types: ['.PDF', 'dwg', 'not ok!'], namePattern: '  GA-*  ', extra: 1 },
    conditions: [{ id: 'c1', kind: 'time', days: [5, 1, 1, 9], from: '09:00', to: '18:00' }],
    actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'group', id: 'G1' }, { kind: 'group', id: 'G1' }, { kind: 'role', id: 'author' }, { kind: 'role', id: 'boss' }], text: ' Hi ' }],
  });
  assert.deepEqual(g.trigger, { id: 't1', kind: 'file.added', types: ['pdf', 'dwg'], namePattern: 'GA-*' });
  assert.deepEqual(g.conditions[0], { id: 'c1', kind: 'time', days: [1, 5], from: '09:00', to: '18:00' });
  assert.deepEqual(g.actions[0], { id: 'a1', kind: 'notify', to: [{ kind: 'group', id: 'G1' }, { kind: 'role', id: 'author' }], text: 'Hi' });
  const bad: Array<[unknown, RegExp]> = [
    [{ trigger: { kind: 'nope' }, actions: [ok] }, /starts the rule/],
    [{ trigger: { kind: 'file.added' }, actions: [] }, /at least one step/],
    [{ trigger: { kind: 'file.added' }, actions: Array(9).fill(ok).map((a, i) => ({ ...a, id: `a${i}` })) }, /up to 8 steps/],
    [{ trigger: { kind: 'reaction.added', emoji: '' }, actions: [ok] }, /reaction to watch/],
    [{ trigger: { kind: 'message.mentioned', targets: [] }, actions: [ok] }, /at least one person/],
    [{ trigger: { kind: 'message.matched', mode: 'regex', pattern: '(a+)+' }, actions: [ok] }, /repeated group/],
    [{ trigger: { kind: 'file.added' }, conditions: [{ kind: 'time', days: [1], from: '9:00', to: '18:00' }], actions: [ok] }, /HH:MM/],
    [{ trigger: { kind: 'file.added' }, conditions: [{ kind: 'file' }], actions: [ok] }, /types or a name/],
    [{ trigger: { kind: 'file.added' }, actions: [{ kind: 'tag', tag: '9lives' }] }, /starts with a letter/],
    [{ trigger: { kind: 'file.added' }, actions: [{ kind: 'webhook', url: 'ftp://x.example/' }] }, /http/],
    [{ trigger: { kind: 'file.added' }, actions: [{ kind: 'webhook', url: 'https://u:p@x.example/' }] }, /credentials/],
    [{ trigger: { kind: 'file.added' }, actions: [{ kind: 'notify', to: [{ kind: 'user', id: 'U1' }], text: '' }] }, /write the message/],
    [{ trigger: { id: 'x', kind: 'file.added' }, actions: [{ ...ok, id: 'x' }] }, /same id/],
  ];
  for (const [graph, re] of bad) assert.throws(() => validateGraph(graph), (e: Error) => e instanceof FlowError && re.test(e.message), JSON.stringify(graph));
});

test('safe regular expressions only', () => {
  for (const p of ['\\bP-\\d{3}\\b', '^(GA|PID)-\\d+$', '(\\d{1,2})"-([A-Z]{1,3})-(\\d{3,5})', 'rev(ision)?\\s*[A-Z]', '[a+]+', '(ab){2,5}', '(?:x|y)']) assert.equal(unsafeRegex(p), null, p);
  for (const p of ['(a+)+', '(a*)*b', '(x|xy)+', '(\\w+\\s?)*$', '(a|b){2,}', 'a{1,5000}', '(\\d)\\1', '(?=x)y', '(?<!x)y', '(', 'x'.repeat(201), '']) assert.notEqual(unsafeRegex(p), null, p);
});

test('keywords match whole words, any case; regex groups come back', () => {
  const kw = { kind: 'message.matched' as const, mode: 'keywords' as const, pattern: 'urgent, "stop work", RFI' };
  assert.deepEqual(keywordList(kw.pattern), ['urgent', 'stop work', 'RFI']);
  assert.equal(matchText(kw, 'This is URGENT.')?.text, 'URGENT');
  assert.equal(matchText(kw, 'urgently'), null);
  assert.equal(matchText(kw, 'please Stop Work now')?.text, 'Stop Work');
  assert.equal(matchText({ ...kw, caseSensitive: true }, 'please Stop Work now'), null);
  const re = { kind: 'message.matched' as const, mode: 'regex' as const, pattern: '(GA|PID)-(\\d+)' };
  assert.deepEqual(matchText(re, 'see pid-204 rev B'), { text: 'pid-204', groups: ['pid', '204'] });
  assert.equal(matchText({ ...re, pattern: '(a+)+$' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'), null, 'unsafe patterns never run');
});

test('file name patterns, templates and the variables each step can use', () => {
  assert.ok(nameMatches('GA-*.pdf', 'ga-101 rev B.PDF'));
  assert.ok(!nameMatches('GA-*.pdf', 'PID-101.pdf'));
  assert.ok(nameMatches('pump', 'Pump house.dwg'));
  assert.ok(nameMatches('GA-10?.dwg', 'GA-104.dwg'));
  assert.equal(renderTemplate('{{author.name}} shared {{ file.name }}{{nope}}', { 'author.name': 'Priya', 'file.name': 'A.pdf' }), 'Priya shared A.pdf');
  const g = validateGraph({ trigger: { kind: 'file.added' }, actions: [{ kind: 'extract' }, { kind: 'webhook', url: 'https://x.example/h' }, ok] });
  assert.ok(!variablesAt(g, 0).includes('file.title'));
  assert.ok(variablesAt(g, 1).includes('file.title'));
  assert.ok(!variablesAt(g, 1).includes('webhook.status'));
  assert.ok(variablesAt(g, 2).includes('webhook.status'));
  assert.ok(variablesAt(g, 0).includes('file.name'));
});

test('office hours, days, past midnight and "outside these hours"', () => {
  const office = { kind: 'time' as const, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
  const at = (day: string, time: string) => new Date(`${day}T${time}:00`);
  assert.ok(inTimeWindow(office, at('2026-11-16', '09:00'))); // Monday
  assert.ok(!inTimeWindow(office, at('2026-11-16', '18:00')));
  assert.ok(!inTimeWindow(office, at('2026-11-15', '11:00'))); // Sunday
  assert.ok(inTimeWindow({ ...office, outside: true }, at('2026-11-15', '11:00')));
  const night = { kind: 'time' as const, days: [5], from: '22:00', to: '06:00' };
  assert.ok(inTimeWindow(night, at('2026-11-20', '23:30'))); // Friday night
  assert.ok(inTimeWindow(night, at('2026-11-21', '02:00'))); // still Friday's shift
  assert.ok(!inTimeWindow(night, at('2026-11-22', '02:00'))); // Saturday's
  const weekends = { kind: 'time' as const, days: [0, 6], from: '00:00', to: '00:00' };
  assert.ok(inTimeWindow(weekends, at('2026-11-21', '23:59')));
  assert.ok(!inTimeWindow(weekends, at('2026-11-20', '12:00')));
});
