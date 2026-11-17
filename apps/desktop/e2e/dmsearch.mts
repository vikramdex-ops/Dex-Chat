// Searching end-to-end encrypted Direct messages: two apps exchange sealed messages (English,
// Hindi, Tamil); the hub holds only envelopes and its search finds nothing; each device finds them
// in its own encrypted index, marked "from this device". Messages sent while one app was closed
// are found after it starts again (background backfill of history). The index on disk holds no
// plaintext, and disconnecting from the office deletes it and its key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, both, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('dmsearch');
const a = await launch('priya', 'Priya Raman');
let b = await launch('ravi', 'Ravi Kumar');
const send = (p: any, convId: string, body: string) => p.evaluate(([c, t]: string[]) => window.dex.request('msg.send', { convId: c, body: t, clientId: `${Date.now()}-${Math.random()}` }), [convId, body]);

async function search(p: any, q: string, want: number, timeout = 30000) {
  const box = p.getByLabel('Search messages and files');
  if (!(await box.count())) await p.keyboard.press('Control+Shift+F');
  const end = Date.now() + timeout;
  for (;;) {
    await box.fill('');
    await box.fill(q);
    await sleep(900);
    const n = await p.locator('.search-hit').count();
    if (n === want || Date.now() > end) return n;
    await sleep(1500);
  }
}

try {
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const dm = await a.page.evaluate((id: string) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), ravi.id);
  await sleep(2000); // both apps publish their keys
  const status = await a.page.evaluate((id: string) => window.dex.e2eStatus!(id), dm.id);
  assert.equal(status.encrypted, true, 'the Direct conversation is end-to-end encrypted');

  await send(a.page, dm.id, 'Valve schedule for area 3 is ready, rev 4.2');
  await send(a.page, dm.id, 'पाइपलाइन का नक्शा तैयार है, कृपया जाँच लें');
  await send(b.page, dm.id, 'வால்வு அட்டவணை தயார், நாளை பார்க்கலாம்');
  await sleep(1500);
  const rows = (hub as any).messaging.db.prepare('SELECT body FROM messages WHERE conv_id = ?').all(dm.id) as Array<{ body: string }>;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.body.startsWith('e2e1:') && !/valve|नक्शा|வால்வு/i.test(r.body)), 'the hub holds only sealed envelopes');

  // Ravi never opened the conversation: what arrived was indexed as it came in
  assert.equal(await search(b.page, 'valve sched', 1), 1, 'English, by prefixes of two words');
  const hit = b.page.locator('.search-hit').first();
  assert.match(await hit.innerText(), /from this device/i);
  assert.match(await hit.locator('mark').first().innerText(), /Valve/);
  assert.equal(await search(b.page, 'नक्श', 1), 1, 'Hindi, by prefix');
  assert.equal(await search(b.page, 'வால்வு', 1), 1, 'Tamil');
  assert.equal(await search(b.page, 'தயா', 1), 1, 'Tamil, by prefix');
  // a filter the index understands: by whom
  await search(b.page, 'valve', 1);
  await both(b.page, 'dm-01-search-1280');
  // Priya finds what she sent and received too
  assert.equal(await search(a.page, 'அட்டவணை', 1), 1);
  assert.equal(await search(a.page, 'rev 4.2', 1), 1);
  // opening a result goes to the message
  await a.page.locator('.search-hit').first().click();
  await a.page.locator('.msg', { hasText: 'Valve schedule for area 3' }).waitFor({ timeout: 15000 });

  // ---- Ravi closes the app; Priya writes meanwhile; Ravi's app catches up in the background
  const userData = b.userData;
  await b.app.close();
  await send(a.page, dm.id, 'Flange gasket order placed with the vendor today');
  await send(a.page, dm.id, 'गैस्केट का ऑर्डर दे दिया गया है');
  b = await launch('ravi', 'Ravi Kumar', { userData, rejoin: true });
  assert.equal(await search(b.page, 'gasket', 1, 45000), 1, 'history written while closed is found (backfill)');
  assert.equal(await search(b.page, 'गैस्', 1), 1);
  assert.equal(await search(b.page, 'valve', 1), 1, 'what was indexed before the restart is still there');

  // ---- on disk: encrypted records only, sealed by a key in the system's secure storage
  const disk = await b.page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name ?? '').filter((n) => n.startsWith('dex-search:'));
    const out: { dbs: string[]; records: number; plain: boolean; shapes: string[] } = { dbs, records: 0, plain: false, shapes: [] };
    for (const name of dbs) {
      const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all = await new Promise<any[]>((res) => { const r = db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); });
      const keys = await new Promise<any[]>((res) => { const r = db.transaction('records').objectStore('records').getAllKeys(); r.onsuccess = () => res(r.result); });
      out.records += all.length;
      const words = ['valve', 'gasket', 'flange', 'नक्शा', 'வால்வு'].map((w) => new TextEncoder().encode(w));
      for (const v of all) {
        out.shapes.push(Object.keys(v).sort().join(','));
        const bytes = new Uint8Array(v.ct);
        for (const w of words) for (let i = 0; i + w.length <= bytes.length; i++) if (w.every((x, j) => bytes[i + j] === x)) out.plain = true;
      }
      out.shapes = [...new Set(out.shapes)];
      void keys;
      db.close();
    }
    return out;
  });
  console.log('on disk:', disk);
  assert.equal(disk.dbs.length, 1);
  assert.ok(disk.records >= 7, 'the index, its progress, the check and the messages');
  assert.deepEqual(disk.shapes, ['ct,iv']);
  assert.equal(disk.plain, false, 'no plaintext on disk');
  const keyFile = path.join(userData, 'search-index-keys.bin');
  assert.ok(fs.existsSync(keyFile));
  // sealed means not readable as the JSON it holds (random ciphertext can contain a stray '{' byte)
  const keyText = fs.readFileSync(keyFile).toString('latin1');
  let readable = true;
  try { JSON.parse(keyText); } catch { readable = false; }
  assert.ok(!readable && !keyText.includes('":"'), 'the key file is sealed by the system');
  await both(b.page, 'dm-02-after-restart-1280');
  // phone width
  const bw = await b.app.browserWindow(b.page);
  await bw.evaluate((w: any) => w.setSize(390, 844));
  await b.page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  await search(b.page, 'gasket', 1);
  await both(b.page, 'dm-03-search-390');

  // ---- disconnecting from the office deletes the index and its key
  await b.page.evaluate(() => window.dex.forgetHub());
  await b.page.waitForFunction(async () => !(await indexedDB.databases()).some((d) => (d.name ?? '').startsWith('dex-search:')), null, { timeout: 15000 });
  for (let i = 0; i < 20 && fs.existsSync(keyFile); i++) await sleep(250);
  assert.equal(fs.existsSync(keyFile), false, 'the key is gone');
  console.log('DMSEARCH E2E PASSED');
} catch (e) {
  await shot(a.page, 'dm-FAIL-a').catch(() => {});
  await shot(b.page, 'dm-FAIL-b').catch(() => {});
  throw e;
} finally {
  await a.app.close();
  await b.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
