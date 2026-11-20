// Which way the phone tries first when it reconnects (route.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkKind, preferGateway, rememberRoute } from '../src/route.ts';

test('the network the WebView reports, roughly', () => {
  assert.equal(networkKind({ type: 'cellular' }), 'cellular');
  assert.equal(networkKind({ type: 'wifi' }), 'wifi');
  assert.equal(networkKind({ type: 'ethernet' }), 'wifi');
  assert.equal(networkKind({ type: 'unknown' }), 'other');
  assert.equal(networkKind(undefined), 'other', 'a WebView without the API');
});

test('on mobile data the gateway goes first; on Wi-Fi the way that worked last there', () => {
  const both = { hasGateway: true, hasOfficeAddress: true };
  assert.equal(preferGateway({ ...both, network: 'cellular', memory: undefined }), true);
  assert.equal(preferGateway({ ...both, network: 'cellular', memory: { cellular: 'lan' } }), true, 'an office address cannot work on mobile data');
  assert.equal(preferGateway({ ...both, network: 'wifi', memory: undefined }), false, 'the office network first by default');
  assert.equal(preferGateway({ ...both, network: 'wifi', memory: { wifi: 'remote' } }), true, 'home Wi-Fi: the gateway worked last time');
  assert.equal(preferGateway({ ...both, network: 'other', memory: { other: 'remote', wifi: 'lan' } }), true);
  // no choice to make
  assert.equal(preferGateway({ hasGateway: false, hasOfficeAddress: true, network: 'cellular', memory: undefined }), false);
  assert.equal(preferGateway({ hasGateway: true, hasOfficeAddress: false, network: 'wifi', memory: undefined }), false, 'the session goes to the gateway anyway');
});

test('the way that worked is remembered per kind of network, without needless writes', () => {
  const m1 = rememberRoute(undefined, 'wifi', 'remote');
  assert.deepEqual(m1, { wifi: 'remote' });
  assert.equal(rememberRoute(m1, 'wifi', 'remote'), m1, 'unchanged');
  assert.deepEqual(rememberRoute(m1, 'wifi', 'lan'), { wifi: 'lan' }, 'back at the office');
  assert.deepEqual(rememberRoute(m1, 'cellular', 'remote'), { wifi: 'remote', cellular: 'remote' });
});
