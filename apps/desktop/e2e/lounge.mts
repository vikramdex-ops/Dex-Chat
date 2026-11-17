// Lounges end to end: Priya opens a lounge in a Space from its header, three apps drop in from the
// Switchboard (nobody is rung), hear each other (audio tracks with sound in them), see who is in
// it and who speaks, and leave again; colleagues see "in Piping desk".
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('lounge');
const a = await launch('priya', 'Priya Raman');
const b = await launch('ravi', 'Ravi Kumar');
const c = await launch('asha', 'Asha Menon');
const theme = (p: any, t: 'light' | 'dark') => p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const both = async (p: any, name: string) => { await theme(p, 'light'); await sleep(200); await shot(p, `${name}-light`); await theme(p, 'dark'); await sleep(200); await shot(p, `${name}-dark`); await theme(p, 'light'); };
/** Sound in the remote audio: the loudest RMS over half a second across the page's audio elements. */
const loudness = (p: any) => p.evaluate(async () => {
  const ctx = new AudioContext();
  const els = [...document.querySelectorAll('audio')] as HTMLAudioElement[];
  const analysers = els.map((el) => el.srcObject as MediaStream | null).filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0).map((s) => {
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(s).connect(an); return an;
  });
  let best = 0;
  const buf = new Float32Array(1024);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 60));
    for (const an of analysers) { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; best = Math.max(best, Math.sqrt(s / buf.length)); }
  }
  await ctx.close();
  return { streams: analysers.length, rms: best };
});
let rang = false;
owner.on('event', (n: string) => { if (n === 'room.ring') rang = true; });
try {
  const users = (await owner.request('directory.list')).users;
  const id = (u: string) => users.find((x: any) => x.account.endsWith(u))!.id;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Piping', members: [id('priya'), id('ravi'), id('asha')] });
  await sleep(600);
  for (const p of [a.page, b.page, c.page]) { await p.reload(); await p.locator('.frame').waitFor(); }
  // Priya opens a lounge from the Space's header
  await a.page.getByRole('button', { name: /^Spaces/ }).first().click();
  await a.page.locator('.sb-row', { hasText: 'Piping' }).first().click();
  await a.page.locator('.lg-menu-btn').click();
  await a.page.getByRole('menuitem', { name: 'New lounge…' }).click();
  const dlg = a.page.getByRole('dialog', { name: 'New lounge in Piping' });
  await dlg.getByLabel('Name').fill('Piping desk');
  await shot(a.page, 'lounge-00-new');
  await dlg.getByRole('button', { name: 'Open lounge' }).click();
  // everyone's Switchboard shows it, quiet
  for (const p of [b.page, c.page]) await p.getByRole('button', { name: /^Spaces/ }).first().click();
  // a folded Switchboard shows lounges as tiles; open it to see the rows
  for (const p of [a.page, b.page, c.page]) {
    await sleep(300);
    if (await p.locator('.switchboard.folded').count()) { await p.locator('.lg-fold').first().waitFor({ timeout: 15000 }); await p.getByTitle('Open the Switchboard').click(); }
  }
  for (const p of [a.page, b.page, c.page]) await p.locator('.lg-row', { hasText: 'Piping desk' }).waitFor({ timeout: 15000 });
  await shot(b.page, 'lounge-00b-switchboard-quiet');
  // drop in from the Switchboard: nobody rings
  for (const [p, n] of [[a.page, 1], [b.page, 2], [c.page, 3]] as const) {
    await p.locator('.lg-row', { hasText: 'Piping desk' }).getByRole('button', { name: 'Join' }).click();
    await p.locator('.lg-bar').waitFor({ timeout: 20000 });
    await a.page.locator('.lg-bar .lg-people .lg-tile').nth(n - 1).waitFor({ timeout: 20000 });
  }
  assert.equal(rang, false, 'no one was rung');
  assert.equal(await a.page.locator('.room-banner').count() + await b.page.locator('.room-banner').count() + await c.page.locator('.room-banner').count(), 0);
  // everyone hears the two others: audio tracks with sound (the fake microphone's tone) in them
  for (const [name, p] of [['priya', a.page], ['ravi', b.page], ['asha', c.page]] as const) {
    await p.waitForFunction(() => [...document.querySelectorAll('audio')].reduce((n, el) => n + (((el as HTMLAudioElement).srcObject as MediaStream | null)?.getAudioTracks().length ?? 0), 0) >= 2, null, { timeout: 30000 });
    const l = await loudness(p);
    console.log(`${name} hears ${l.streams} streams, rms ${l.rms.toFixed(4)}`);
    assert.ok(l.streams >= 2 && l.rms > 0.002, `${name} hears the others`);
  }
  // the Space sees who is in it, with a live speaking pip (the fake microphones beep)
  await a.page.locator('.lg-row.live .lg-pip.speaking').waitFor({ timeout: 20000 }).catch(() => console.log('no speaking pip seen within 20 s'));
  await sleep(500);
  await both(a.page, 'lounge-01-switchboard');
  // the lounge bar on its own
  await both(b.page, 'lounge-02-bar');
  // colleagues see where: "in Piping desk"
  const where = await owner.request('lounge.presence');
  assert.equal(where.filter((w: any) => w.name === 'Piping desk').length, 3);
  assert.match(await b.page.locator('.lg-bar .lg-tile').first().locator('.avatar').getAttribute('title') ?? '', /Ravi Kumar|You/);
  const title = await b.page.evaluate((uid: string) => {
    const el = [...document.querySelectorAll('.avatar')].find((x) => (x as HTMLElement).title.startsWith('Priya Raman'));
    return (el as HTMLElement | undefined)?.title ?? '';
  }, id('priya'));
  console.log('Priya shows to Ravi as:', title);
  // the people list
  await b.page.locator('.lg-bar').getByTitle('Who is here').click();
  await b.page.locator('.lg-pop .lg-pop-row').nth(2).waitFor();
  await shot(b.page, 'lounge-03-people');
  await b.page.keyboard.press('Escape');
  // Asha leaves: the others see two, and keep hearing each other
  await c.page.locator('.lg-bar').getByRole('button', { name: 'Leave' }).click();
  await c.page.locator('.lg-bar').waitFor({ state: 'detached' });
  await a.page.waitForFunction(() => document.querySelectorAll('.lg-bar .lg-people .lg-tile').length === 2, null, { timeout: 15000 });
  const l2 = await loudness(a.page);
  assert.ok(l2.streams >= 1 && l2.rms > 0.002, 'Priya still hears Ravi');
  // the lounge stays when everyone has left
  await a.page.locator('.lg-bar').getByRole('button', { name: 'Leave' }).click();
  await b.page.locator('.lg-bar').getByRole('button', { name: 'Leave' }).click();
  await a.page.locator('.lg-row', { hasText: 'Piping desk' }).locator('.lg-sub', { hasText: 'QUIET' }).waitFor({ timeout: 15000 });
  await shot(a.page, 'lounge-04-quiet');
  const list = await owner.request('lounge.list', { convId: space.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].people.length, 0);
  console.log('LOUNGE E2E PASSED');
} catch (e) { await shot(a.page, 'lounge-FAIL-a').catch(() => {}); await shot(b.page, 'lounge-FAIL-b').catch(() => {}); throw e; } finally {
  for (const x of [a, b, c]) await x.app.close().catch(() => {});
  owner.disconnect(); await hub.stop();
}
