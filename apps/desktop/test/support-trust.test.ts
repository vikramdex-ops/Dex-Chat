// The IT Support service is only ever elevated from a folder people without administrator rights
// cannot change (review finding: a per-user install's exe could be swapped before the UAC prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedExe } from '../src/main/assist/trust.ts';

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
