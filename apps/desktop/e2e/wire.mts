// The message features wired to the hub: pins that end, kept kinds, #tags and Space references,
// a Space from a message, Direct with the people named, stickers, office emoji from anyone, file and
// scan answers in forms, integration actions, the document scanner, Cards, and keys you choose.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { createIdentity } from '../../../packages/core/src/index.ts';

/** A PNG drawn here: a disc in one colour on a transparent square. */
function png(W: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - W / 2 + 0.5, y - W / 2 + 0.5), o = y * (W * 4 + 1) + 1 + x * 4;
    const [r, g, b, a] = d < W * 0.3 ? [...rgb, 255] : d < W * 0.45 ? [28, 118, 128, 255] : [0, 0, 0, 0];
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hardHat = png(96, [247, 175, 68]);
const stickerFile = path.join(OUT, 'wire-valve.png'); fs.writeFileSync(stickerFile, png(96, [42, 140, 152]));
const emojiFile = path.join(OUT, 'pipe-ok.png'); fs.writeFileSync(emojiFile, png(32, [80, 160, 90]));
const photoFile = path.join(OUT, 'valve-photo.png'); fs.writeFileSync(photoFile, png(64, [200, 80, 60]));

const upload = (port: number, token: string, name: string, data: Buffer) => new Promise<{ id: string }>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, 'content-length': String(data.length) } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s)));
  });
  r.on('error', reject); r.end(data);
});

// an integration's webhook: answers "Log as defect" only to the person who asked
const hooked: any[] = [];
const hookServer = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { hooked.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'Defect D-17 logged', ephemeral: true })); });
});
await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
const hookPort = (hookServer.address() as { port: number }).port;

const { owner, hub } = await startOffice('wire');
const { app, page } = await launch('priya', 'Priya Raman');
async function colleague(username: string, displayName: string) {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName, hostname: `${username.toUpperCase()}-PC` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); res(); } }; c.on('state', on); });
  return c;
}
const theme = (t: 'light' | 'dark') => page.evaluate((x) => window.dex.setSettings({ theme: x }), t);
const toast = (re: RegExp) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 8000 });
const dock = () => page.locator('.pane .dock textarea').first();
const open = async (name: string) => { await page.locator('.lens-bar .lens', { hasText: 'Spaces' }).click(); await page.locator('.sb-row', { hasText: name }).first().click(); await page.locator('.pane-title h2', { hasText: name }).first().waitFor(); };
const moreOn = async (text: string) => {
  const m = page.locator('.timeline .msg', { hasText: text }).first();
  await m.waitFor();
  // the tool column shows while the pointer is on the message: try again if something moved it
  for (let i = 0; ; i++) {
    await m.scrollIntoViewIfNeeded(); await page.mouse.move(5, 5); await m.hover();
    try { await m.getByTitle('More', { exact: true }).click({ timeout: 4000 }); break; } catch (e) { if (i === 2) throw e; }
  }
  return m;
};
const passed: string[] = [];
const ok = (n: string) => { passed.push(n); console.log(`ok ${n}`); };

try {
  const ravi = await colleague('ravi', 'Ravi Kulkarni');
  const users = (await owner.request('directory.list')).users;
  const id = (n: string) => users.find((u: any) => u.account.endsWith(n))!.id;
  const [priyaId, raviId, vikramId] = [id('priya'), id('ravi'), id('vikram')];
  await owner.request('admin.policy.set', { memberEmoji: true });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priyaId, raviId] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', topic: 'Jamnagar site, day to day' });
  // an integration with a message action, and a sticker pack
  const { bot } = await owner.request('admin.bots.create', { name: 'Defect Log' });
  await owner.request('admin.bots.commands', { userId: bot.id, webhookUrl: `http://127.0.0.1:${hookPort}/hook`, commands: [], actions: [{ label: 'Log as defect', scope: 'spaces' }] });
  const hat = await upload(hub.port, (owner as any).session.fileToken, 'hard-hat.png', hardHat);
  await owner.request('sticker.add', { name: 'Hard hat', pack: 'Site kit', fileId: hat.id });
  await owner.request('msg.send', { convId: sp.id, body: 'Toolbox talk notes for the week are in the drive', clientId: 'w1' });
  await owner.request('msg.send', { convId: sp.id, body: 'Valve list updated for #valves on #p12 today', clientId: 'w2' });
  await owner.request('msg.send', { convId: sp.id, body: 'Nozzle N3 clashes with the platform at EL 104.5', clientId: 'w3' });
  await owner.request('msg.send', { convId: sp.id, body: `<@${raviId}> and <@${priyaId}> please check the isos before Friday`, clientId: 'w4' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await open('P-12 Piping');
  await page.locator('.timeline .msg', { hasText: 'please check the isos' }).waitFor();

  // 1. pins that end
  await moreOn('Toolbox talk notes');
  await page.getByRole('menuitem', { name: 'Pin for everyone' }).click();
  await page.locator('.pin-for').waitFor();
  await shot(page, 'wire-01-pin-for');
  await page.getByRole('menuitem', { name: 'For a week' }).click();
  const pinFlag = page.locator('.timeline .msg', { hasText: 'Toolbox talk notes' }).locator('.flag.pin');
  await pinFlag.waitFor();
  assert.match((await pinFlag.textContent())!.toUpperCase(), /^PINNED · TILL (\d{1,2} [A-Z]{3}|[A-Z]{3} \d{1,2})$/);
  const pinned = (await owner.request('msg.list', { convId: sp.id })).messages.find((m: any) => m.body.startsWith('Toolbox'));
  assert.ok(pinned.pinned && Math.abs(pinned.pinnedUntil - Date.now() - 7 * 86400_000) < 120_000, JSON.stringify(pinned));
  ok('1 pins that end');

  // 2. kinds of kept messages
  const nozzle = page.locator('.timeline .msg', { hasText: 'Nozzle N3' }).first();
  await nozzle.hover();
  await nozzle.getByTitle('Keep on my Desk').click();
  await page.locator('.keep-menu').waitFor();
  await shot(page, 'wire-02-keep-kinds');
  await page.getByRole('menuitemradio', { name: 'To do' }).click();
  await nozzle.locator('.flag.keep', { hasText: /To do/ }).waitFor();
  await sleep(300);
  const saved = await page.evaluate(() => window.dex.request('desk.saved'));
  assert.equal(saved[0].kind, 'todo');
  await nozzle.hover();
  await nozzle.getByTitle('On my Desk · To do').click();
  await page.getByRole('menuitemradio', { name: 'Follow up' }).click();
  await nozzle.locator('.flag.keep', { hasText: /Follow up/ }).waitFor();
  ok('2 kept kinds');

  // 3. hashtags, # suggestions and Space references
  await page.locator('.timeline .tag-chip', { hasText: '#valves' }).click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.waitFor();
  assert.equal(await search.locator('input').first().inputValue(), '#valves');
  await search.getByText(/Valve list updated/).first().waitFor();
  await shot(page, 'wire-03-tag-search');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached' });
  await dock().click();
  await dock().pressSequentially('Updated #val');
  await page.locator('.hash-pop li', { hasText: 'valves' }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await dock().inputValue(), 'Updated #valves ');
  await dock().pressSequentially('ask #Site');
  const siteOpt = page.locator('.hash-pop li', { hasText: 'Site team' });
  await siteOpt.waitFor();
  await shot(page, 'wire-04-hash-pop');
  await siteOpt.dispatchEvent('mousedown');
  assert.equal(await dock().inputValue(), 'Updated #valves ask #Site team ');
  await page.keyboard.press('Enter');
  const ref = page.locator('.timeline .msg', { hasText: 'Updated' }).locator('.space-ref.outside', { hasText: 'Site team' });
  await ref.waitFor();
  const sentBody = (await owner.request('msg.list', { convId: sp.id })).messages.find((m: any) => m.body.startsWith('Updated')).body;
  assert.equal(sentBody, `Updated #valves ask <#${site.id}>`);
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).locator('.sb-preview', { hasText: 'Updated #valves ask #Site team' }).waitFor({ state: 'attached' });
  await ref.click();
  await page.locator('.space-join').waitFor();
  await shot(page, 'wire-05-space-join');
  await page.getByRole('menuitem', { name: 'Join the Space' }).click();
  await page.locator('.pane-title h2', { hasText: 'Site team' }).waitFor();
  await open('P-12 Piping');
  await page.locator('.timeline .space-ref:not(.outside)', { hasText: 'Site team' }).waitFor();
  ok('3 hashtags and Space references');

  // 4. start a Space from a message
  await moreOn('Nozzle N3');
  await page.getByRole('menuitem', { name: 'Start a Space from this' }).click();
  const fork = page.getByRole('dialog', { name: 'Start a Space from this' });
  await fork.getByLabel('Name the Space').fill('Nozzle N3 clash');
  await fork.locator('.toggle-row').click();
  await shot(page, 'wire-06-fork');
  await fork.getByRole('button', { name: 'Start the Space' }).click();
  await page.locator('.pane-title h2', { hasText: 'Nozzle N3 clash' }).waitFor();
  await page.locator('.timeline .msg', { hasText: 'Nozzle N3 clashes' }).waitFor();
  const forked = (await owner.request('conv.list')).find((c: any) => c.name === 'Nozzle N3 clash');
  assert.ok(forked && forked.private && forked.members.includes(vikramId));
  ok('4 Space from a message');

  // 5. Direct with the people named
  await open('P-12 Piping');
  await moreOn('please check the isos');
  await page.getByRole('menuitem', { name: /Take to Direct with the people named/ }).click();
  await page.waitForFunction(() => /Vikram/.test(document.querySelector('.pane-title h2')?.textContent ?? '') && /Ravi/.test(document.querySelector('.pane-title h2')?.textContent ?? ''));
  await page.waitForFunction(() => /^> \*\*Vikram Shah:\*\* @Ravi Kulkarni and @Priya Raman please check/.test((document.querySelector('.pane .dock textarea') as HTMLTextAreaElement)?.value ?? '')
    || /^> \*\*Vikram Shah:\*\* <@/.test((document.querySelector('.pane .dock textarea') as HTMLTextAreaElement)?.value ?? ''));
  const group = (await page.evaluate(() => window.dex.request('conv.list'))).find((c: any) => c.kind === 'direct' && c.members.length === 3);
  assert.ok(group && [priyaId, raviId, vikramId].every((x) => group.members.includes(x)));
  await shot(page, 'wire-07-named-direct');
  await dock().fill('');
  ok('5 Direct with the people named');

  // 6. stickers
  await open('P-12 Piping');
  await page.getByTitle('Insert', { exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Stickers' }).click();
  const sheet = page.locator('.sticker-sheet');
  await sheet.getByRole('tab', { name: 'Site kit' }).waitFor();
  await sheet.locator('img.sticker').first().waitFor();
  await shot(page, 'wire-08-stickers');
  await sheet.getByRole('button', { name: 'Add a sticker' }).click();
  await sheet.locator('input[type=file]').setInputFiles(stickerFile);
  await sheet.getByLabel('Sticker name').fill('Valve OK');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(async () => (await window.dex.request('sticker.list')).length === 2);
  await sheet.getByRole('button', { name: 'Send the sticker Hard hat' }).click();
  await page.locator('.timeline .msg.sticker-msg img.sticker').last().waitFor();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).locator('.sb-preview', { hasText: 'You: Sticker' }).waitFor({ state: 'attached' });
  ok('6 stickers');

  // 7. office emoji from anyone
  await page.getByTitle('Insert', { exact: true }).first().click();
  await page.getByRole('menuitem', { name: /^Emoji/ }).click();
  await page.locator('.emoji-add').click();
  await page.locator('.emoji-picker input[type=file]').setInputFiles(emojiFile);
  await page.locator('.emoji-picker').getByLabel('Emoji name').fill('pipe-ok');
  await shot(page, 'wire-09-add-emoji');
  await page.locator('.emoji-picker').getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(async () => (await window.dex.request('emoji.list')).some((e: any) => e.name === 'pipe-ok'));
  await page.locator('.emoji-picker button[title=":pipe-ok:"]').waitFor();
  await page.keyboard.press('Escape');
  ok('7 office emoji');

  // 8. forms: a file and a scanned code
  await owner.request('form.create', { convId: sp.id, title: 'Valve check', clientId: 'f1', fields: [{ label: 'Valve tag', type: 'scan', required: true }, { label: 'Photo', type: 'file', required: true }] });
  const card = page.locator('.form-card', { hasText: 'Valve check' });
  await card.getByRole('button', { name: 'Fill in' }).click();
  const fill = page.getByRole('dialog', { name: 'Valve check' });
  await fill.getByRole('button', { name: 'Scan' }).click();
  await page.locator('.scan-overlay').waitFor();
  await page.locator('.scan-overlay').getByText('Hold the barcode or QR code inside the square').waitFor();
  await shot(page, 'wire-10-scan-field');
  await page.locator('.scan-overlay').getByRole('button', { name: 'Cancel' }).click();
  await fill.getByPlaceholder('Scan or type the code').fill('V-2201');
  await fill.locator('input[type=file]').setInputFiles(photoFile);
  await fill.locator('.form-file-chip', { hasText: 'valve-photo.png' }).waitFor();
  await shot(page, 'wire-11-form-fill');
  await fill.getByRole('button', { name: 'Send answers' }).click();
  await toast(/Answers sent/);
  const answered = await owner.request('form.responses', { formId: (await owner.request('msg.list', { convId: sp.id })).messages.find((m: any) => m.form?.title === 'Valve check').form.id });
  assert.equal(answered.responses[0].answers[answered.form.fields[0].id], 'V-2201');
  assert.match(answered.responses[0].answers[answered.form.fields[1].id], /^[0-9A-Z]{26}$/);
  // Priya's own form, answered by Ravi with a photo
  const mine = await page.evaluate((cid) => window.dex.request('form.create', { convId: cid, title: 'Site photos', clientId: 'f2', fields: [{ label: 'Area', type: 'text', required: true }, { label: 'Photo', type: 'file', required: true }] }), sp.id);
  const photo = await upload(hub.port, (ravi as any).session.fileToken, 'rack.png', png(48, [120, 90, 200]));
  await ravi.request('form.respond', { formId: mine.form.id, answers: { [mine.form.fields[0].id]: 'Pipe rack 3', [mine.form.fields[1].id]: photo.id } });
  await page.locator('.form-card', { hasText: 'Site photos' }).getByRole('button', { name: /See answers · 1/ }).click();
  const answers = page.getByRole('dialog', { name: /Site photos · 1 answers/ });
  await answers.locator('.answer-file', { hasText: 'Photo - Ravi Kulkarni.png' }).waitFor();
  await answers.locator('.answer-file img').waitFor();
  await shot(page, 'wire-12-form-answers');
  await page.evaluate(() => {
    const w = window as any; w.__csv = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob) => { w.__csv.push(b); return orig(b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (!this.download) click.call(this); };
  });
  await answers.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await page.evaluate(async () => (window as any).__csv.at(-1).text());
  assert.match(csv, /Photo - Ravi Kulkarni\.png/);
  assert.match(csv, /Pipe rack 3/);
  await page.keyboard.press('Escape');
  ok('8 forms: file and scan');

  // 9. integration actions
  await moreOn('Valve list updated');
  await page.locator('.msg-menu .menu-label', { hasText: 'Integrations' }).waitFor();
  await shot(page, 'wire-13-integrations');
  await page.getByRole('menuitem', { name: /Log as defect/ }).click();
  await toast(/Defect Log: Defect D-17 logged/);
  assert.equal(hooked.at(-1).message.text, 'Valve list updated for #valves on #p12 today');
  ok('9 integration actions');

  // 10. document scanner
  await page.getByTitle('Insert', { exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Scan a document' }).click();
  const scan = page.getByRole('dialog', { name: 'Scan a document' });
  await scan.waitFor();
  await page.waitForFunction(() => (document.querySelector('.scan-live video') as HTMLVideoElement | null)?.videoWidth! > 0, null, { timeout: 15000 });
  await scan.getByRole('button', { name: 'Take the page' }).click();
  await scan.getByRole('button', { name: /Keep page 1/ }).click();
  await scan.getByLabel('File name').fill('Site walk P-12');
  await scan.getByRole('button', { name: 'Attach PDF' }).click();
  await page.locator('.attach-chip.done', { hasText: 'Site walk P-12.pdf' }).waitFor({ timeout: 15000 });
  await shot(page, 'wire-14-scan-attached');
  await dock().press('Enter');
  await page.locator('.timeline .file-card', { hasText: 'Site walk P-12.pdf' }).waitFor();
  ok('10 document scanner');

  // 11. messages drawn as cards (instant, per device)
  await page.evaluate((cid) => window.dex.request('msg.send', { convId: cid, body: 'I will walk the rack on Thursday #p12', clientId: 'p-own' }), sp.id);
  await page.locator('.timeline .msg', { hasText: 'walk the rack' }).waitFor();
  await page.keyboard.press('Control+,');
  await page.getByRole('group', { name: 'Messages drawn as' }).getByRole('button', { name: 'Cards' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.timeline.layout-cards').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('dex.msgLayout')), 'cards');
  const ownBox = (await page.locator('.timeline .msg', { hasText: 'walk the rack' }).boundingBox())!;
  const theirBox = (await page.locator('.timeline .msg', { hasText: 'Nozzle N3' }).first().boundingBox())!;
  const tl = (await page.locator('.timeline').boundingBox())!;
  assert.ok(ownBox.x + ownBox.width > tl.x + tl.width - 40 && theirBox.x < ownBox.x, `own ${JSON.stringify(ownBox)} theirs ${JSON.stringify(theirBox)}`);
  assert.equal(await page.locator('.timeline .msg', { hasText: 'walk the rack' }).locator('.card-time').count(), 1);
  await page.evaluate(() => { const t = document.querySelector('.timeline')!; t.scrollTop = t.scrollHeight; });
  await page.mouse.move(5, 400); await sleep(300);
  await shot(page, 'wire-15-cards-light');
  await theme('dark'); await sleep(400);
  await shot(page, 'wire-16-cards-dark');
  await theme('light');
  await page.keyboard.press('Control+,');
  await page.getByRole('group', { name: 'Messages drawn as' }).getByRole('button', { name: 'Spine' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.timeline:not(.layout-cards)').waitFor();
  ok('11 cards');

  // 12. keys you choose, and G then a letter
  await page.locator('.pane-title h2').first().click();
  await page.keyboard.press('Control+/');
  const keys = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await keys.getByRole('button', { name: 'Change the keys for Go to a person, conversation or command' }).click();
  await page.keyboard.press('Control+J');
  await keys.locator('.shortcut', { hasText: 'Go to a person' }).locator('kbd', { hasText: 'J' }).waitFor();
  await keys.getByRole('button', { name: 'Change the keys for Search messages and files, with filters' }).click();
  await page.keyboard.press('Control+J');
  await keys.locator('.key-problem', { hasText: /already go to a person/ }).waitFor();
  await page.keyboard.press('Control+B');
  await keys.locator('.key-problem', { hasText: /already makes text bold/ }).waitFor();
  await shot(page, 'wire-17-keys');
  await page.keyboard.press('Escape');
  await keys.getByText('G then a letter').waitFor();
  // Meet has the same rows as every other lens (its own keys, and G then M)
  assert.equal(await keys.locator('.shortcut', { hasText: 'Meet' }).count(), await keys.locator('.shortcut', { hasText: 'Calendar' }).count());
  await page.keyboard.press('Escape');
  await keys.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+J');
  await page.locator('.palette').waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+G');
  await sleep(300);
  assert.equal(await page.locator('.palette').count(), 0, 'Ctrl+G no longer opens Go to');
  // send later on keys of your own, used by the Dock
  await page.evaluate(() => { localStorage.setItem('dex.keys', JSON.stringify({ goto: 'Ctrl+J', sendLater: 'Alt+L' })); });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await open('P-12 Piping');
  await dock().fill('Reminder for the toolbox talk');
  await dock().press('Alt+L');
  await page.getByRole('dialog', { name: /Send later|Schedule/ }).waitFor();
  await page.keyboard.press('Escape');
  await dock().fill('');
  // G then a letter, outside text fields
  await page.locator('.pane-title h2').first().click();
  await page.keyboard.press('g'); await page.keyboard.press('k');
  await page.locator('.lens-bar .lens[aria-current="page"]', { hasText: 'Desk' }).waitFor();
  await page.keyboard.press('g'); await page.keyboard.press('y');
  await page.locator('.lens-bar .lens[aria-current="page"]', { hasText: 'Directory' }).waitFor();
  await page.keyboard.press('g'); await page.keyboard.press('m');
  await sleep(200);
  await page.keyboard.press('g'); await page.keyboard.press('p');
  await page.locator('.lens-bar .lens[aria-current="page"]', { hasText: 'Pulse' }).waitFor();
  // reset all
  await page.keyboard.press('Control+/');
  await keys.getByRole('button', { name: 'Reset all' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+G');
  await page.locator('.palette').waitFor();
  await page.keyboard.press('Escape');
  ok('12 keys you choose');

  // the timeline with everything, in both themes
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await open('P-12 Piping');
  await page.mouse.move(5, 400);
  await sleep(300);
  await shot(page, 'wire-18-spine-light');
  await page.locator('.timeline .msg', { hasText: 'Toolbox talk' }).first().scrollIntoViewIfNeeded();
  await page.mouse.move(5, 400); await sleep(200);
  await shot(page, 'wire-18b-flags-light');
  await theme('dark'); await sleep(400);
  await shot(page, 'wire-18c-flags-dark');
  await page.locator('.timeline .msg', { hasText: 'walk the rack' }).first().scrollIntoViewIfNeeded();
  await sleep(200);
  await shot(page, 'wire-19-spine-dark');
  const n = page.locator('.timeline .msg', { hasText: 'Nozzle N3' }).first();
  await n.hover(); await n.getByTitle('More', { exact: true }).click();
  await page.locator('.msg-menu').waitFor();
  await shot(page, 'wire-20-menu-dark');
  await page.keyboard.press('Escape');
  await page.getByTitle('Insert', { exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Stickers' }).click();
  await page.locator('.sticker-sheet img.sticker').first().waitFor();
  await sleep(200);
  await shot(page, 'wire-21-stickers-dark');
  await page.keyboard.press('Escape');
  await theme('light');
  console.log(`WIRE E2E PASSED (${passed.length}/12)`);
} catch (e) { await shot(page, 'wire-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); hookServer.close(); }
// the second app and open sockets of the walk can keep Node alive after it has finished: end the run
process.exit(0);
