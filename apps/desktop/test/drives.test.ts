// This PC's drive letters: what `reg query`, `net use` and `subst` print (English and German
// Windows), merged; the one-minute cache; access checks and Open folder through whichever form
// of a path works. The Windows programs themselves only run on Windows: these are their outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type fs from 'node:fs';
import { Drives, mergeMappings, parseNetUse, parseRegNetwork, parseSubst, readTestHook, readWindowsDrives } from '../src/main/drives.ts';

const REG_EN = [
  '',
  'HKEY_CURRENT_USER\\Network\\X',
  '    RemotePath    REG_SZ    \\\\nas01\\Project',
  '',
  'HKEY_CURRENT_USER\\Network\\w',
  '    RemotePath    REG_SZ    \\\\nas02\\Submissions\\P 12513',
  '',
  'HKEY_CURRENT_USER\\Network\\Z',
  '    RemotePath    REG_EXPAND_SZ    \\\\dexterity.local\\dfs\\Standards',
  '',
  'End of search: 3 match(es) found.',
  '',
].join('\r\n');

// German Windows: the closing line is translated; key names and value types are not
const REG_DE = [
  '',
  'HKEY_CURRENT_USER\\Network\\P',
  '    RemotePath    REG_SZ    \\\\nas01\\Projekte\\Übergabe',
  '',
  'Suche beendet: 1 Übereinstimmung(en) gefunden.',
].join('\r\n');

const NET_EN = `New connections will be remembered.


Status       Local     Remote                    Network

-------------------------------------------------------------------------------
OK           X:        \\\\nas01\\Project           Microsoft Windows Network
Disconnected Y:        \\\\nas01\\Old Archive       Microsoft Windows Network
Unavailable  J:        \\\\nas01\\Project\\Jobs\\Very Long Folder Name For Wrapping
                                                Microsoft Windows Network
OK                     \\\\nas01\\IPC$              Microsoft Windows Network
The command completed successfully.
`;

const NET_DE = `Neue Verbindungen werden gespeichert.


Status       Lokal     Remote                    Netzwerk

-------------------------------------------------------------------------------
OK           X:        \\\\nas01\\Projekte          Microsoft Windows-Netzwerk
Getrennt     Q:        \\\\nas01\\Qualität          Microsoft Windows-Netzwerk
Nicht verfügbar R:     \\\\nas03\\Rückläufe         Microsoft Windows-Netzwerk
Der Befehl wurde erfolgreich ausgeführt.
`;

const SUBST = 'S:\\: => C:\\Work\\Jobs\r\nT:\\: => UNC\\nas01\\Project\\Templates\r\nU:\\: => X:\\Standards\r\n';

test('reg query HKCU\\Network: persistent mappings (English)', () => {
  assert.deepEqual(parseRegNetwork(REG_EN), [
    { letter: 'W:', root: '\\\\nas02\\Submissions\\P 12513', source: 'registry' },
    { letter: 'X:', root: '\\\\nas01\\Project', source: 'registry' },
    { letter: 'Z:', root: '\\\\dexterity.local\\dfs\\Standards', source: 'registry' },
  ]);
});

test('reg query HKCU\\Network: German Windows, umlauts in a share name', () => {
  assert.deepEqual(parseRegNetwork(REG_DE), [{ letter: 'P:', root: '\\\\nas01\\Projekte\\Übergabe', source: 'registry' }]);
  assert.deepEqual(parseRegNetwork('ERROR: The system was unable to find the specified registry key or value.'), []);
  assert.deepEqual(parseRegNetwork(''), []);
});

test('net use: lines with a letter and a share, whatever the status words; wrapped lines and letterless connections', () => {
  assert.deepEqual(parseNetUse(NET_EN), [
    { letter: 'J:', root: '\\\\nas01\\Project\\Jobs\\Very Long Folder Name For Wrapping', source: 'net-use' },
    { letter: 'X:', root: '\\\\nas01\\Project', source: 'net-use' },
    { letter: 'Y:', root: '\\\\nas01\\Old Archive', source: 'net-use' },
  ]);
});

test('net use: German Windows (translated header, status and closing line)', () => {
  assert.deepEqual(parseNetUse(NET_DE), [
    { letter: 'Q:', root: '\\\\nas01\\Qualität', source: 'net-use' },
    { letter: 'R:', root: '\\\\nas03\\Rückläufe', source: 'net-use' },
    { letter: 'X:', root: '\\\\nas01\\Projekte', source: 'net-use' },
  ]);
  assert.deepEqual(parseNetUse('There are no entries in the list.'), []);
});

test('subst: onto local folders, onto a share (UNC\\…) and onto a mapped drive', () => {
  assert.deepEqual(parseSubst(SUBST), [
    { letter: 'S:', root: 'C:\\Work\\Jobs', source: 'subst' },
    { letter: 'T:', root: '\\\\nas01\\Project\\Templates', source: 'subst' },
    { letter: 'U:', root: 'X:\\Standards', source: 'subst' },
  ]);
});

test('merged: net use (what is connected now) wins over the registry; subst adds its letters', async () => {
  const merged = mergeMappings(parseRegNetwork(REG_EN), parseNetUse(NET_EN), parseSubst(SUBST));
  assert.deepEqual(merged.map((m) => `${m.letter}${m.root}`), [
    'J:\\\\nas01\\Project\\Jobs\\Very Long Folder Name For Wrapping', 'S:C:\\Work\\Jobs', 'T:\\\\nas01\\Project\\Templates', 'U:X:\\Standards',
    'W:\\\\nas02\\Submissions\\P 12513', 'X:\\\\nas01\\Project', 'Y:\\\\nas01\\Old Archive', 'Z:\\\\dexterity.local\\dfs\\Standards',
  ]);
  // one program failing does not lose what the others said
  const asked: string[] = [];
  const got = await readWindowsDrives(async (file) => { asked.push(file); if (file === 'net') throw new Error('no'); return file === 'reg' ? REG_DE : ''; });
  assert.deepEqual(asked.sort(), ['net', 'reg', 'subst']);
  assert.deepEqual(got.map((m) => m.letter), ['P:']);
});

test('the map is cached for a minute, read again on demand, and changes are announced', async () => {
  let now = 1_000_000;
  let reads = 0;
  let list = [{ letter: 'X:', root: '\\\\nas01\\Project' }];
  const d = new Drives({ platform: 'win32', now: () => now, read: async () => { reads++; return list; } });
  const seen: number[] = [];
  d.onChange((m) => seen.push(m.drives.length));
  assert.equal((await d.get()).known, true);
  await d.get();
  now += 30_000;
  await d.get();
  assert.equal(reads, 1, 'focus within a minute costs nothing');
  now += 31_000;
  await d.get();
  assert.equal(reads, 2);
  list = [...list, { letter: 'Z:', root: '\\\\nas01\\Standards' }];
  await d.get(true);
  assert.equal(reads, 3);
  assert.deepEqual(seen, [1, 2], 'announced when it changes, not on every read');
  // off Windows there are no drive letters
  const mac = new Drives({ platform: 'darwin', read: async () => { throw new Error('never'); } });
  assert.deepEqual(await mac.get(), { known: false, drives: [] });
  assert.equal(await mac.check('\\\\nas01\\Project'), 'unknown');
});

const stats = (dirs: string[], files: string[] = [], denied: string[] = []) => async (p: string): Promise<fs.Stats> => {
  if (denied.includes(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  if (dirs.includes(p)) return { isDirectory: () => true, isFile: () => false } as fs.Stats;
  if (files.includes(p)) return { isDirectory: () => false, isFile: () => true } as fs.Stats;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('access: no access, missing, the server off the network; cached for a minute', async () => {
  let probes = 0;
  let up = true;
  const d = new Drives({
    platform: 'win32', read: async () => [{ letter: 'X:', root: '\\\\nas01\\Project' }],
    stat: async (p) => { probes++; return stats(['\\\\nas01\\Project\\P1', 'X:\\P1'], [], ['\\\\nas01\\Project\\HR', 'X:\\HR'])(p); },
    reach: async () => up,
  });
  assert.equal(await d.check('X:\\P1'), 'ok');
  assert.equal(await d.check('\\\\nas01\\Project\\HR'), 'denied');
  assert.equal(await d.check('\\\\nas01\\Project\\Gone'), 'missing');
  const n = probes;
  assert.equal(await d.check('X:\\P1'), 'ok');
  assert.equal(probes, n, 'cached');
  up = false;
  const d2 = new Drives({ platform: 'win32', read: async () => [], stat: async () => { throw new Error('never'); }, reach: async () => up });
  assert.equal(await d2.check('\\\\nas01\\Project\\P1'), 'offline');
});

test('Open folder and Open: whichever form works here; files only of document kinds', async () => {
  const opened: string[] = [];
  const d = new Drives({
    platform: 'win32', read: async () => [{ letter: 'Z:', root: '\\\\nas01\\Project' }],
    // say the UNC form is refused but the mapped drive works (credentials kept with the mapping)
    stat: stats(['Z:\\P1'], ['Z:\\P1\\GA.pdf', 'Z:\\P1\\run.bat']),
    open: async (p) => { opened.push(p); return ''; },
  });
  await d.openFolder('\\\\nas01\\Project\\P1');
  await d.openFile('\\\\NAS01\\project\\P1\\GA.pdf');
  assert.deepEqual(opened, ['Z:\\P1', 'Z:\\P1\\GA.pdf']);
  await assert.rejects(d.openFile('Z:\\P1\\run.bat'), /not opened from a message/);
  await assert.rejects(d.openFolder('Z:\\P1\\GA.pdf'), /cannot be found|a file, not a folder/);
  await assert.rejects(d.openFolder('\\\\.\\pipe\\x'), /Only paths/);
  await assert.rejects(new Drives({ platform: 'linux' }).openFolder('\\\\nas01\\Project'), /open on Windows PCs/);
});

test('the test hook: only in development builds, only when set; nothing is ever started', async () => {
  const hook = '{"drives":[{"letter":"X:","root":"\\\\\\\\nas01\\\\Project"}],"access":{"\\\\\\\\nas01\\\\Project\\\\HR":"denied"}}';
  assert.equal(readTestHook(hook, true), null, 'ignored in an installed (packaged) app');
  assert.equal(readTestHook(undefined, false), null);
  const h = readTestHook(hook, false)!;
  assert.deepEqual(h.drives, [{ letter: 'X:', root: '\\\\nas01\\Project', source: 'test' }]);
  let opened = 0;
  const d = new Drives({ platform: 'linux', testHook: () => h, open: async () => { opened++; return ''; } });
  assert.equal((await d.get()).known, true);
  assert.equal(await d.check('X:\\HR\\pay.xlsx'), 'denied');
  assert.equal(await d.check('X:\\P1'), 'ok');
  await d.openFolder('X:\\P1');
  await assert.rejects(d.openFolder('X:\\HR'), /don't have access/);
  assert.deepEqual(d.testShell, [{ kind: 'folder', path: 'X:\\P1' }]);
  assert.equal(opened, 0);
});
