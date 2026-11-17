import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DATA_LOCATION_FILE, resolveDataDir } from '../src/data-dir.ts';

const exe = path.join(path.sep, 'opt', 'hub', 'DexterityConnectHub.exe');
const exeDir = path.dirname(exe);
const files = (map: Record<string, string>) => (file: string) => map[file] ?? null;

test('the environment variable wins', () => {
  const dir = resolveDataDir({ env: { DEXCONNECT_DATA_DIR: 'E:\\HubData' }, execPath: exe, cwd: '/x',
    readFile: files({ [path.join(exeDir, DATA_LOCATION_FILE)]: 'D:\\Elsewhere' }) });
  assert.equal(dir, 'E:\\HubData');
});

test('run from source with node: hub-data in the current folder', () => {
  assert.equal(resolveDataDir({ env: {}, execPath: '/usr/bin/node', cwd: '/src' }), path.join('/src', 'hub-data'));
});

test('the packaged program follows hub-data-location.txt (as the setup writes it)', () => {
  const read = files({ [path.join(exeDir, DATA_LOCATION_FILE)]: '\uFEFF# written by setup\r\nC:\\ProgramData\\Dexterity Connect Hub\\hub-data\r\n' });
  assert.equal(resolveDataDir({ env: {}, execPath: exe, cwd: '/x', readFile: read }), 'C:\\ProgramData\\Dexterity Connect Hub\\hub-data');
});

test('without the file, or with a relative path in it, hub-data beside the program (the zip layout)', () => {
  assert.equal(resolveDataDir({ env: {}, execPath: exe, cwd: '/x', readFile: files({}) }), path.join(exeDir, 'hub-data'));
  const rel = files({ [path.join(exeDir, DATA_LOCATION_FILE)]: 'hub-data\n' });
  assert.equal(resolveDataDir({ env: {}, execPath: exe, cwd: '/x', readFile: rel }), path.join(exeDir, 'hub-data'));
  assert.equal(resolveDataDir({ env: { DEXCONNECT_DATA_DIR: '  ' }, execPath: exe, cwd: '/x', readFile: files({}) }), path.join(exeDir, 'hub-data'));
});
