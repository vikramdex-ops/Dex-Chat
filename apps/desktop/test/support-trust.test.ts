// The IT Support service is only ever elevated from a folder people without administrator rights
// cannot change (review finding: a per-user install's exe could be swapped before the UAC prompt),
// and the programs that raise the prompt never come from paths the person who started the app set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedExe, windowsDir } from '../src/main/assist/trust.ts';

const env = ['C:\\Program Files'];

test('only an app installed for everyone may elevate its service exe', () => {
  assert.equal(trustedExe('C:\\Program Files\\Dexterity Connect\\resources\\support\\DexSupport.exe', env, true), true);
  assert.equal(trustedExe('c:\\program files\\dexterity connect\\resources\\support\\dexsupport.exe', env, true), true);
  assert.equal(trustedExe('C:\\Users\\priya\\AppData\\Local\\Programs\\Dexterity Connect\\resources\\support\\DexSupport.exe', env, true), false);
  assert.equal(trustedExe('C:\\Program Files Evil\\DexSupport.exe', env, true), false, 'a look-alike folder is not Program Files');
  assert.equal(trustedExe('C:\\Program Files\\..\\Users\\x\\DexSupport.exe', env, true), false);
  assert.equal(trustedExe('C:\\anything\\DexSupport.exe', [], true), false);
  assert.equal(trustedExe('Q:\\repo\\apps\\desktop\\build\\support\\DexSupport.exe', env, false), true, 'a development build');
});

test('the Windows folder never comes from the environment the app was started with', () => {
  const yes = () => true;
  assert.equal(windowsDir({}, yes), 'C:\\Windows');
  assert.equal(windowsDir({ SystemRoot: 'C:\\Windows', windir: 'c:\\windows' }, yes), 'C:\\Windows');
  assert.equal(windowsDir({ SystemRoot: 'C:\\Users\\me\\fake' }, yes), null, 'a changed SystemRoot is refused');
  assert.equal(windowsDir({ windir: 'D:\\Win' }, yes), null);
  assert.equal(windowsDir({}, () => false), null, 'no PowerShell where Windows keeps it');
});
