// Hindi and Tamil translate whole sentences: a sentence the screens build with a count or a name
// in it (not a word chosen in code and glued in) finds its own entry, and no English word is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// the app imports hi.json / ta.json through Vite; here they load as a module with the words as its default
registerHooks({
  load(url, context, next) {
    if (!url.endsWith('.json')) return next(url, context);
    return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
  },
});
const saved: Record<string, string> = { 'dex.language': 'hi' };
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => saved[k] ?? null, setItem: (k: string, v: string) => { saved[k] = v; } };
const { tr, loadLanguage, language } = await import('../src/renderer/i18n/index.ts');
await loadLanguage();

/** What is left once the names and the product's name are taken out: it must hold no English. */
const english = (s: string, ...names: string[]) => [...names, 'Dexterity Connect'].reduce((t, n) => t.split(n).join(''), s).match(/[A-Za-z]+/g);

test('the language is Hindi and its words loaded', () => {
  assert.equal(language(), 'hi');
  assert.notEqual(tr('Restart now'), 'Restart now');
});

test('sentences that used to take "is" / "are" from code translate whole', () => {
  for (const s of [
    'Not end-to-end encrypted: Ravi Kumar is on an older version of Dexterity Connect.',
    'Not end-to-end encrypted: Ravi Kumar, Asha Iyer are on an older version of Dexterity Connect.',
    'Ravi Kumar is on an older version of Dexterity Connect, which cannot encrypt messages. Your office requires Direct messages to be end-to-end encrypted, so nothing can be sent here until they update. Opening the updated app once is enough.',
    'Your office requires Direct messages to be end-to-end encrypted. You can write here once Ravi Kumar updates Dexterity Connect.',
  ]) {
    const out = tr(s);
    assert.ok(out.includes('Ravi Kumar'), `the whole name stays in one piece: ${out}`);
    assert.equal(english(out, 'Ravi Kumar', 'Asha Iyer'), null, `no English left in: ${out}`);
  }
});

test('counts and states are whole phrases', () => {
  for (const s of ['A required update is downloading', 'A required update is ready', '1 copy', '12 copies', '1 device outside now', '3 devices outside now',
    'Ravi Kumar can sign in again on 2 devices', 'Handed to Ravi Kumar: 2 Spaces.', '1 meeting cancelled.', 'Checked: database sound', 'Fix the problem marked first.']) {
    const out = tr(s);
    assert.notEqual(out, s);
    assert.equal(english(out, 'Ravi Kumar'), null, `no English left in: ${out}`);
  }
  assert.equal(tr('3 meetings'), '3 मीटिंग');
  assert.equal(tr('What Ravi Kumar looks after'), 'वे काम जो Ravi Kumar सँभालते हैं');
});

test('a phrase with a number box in it keeps the box where the translation puts it', () => {
  const [before, after] = tr('one a day for {0} days').split('{0}').map((x) => x.trim());
  assert.equal(before, '');
  assert.equal(english(after), null);
});

test('placeholder text with line breaks is found', () => {
  assert.equal(tr('Small\nMedium\nLarge'), 'छोटा\nमध्यम\nबड़ा');
  assert.equal(tr('One choice per line\nYes\nNo'), 'हर पंक्ति में एक विकल्प\nहाँ\nनहीं');
});
