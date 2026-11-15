// Open folder on a link card: only Windows share and drive folders that exist are opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type fs from 'node:fs';
import { checkFolder, windowsFolderPath } from '../src/main/folders.ts';

const dir = { isDirectory: () => true } as fs.Stats;
const file = { isDirectory: () => false } as fs.Stats;

test('share and drive paths are accepted; anything else is not a folder we open', () => {
  assert.equal(windowsFolderPath('\\\\fs01\\jobs\\P-12513\\ISO'), '\\\\fs01\\jobs\\P-12513\\ISO');
  assert.equal(windowsFolderPath('  D:\\Projects\\P-12  '), 'D:\\Projects\\P-12');
  assert.equal(windowsFolderPath('file://fs01/jobs/P-12%20Piping'), '\\\\fs01\\jobs\\P-12 Piping');
  assert.equal(windowsFolderPath('file:///D:/Projects/P-12'), 'D:\\Projects\\P-12');
  for (const bad of [
    '', '/etc', 'C:', 'relative\\folder', 'https://example.test/', 'calc.exe', '\\\\?\\C:\\Windows', '\\\\.\\pipe\\x', '\\\\server',
    'D:\\Projects\\..\\Windows', '\\\\fs01\\jobs\\..\\..\\admin$', 'D:\\a*b', 'D:\\a?b', 'D:\\a|b', 'D:\\a\u0000b', 'D:\\file.txt:secret',
    `D:\\${'x'.repeat(1100)}`, 42, null, undefined, { path: 'D:\\x' },
  ]) assert.equal(windowsFolderPath(bad), null, String(bad));
});

test('only folders that exist open, and only on Windows', async () => {
  assert.equal(await checkFolder('\\\\fs01\\jobs', 'win32', async () => dir), '\\\\fs01\\jobs\\', 'a share root keeps its closing backslash');
  await assert.rejects(checkFolder('\\\\fs01\\jobs\\run.bat', 'win32', async () => file), /a file, not a folder/);
  await assert.rejects(checkFolder('\\\\fs01\\gone', 'win32', async () => { throw new Error('ENOENT'); }), /cannot be found/);
  await assert.rejects(checkFolder('\\\\fs01\\jobs', 'linux', async () => dir), /open on Windows PCs/);
  let asked = 0;
  await assert.rejects(checkFolder('C:\\Windows\\..\\x', 'win32', async () => { asked++; return dir; }), /Only folders on the office share/);
  assert.equal(asked, 0, 'a refused path is never looked at');
});
