// Nib's "How do I…" answers name buttons, menus and shortcuts of the app. Each topic lists those
// labels (`ui`), and every one must still be in the app: a renamed button breaks this test, not the
// answer someone reads. The renderer source is read as text, so nothing here runs the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const RENDERER = path.join(import.meta.dirname, '../src/renderer');
const SKILLS = path.join(RENDERER, 'nib/skills.tsx');

/** Every .ts/.tsx file of the renderer except the help topics themselves. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === 'i18n' ? [] : sources(p);
    return /\.tsx?$/.test(n) && p !== SKILLS ? [p] : [];
  });
}
const app = sources(RENDERER).map((p) => readFileSync(p, 'utf8')).join('\n');
const commands = readFileSync(path.join(RENDERER, 'chat/commands.ts'), 'utf8');

interface Topic { title: string; steps: string[]; ui: string[] }
const strings = (s: string) => [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
function topics(): Topic[] {
  const src = readFileSync(SKILLS, 'utf8');
  const block = src.slice(src.indexOf('const TOPICS: Topic[] = ['), src.indexOf('function Help('));
  return block.split('\n').filter((l) => l.trim().startsWith('{ keys:')).map((l) => ({
    title: /title: '([^']*)'/.exec(l)?.[1] ?? '',
    steps: strings(/steps: \[(.*?)\]/.exec(l)?.[1] ?? ''),
    ui: strings(/ui: \[(.*?)\]/.exec(l)?.[1] ?? ''),
  }));
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The label as a whole string or a whole piece of text in the source: 'Add my phone', >Add my phone<. */
const inApp = (label: string) => new RegExp(`['"\`>]${esc(label)}(?:['"\`<{…]|\\s*<)`).test(app);

test('every help topic lists the labels it names', () => {
  const list = topics();
  assert.ok(list.length >= 15, `${list.length} topics read`);
  for (const t of list) {
    assert.ok(t.title && t.steps.length, `a topic with a title and steps: ${JSON.stringify(t)}`);
    assert.ok(t.ui.length, `${t.title}: names at least one label`);
    const words = t.steps.join(' ');
    for (const label of t.ui) assert.ok(words.includes(label), `${t.title}: "${label}" is in its steps`);
  }
});

test('every label a help topic names exists in the app', () => {
  for (const t of topics()) {
    for (const label of t.ui) {
      if (label.startsWith('/')) assert.match(commands, new RegExp(`command: '${esc(label.slice(1))}'`), `${t.title}: ${label} is a slash command`);
      else assert.ok(inApp(label), `${t.title}: "${label}" is not a label anywhere in the app`);
    }
  }
});

test('the answers the user guide found wrong stay right', () => {
  const words = topics().flatMap((t) => t.steps).join('\n');
  assert.doesNotMatch(words, /Ctrl\+K/, 'Ctrl+K adds a link while writing; search is Ctrl+Shift+F');
  assert.doesNotMatch(words, /Add a phone/);
  assert.doesNotMatch(words, /the Room button/);
  assert.ok(inApp('Help me…'), 'the fallback line names Help me… in the tile menu');
  // and the checker itself finds a label that is not there
  assert.equal(inApp('Add a phone'), false);
});
