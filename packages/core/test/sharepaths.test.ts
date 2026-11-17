// Share paths whatever drive letter each person uses: reading paths as people paste them,
// finding them in running text (English, Hindi, Tamil), UNC ↔ drive letter through a drive map,
// the outgoing rewrite and how one path reads for each reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath, toUnc, toLocal, findPaths, shareableText, localText, viewPath, cleanMappings, networkRoots, candidates, folderOf, toFileUrl, under,
} from '../src/sharepaths.ts';
import type { DriveMap } from '../src/sharepaths.ts';

const map = (o: Record<string, string>) => cleanMappings(Object.entries(o).map(([letter, root]) => ({ letter, root })));
const VIKRAM = map({ X: '\\\\nas01\\Project', W: '\\\\nas02\\Submissions' });
const PRIYA = map({ Z: '\\\\NAS01\\project', J: '\\\\nas01\\Project\\Jobs' });
const known = (drives = VIKRAM): DriveMap => ({ known: true, drives });
const none: DriveMap = { known: false, drives: [] };

test('parse: UNC and drive paths, normalised', () => {
  assert.deepEqual(parsePath('\\\\nas01\\Project\\P12513'), { kind: 'unc', path: '\\\\nas01\\Project\\P12513', server: 'nas01', share: 'Project', trailing: false });
  assert.deepEqual(parsePath('x:\\P12513\\Iso'), { kind: 'drive', path: 'X:\\P12513\\Iso', letter: 'X:', trailing: false });
  assert.equal(parsePath('X:')?.path, 'X:\\');
  assert.equal(parsePath('X:\\')?.path, 'X:\\');
});

test('parse: trailing slashes are remembered but not part of the path', () => {
  const p = parsePath('\\\\nas01\\Project\\P12513\\\\')!;
  assert.equal(p.path, '\\\\nas01\\Project\\P12513');
  assert.equal(p.trailing, true);
  assert.equal(parsePath('X:\\Jobs\\')?.trailing, true);
  assert.equal(parsePath('X:\\')?.trailing, false);
});

test('parse: forward slashes and doubled separators', () => {
  assert.equal(parsePath('//nas01/Project/P12513/Iso')?.path, '\\\\nas01\\Project\\P12513\\Iso');
  assert.equal(parsePath('X:/P12513/Iso/GA-101.pdf')?.path, 'X:\\P12513\\Iso\\GA-101.pdf');
  assert.equal(parsePath('\\\\nas01\\\\Project\\.\\P12513')?.path, '\\\\nas01\\Project\\P12513');
});

test('parse: paths in quotes', () => {
  assert.equal(parsePath('"X:\\P 12513\\Iso"')?.path, 'X:\\P 12513\\Iso');
  assert.equal(parsePath('“\\\\nas01\\Project\\P-12 Piping”')?.path, '\\\\nas01\\Project\\P-12 Piping');
  assert.equal(parsePath("'Z:\\Jobs'")?.path, 'Z:\\Jobs');
});

test('parse: file:// URLs', () => {
  assert.equal(parsePath('file://nas01/Project/P12513/GA%20101.pdf')?.path, '\\\\nas01\\Project\\P12513\\GA 101.pdf');
  assert.equal(parsePath('file:///X:/P12513/Iso/')?.path, 'X:\\P12513\\Iso');
  assert.equal(parsePath('file://localhost/C:/Users/me')?.path, 'C:\\Users\\me');
  assert.equal(parsePath('file:////nas01/Project/x')?.path, '\\\\nas01\\Project\\x');
  assert.equal(parsePath('file://nas01/Project/%E0%A4%A'), null, 'broken escapes are not a path');
  assert.equal(toFileUrl('\\\\nas01\\Project\\GA 101.pdf'), 'file://nas01/Project/GA%20101.pdf');
  assert.equal(toFileUrl('X:\\Jobs\\'), 'file:///X:/Jobs/');
});

test('parse: \\\\?\\UNC\\ and \\\\?\\X:\\ long paths; device paths and tricks are refused', () => {
  assert.equal(parsePath('\\\\?\\UNC\\nas01\\Project\\P12513')?.path, '\\\\nas01\\Project\\P12513');
  assert.equal(parsePath('\\\\?\\X:\\P12513')?.path, 'X:\\P12513');
  for (const bad of ['\\\\.\\pipe\\x', '\\\\?\\GLOBALROOT\\x', '\\\\server', 'X:\\a\\..\\Windows', 'X:\\a*b', 'X:\\a?b', 'X:\\a|b', 'X:\\a\u0000b', 'X:\\file.txt:secret', 'relative\\x', 'https://x', '', '/etc/passwd']) {
    assert.equal(parsePath(bad), null, bad);
  }
});

test('parse: spaces and Unicode in names', () => {
  assert.equal(parsePath('\\\\nas01\\Project\\P-12 Piping\\लाइन सूची.xlsx')?.path, '\\\\nas01\\Project\\P-12 Piping\\लाइन सूची.xlsx');
  assert.equal(parsePath('X:\\திட்டம்\\வரைபடம் 1.pdf')?.path, 'X:\\திட்டம்\\வரைபடம் 1.pdf');
});

test('UNC ↔ letter: drive letters and server or share names in any case', () => {
  assert.equal(toUnc('x:\\P12513\\Iso', VIKRAM), '\\\\nas01\\Project\\P12513\\Iso');
  assert.equal(toLocal('\\\\NAS01\\PROJECT\\P12513\\Iso', VIKRAM), 'X:\\P12513\\Iso');
  assert.equal(toLocal('\\\\nas01\\project', VIKRAM), 'X:\\');
  assert.equal(toLocal('\\\\nas01\\Projects\\P12513', VIKRAM), null, 'a share whose name starts the same is another share');
  assert.equal(toUnc('C:\\Users\\vikram', VIKRAM), null, 'a local drive has no UNC form');
  assert.equal(toUnc('\\\\nas01\\Project\\x', VIKRAM), '\\\\nas01\\Project\\x');
  assert.equal(under('\\\\nas01\\Project\\Jobs', '\\\\NAS01\\project\\'), '\\Jobs');
});

test('UNC ↔ letter: a mapped root that is a folder inside a share', () => {
  const m = map({ X: '\\\\nas01\\Project\\Jobs' });
  assert.equal(toUnc('X:\\P12513', m), '\\\\nas01\\Project\\Jobs\\P12513');
  assert.equal(toLocal('\\\\nas01\\Project\\Jobs\\P12513\\Iso', m), 'X:\\P12513\\Iso');
  assert.equal(toLocal('\\\\nas01\\Project\\Admin', m), null);
});

test('UNC ↔ letter: the longest mapping wins when two overlap', () => {
  assert.equal(toLocal('\\\\nas01\\Project\\Jobs\\P1\\GA.pdf', PRIYA), 'J:\\P1\\GA.pdf');
  assert.equal(toLocal('\\\\nas01\\Project\\Standards', PRIYA), 'Z:\\Standards');
  // two letters for the very same root: the first letter
  assert.equal(toLocal('\\\\nas01\\Project\\x', map({ Y: '\\\\nas01\\Project', P: '\\\\nas01\\Project' })), 'P:\\x');
});

test('subst drives: onto a mapped drive they lead to the share; onto a local folder they stay local', () => {
  const m = map({ X: '\\\\nas01\\Project', S: 'X:\\Jobs', T: 'C:\\Work', U: '\\\\nas01\\Project\\Std' });
  assert.equal(toUnc('S:\\P1', m), '\\\\nas01\\Project\\Jobs\\P1');
  assert.equal(toUnc('T:\\P1', m), null);
  assert.deepEqual(networkRoots(m).map((x) => x.letter), ['S:', 'U:', 'X:']);
  // a loop of subst drives ends
  assert.equal(toUnc('A:\\x', map({ A: 'B:\\', B: 'A:\\' })), null);
});

test('find: paths in running text, with the full stop at the end of a sentence left out', () => {
  const text = 'The GA is at X:\\P12513\\Iso\\GA-101.pdf. Standards: \\\\nas01\\Standards\\Rev4\\, and see "Z:\\P 12\\GA 1.pdf" or file:///X:/P12513/a%20b.pdf!';
  assert.deepEqual(findPaths(text).map((s) => s.path), ['X:\\P12513\\Iso\\GA-101.pdf', '\\\\nas01\\Standards\\Rev4\\', 'Z:\\P 12\\GA 1.pdf', 'file:///X:/P12513/a%20b.pdf']);
  assert.deepEqual(findPaths('(see X:\\Jobs\\P1)').map((s) => s.path), ['X:\\Jobs\\P1']);
  assert.deepEqual(findPaths('X:\\Jobs\\P-12 (Rev B)').map((s) => s.path), ['X:\\Jobs\\P-12'], 'unquoted paths end at a space');
  assert.deepEqual(findPaths('https://example.com/a and mailto:x and 10:30 and C:Windows and abc:\\x').map((s) => s.path), []);
});

test('find: Hindi and Tamil text around paths', () => {
  const hi = 'ड्रॉइंग X:\\P12513\\Iso\\GA-101.pdf में है। फ़ोल्डर \\\\nas01\\Project\\P12513\\Iso देखें।';
  assert.deepEqual(findPaths(hi).map((s) => s.path), ['X:\\P12513\\Iso\\GA-101.pdf', '\\\\nas01\\Project\\P12513\\Iso']);
  assert.deepEqual(findPaths('फ़ाइल:X:\\Jobs\\P1।').map((s) => s.path), [], 'a letter glued to a colon is not a drive');
  assert.deepEqual(findPaths('फ़ाइल X:\\Jobs\\P1।').map((s) => s.path), ['X:\\Jobs\\P1'], 'the danda ends the sentence, not the path');
  const ta = 'வரைபடம் Z:\\P12513\\வரைபடங்கள்\\GA-101.pdf இல் உள்ளது.';
  assert.deepEqual(findPaths(ta).map((s) => s.path), ['Z:\\P12513\\வரைபடங்கள்\\GA-101.pdf']);
});

test('find: code is left out when asked', () => {
  assert.deepEqual(findPaths('run `X:\\tools\\a.bat` then X:\\Jobs', { skipCode: true }).map((s) => s.path), ['X:\\Jobs']);
  assert.deepEqual(findPaths('```\nX:\\tools\n```', { skipCode: true }), []);
});

test('outgoing: mapped letters become UNC, local drives and code stay as written', () => {
  const out = shareableText('GA at X:\\P12513\\Iso\\GA-101.pdf. Notes in C:\\Users\\vikram\\notes.txt, `X:\\tools` and "X:\\P 12\\" and file:///X:/P1/a%20b.pdf', VIKRAM);
  assert.equal(out, 'GA at \\\\nas01\\Project\\P12513\\Iso\\GA-101.pdf. Notes in C:\\Users\\vikram\\notes.txt, `X:\\tools` and "\\\\nas01\\Project\\P 12\\" and file://nas01/Project/P1/a%20b.pdf');
  assert.equal(shareableText(out, VIKRAM), out, 'idempotent');
  assert.equal(localText(out, VIKRAM), 'GA at X:\\P12513\\Iso\\GA-101.pdf. Notes in C:\\Users\\vikram\\notes.txt, `X:\\tools` and "X:\\P 12\\" and file:///X:/P1/a%20b.pdf');
  assert.equal(shareableText('nothing here', []), 'nothing here');
});

test('reader: a UNC path shows with the reader\'s own letter, or as UNC', () => {
  const unc = '\\\\nas01\\Project\\P12513\\Iso\\GA-101.pdf';
  const v = viewPath(unc, { mine: known(VIKRAM), writer: null, writerIsMe: false })!;
  assert.equal(v.shown, 'X:\\P12513\\Iso\\GA-101.pdf');
  assert.equal(v.unc, unc);
  assert.equal(v.folder, false);
  assert.equal(viewPath(unc, { mine: known(PRIYA), writer: null, writerIsMe: false })!.shown, 'Z:\\P12513\\Iso\\GA-101.pdf');
  assert.equal(viewPath(unc, { mine: none, writer: null, writerIsMe: false })!.shown, unc);
  assert.equal(viewPath('\\\\nas01\\Project\\Jobs\\P1\\', { mine: known(PRIYA), writer: null, writerIsMe: false })!.shown, 'J:\\P1\\');
});

test('reader: legacy drive-letter paths go through the writer\'s map when the hub knows it', () => {
  const v = viewPath('X:\\P12513\\Iso', { mine: known(PRIYA), writer: known(VIKRAM), writerIsMe: false })!;
  assert.equal(v.via, 'writer');
  assert.equal(v.unc, '\\\\nas01\\Project\\P12513\\Iso');
  assert.equal(v.shown, 'Z:\\P12513\\Iso');
  assert.equal(v.open, '\\\\nas01\\Project\\P12513\\Iso');
  // the writer's map is known and says the letter is not a share: only on their PC
  const local = viewPath('C:\\Users\\vikram\\calc.xlsx', { mine: known(PRIYA), writer: known(VIKRAM), writerIsMe: false })!;
  assert.equal(local.scope, 'local');
  assert.equal(local.owner, 'writer');
  assert.equal(local.open, null);
  // nothing known: as written, with the hint
  const unknown = viewPath('X:\\P12513', { mine: known(PRIYA), writer: none, writerIsMe: false })!;
  assert.equal(unknown.scope, 'unknown');
  assert.equal(unknown.hint, true);
  assert.equal(unknown.shown, 'X:\\P12513');
  assert.equal(unknown.open, null, 'Priya has no X: to try');
  assert.equal(viewPath('Z:\\P12513', { mine: known(PRIYA), writer: none, writerIsMe: false })!.open, 'Z:\\P12513', 'her own Z: is worth a try');
});

test('reader: the writer sees what they typed; their own local paths are only on this PC', () => {
  const v = viewPath('X:\\P12513', { mine: known(VIKRAM), writer: null, writerIsMe: true })!;
  assert.equal(v.scope, 'share');
  assert.equal(v.shown, 'X:\\P12513');
  const c = viewPath('C:\\Users\\vikram', { mine: known(VIKRAM), writer: null, writerIsMe: true })!;
  assert.equal(c.scope, 'local');
  assert.equal(c.owner, 'me');
  assert.equal(c.open, 'C:\\Users\\vikram');
});

test('helpers: the folder of a file; the ways to reach a path', () => {
  assert.equal(folderOf('\\\\nas01\\Project\\P1\\GA.pdf', false), '\\\\nas01\\Project\\P1');
  assert.equal(folderOf('X:\\GA.pdf', false), 'X:\\');
  assert.equal(folderOf('X:\\Jobs\\', true), 'X:\\Jobs');
  assert.deepEqual(candidates('Z:\\P1', PRIYA), ['Z:\\P1', '\\\\NAS01\\project\\P1']);
  assert.deepEqual(candidates('\\\\nas01\\Project\\P1', PRIYA), ['\\\\nas01\\Project\\P1', 'Z:\\P1']);
});

test('cleanMappings: hostile input is dropped', () => {
  assert.deepEqual(cleanMappings([null, 1, { letter: 'XY', root: '\\\\a\\b' }, { letter: 'X:', root: 'X:\\' }, { letter: 'Y', root: '\\\\a' }, { letter: 'k', root: '\\\\a\\b' }]), [{ letter: 'K:', root: '\\\\a\\b' }]);
  assert.deepEqual(cleanMappings('nope'), []);
});

test('speed: a long message with many paths is quick', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i} X:\\P${i}\\Iso\\GA-${i}.pdf and \\\\nas01\\Project\\P${i}.`).join('\n');
  const t = performance.now();
  const out = shareableText(text, VIKRAM);
  findPaths(out);
  assert.ok(performance.now() - t < 500, `took ${performance.now() - t} ms`);
});
