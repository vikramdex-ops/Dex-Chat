// Four fixes the office owner asked for, end to end:
// 1. A meeting recap's action points open and change: the pencil, the point's words and its state
//    open its sheet above the recap (it was drawn under the recap's scrim); words, owner, date and
//    done are saved to the hub and the recap follows; its history; read-only for someone who may
//    not change it; Esc closes the sheet, not the recap; "In the thread" and "Open the thread" open it.
// 2. The Dock grows to several lines (then scrolls), changes shape, and on a phone puts its tools
//    under the text; Enter sends, Shift+Enter makes a new line.
// 3. A message's tool column stays while the pointer travels to it (across the spine's gutter and
//    a neighbour), one column at a time, and a tap shows it on touch.
// 4. The new-meeting dialog's suggested page name fills the field, is checked and is saved.
// Screenshots at 1440 and 390 wide, light and dark, and one in Hindi (UIFIX_OUT, or out/uifix).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT } from './harness.mts';
import type { ActionPoint, MeetingInfo, Message, RoomInfo } from '../../../packages/core/src/index.ts';

const SHOTS = process.env.UIFIX_OUT ?? path.join(OUT, 'uifix');
fs.mkdirSync(SHOTS, { recursive: true });
const { owner, hub } = await startOffice('uifix');
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
const req = (op: string, data: unknown) => page.evaluate(([o, d]: [string, unknown]) => (window as any).dex.request(o, d), [op, data] as [string, unknown]) as Promise<any>;
const theme = (t: string) => page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
/** 1440 and 390 wide, light and dark. */
const snap = async (name: string, sizes: Array<[number, number]> = [[1440, 900], [390, 844]], before?: () => Promise<void>) => {
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(350);
    if (before) await before();
    for (const t of ['light', 'dark']) { await theme(t); await sleep(200); await page.screenshot({ path: path.join(SHOTS, `${name}-${w}-${t}.png`) }); }
  }
  await theme('light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(250);
};
/** Is the element's middle drawn on top (not under a scrim)? */
const onTop = (sel: string) => page.evaluate((s: string) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
  return !!hit && el.contains(hit);
}, sel);
const openRecap = (occId: string) => page.evaluate((id: string) => window.dispatchEvent(new CustomEvent('dex-recap', { detail: id })), occId);

try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  // Ravi joins the office (a second colleague to own points)
  const { HubClient } = await import('../../../packages/core/src/hub-client.ts');
  const { createIdentity } = await import('../../../packages/core/src/index.ts');
  const ravi = new HubClient({ identity: createIdentity(), account: { username: 'ravi', domain: 'DEX', displayName: 'Ravi Kumar', hostname: 'RAVI-PC' } });
  ravi.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  for (let i = 0; i < 100 && ravi.state.kind !== 'ready'; i++) await sleep(100);
  assert.equal(ravi.state.kind, 'ready', 'Ravi is in');
  const raviId = ravi.session!.me.id;
  await page.reload(); await page.locator('.frame').waitFor();

  // ------------------------------------------------------------ 1. the recap's action points
  const m: MeetingInfo = await req('meet.create', { title: 'Isometrics review', invite: [raviId] });
  const room: RoomInfo = (await req('meet.join', { id: m.id })).room;
  const line: Message = await req('msg.send', { convId: m.convId, body: 'Kowshik has to finish 3 drawings', clientId: 'uf1' });
  const ap: ActionPoint = await req('ap.create', { messageId: line.id, text: 'Kowshik has to finish 3 drawings', source: 'chat' });
  const line2: Message = await req('msg.send', { convId: m.convId, body: 'Test entry', clientId: 'uf2' });
  await req('ap.create', { messageId: line2.id, source: 'chat' });
  await req('room.end', { roomId: room.id });
  await sleep(500);
  await openRecap(ap.occurrenceId!);
  const sheet = page.locator('.recap-sheet');
  await sheet.waitFor();
  const row = sheet.locator('.recap-ap').first();
  // the pencil opens the point, on top of the recap
  await row.getByRole('button', { name: 'Change AP-01' }).click();
  const dlg = page.getByRole('dialog', { name: 'AP-01 · Action point' });
  await dlg.waitFor();
  assert.ok(await onTop('.ap-sheet'), 'the action point sheet is drawn above the recap');
  await dlg.locator('.ap-history li', { hasText: 'Priya Raman logged it' }).waitFor();
  // Esc closes the sheet and leaves the recap open
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await sheet.count(), 1, 'the recap stays open');
  // its state opens it too ("OPEN" was a label that did nothing)
  await row.getByRole('button', { name: /AP-01 is open\. Open it/ }).click();
  await dlg.waitFor();
  await dlg.getByLabel('What needs doing').fill('Kowshik to finish 3 drawings and send them to the client');
  await dlg.getByLabel('Owner').selectOption(raviId);
  const due = new Date(Date.now() + 3 * 86400_000);
  const dueYmd = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  await dlg.getByLabel('Due date').fill(dueYmd);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await snap('uf-01-ap-sheet', [[1440, 900], [390, 844]], async () => { await dlg.waitFor(); });
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await dlg.waitFor({ state: 'detached' });
  // the toast answers above the recap, and the recap shows the change
  await page.locator('.toast', { hasText: 'AP-01 saved' }).waitFor();
  assert.ok(await onTop('.toast'), 'the toast is drawn above the recap');
  await row.locator('.ap-title', { hasText: 'send them to the client' }).waitFor();
  await row.locator('.ap-val', { hasText: 'Ravi Kumar' }).waitFor();
  await row.locator('.ap-status', { hasText: 'DONE' }).waitFor();
  await sheet.locator('.recap-label', { hasText: '1 of 2 done' }).waitFor();
  // saved on the hub, for everyone
  const saved = (await ravi.request('ap.list', { convId: m.convId! })).actions.find((a: ActionPoint) => a.id === ap.id)!;
  assert.equal(saved.text, 'Kowshik to finish 3 drawings and send them to the client');
  assert.equal(saved.ownerId, raviId);
  assert.equal(saved.due, dueYmd);
  assert.equal(saved.status, 'done');
  // Ravi opens it again from his side: the recap follows, and the history says who did what
  await ravi.request('ap.update', { id: ap.id, status: 'open' });
  await row.locator('.ap-status', { hasText: 'OPEN' }).waitFor();
  await row.locator('.ap-title').click();
  await dlg.waitFor();
  for (const t of ['Priya Raman logged it', 'Priya Raman changed the words to', 'Priya Raman gave it to Ravi Kumar', 'Priya Raman set the date to', 'Priya Raman marked it done', 'Ravi Kumar opened it again']) await dlg.locator('.ap-history li', { hasText: t }).waitFor();
  await snap('uf-02-ap-history', [[1440, 900]]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await snap('uf-03-recap', [[1440, 900], [390, 844]]);

  // a point someone else logged in someone else's meeting: read only, and the box says why
  const m2: MeetingInfo = await owner.request('meet.create', { title: 'Vendor call', invite: [priya.id] });
  const room2 = (await owner.request('meet.join', { id: m2.id })).room as RoomInfo;
  const l3 = await owner.request('msg.send', { convId: m2.convId!, body: 'Vikram to chase the vendor', clientId: 'uf3' });
  const ap3: ActionPoint = await owner.request('ap.create', { messageId: l3.id, source: 'chat' });
  await owner.request('room.end', { roomId: room2.id });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
  await openRecap(ap3.occurrenceId!);
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Open AP-01' }).click();
  await dlg.waitFor();
  await dlg.getByText('Only its owner, whoever logged it and the organiser can change it.').waitFor();
  assert.equal(await dlg.getByLabel('What needs doing').isDisabled(), true);
  assert.equal(await dlg.getByRole('button', { name: 'Save changes' }).count(), 0);
  await dlg.getByRole('button', { name: 'Close' }).last().click();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });

  // "In the thread" and "Open the thread" open the thread (the recap closes)
  await openRecap(ap.occurrenceId!);
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'In the thread' }).first().click();
  await sheet.waitFor({ state: 'detached' });
  await page.locator('.pane-title h2', { hasText: 'Isometrics review' }).first().waitFor();
  await page.locator(`.timeline [data-mid="${line.id}"]`).waitFor();
  // the thread's strip shows the revised words, and opens the same sheet
  await page.locator(`.timeline [data-mid="${line.id}"] .ap-title`, { hasText: 'send them to the client' }).waitFor();
  await page.locator('.lens-bar .lens', { hasText: 'Calendar' }).click();
  await openRecap(ap.occurrenceId!);
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'Open the thread' }).click();
  await sheet.waitFor({ state: 'detached' });
  await page.locator('.pane-title h2', { hasText: 'Isometrics review' }).first().waitFor();
  console.log('recap: action points open, change, history, thread links OK');

  // ------------------------------------------------------------ 2. the Dock grows
  const dock = page.locator('.pane .dock').first();
  const box = dock.locator('textarea');
  const words = 'Please check the isometrics for line 101 before Friday. The client wants the revised set by Monday morning, and Kowshik needs the nozzle orientations from the vendor drawings. Ravi will send the stress report once the supports are fixed.';
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await sleep(400);
    await box.click();
    await box.fill('');
    await page.keyboard.type(words, { delay: 0 });
    await sleep(200);
    const g = await box.evaluate((el: HTMLTextAreaElement) => ({ ch: el.clientHeight, sh: el.scrollHeight, cw: el.clientWidth, line: parseFloat(getComputedStyle(el).lineHeight) }));
    assert.ok(g.ch > g.line * 1.8, `the Dock grew past one line at ${w} (${JSON.stringify(g)})`);
    assert.ok(g.sh <= g.ch + 1 || g.ch >= 90, `every line shows, or it scrolls at its limit (${JSON.stringify(g)})`);
    assert.ok(await dock.evaluate((el) => el.classList.contains('multi')), 'the Dock changes shape');
    if (w === 390) assert.ok(g.cw > 300, `on a phone the text takes the Dock's width (${g.cw} px)`);
    // Send stays on the last line, beside or under the text
    const send = await dock.locator('.send').boundingBox();
    const area = await box.boundingBox();
    assert.ok(send && area && send.y + send.height >= area.y + area.height - 8, 'Send sits at the bottom');
    for (const t of ['light', 'dark']) { await theme(t); await sleep(150); await page.screenshot({ path: path.join(SHOTS, `uf-04-dock-${w}-${t}.png`) }); }
    await theme('light');
  }
  // Shift+Enter: a new line, Enter: sends, and the Dock is a pill again
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Thanks.');
  assert.match(await box.inputValue(), /fixed\.\nThanks\.$/);
  await page.keyboard.press('Enter');
  await page.locator('.timeline .msg', { hasText: 'Ravi will send the stress report' }).waitFor();
  assert.equal(await box.inputValue(), '');
  await sleep(200);
  assert.ok(!(await dock.evaluate((el) => el.classList.contains('multi'))), 'empty again: one line');
  // a very long draft stops growing and scrolls
  await box.fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n'));
  await sleep(200);
  const tall = await box.evaluate((el: HTMLTextAreaElement) => ({ ch: el.clientHeight, sh: el.scrollHeight, oy: getComputedStyle(el).overflowY }));
  assert.ok(tall.ch <= 262 && tall.sh > tall.ch && tall.oy === 'auto', `it stops at its limit and scrolls (${JSON.stringify(tall)})`);
  await box.fill('');
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('dock: grows, changes shape, phone layout, Enter / Shift+Enter OK');

  // ------------------------------------------------------------ 3. the tool column can be reached
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await owner.request('msg.send', { convId: sp.id, body: 'Line 101: the stress report is attached. Supports S-12 to S-19 are changed to guided supports, and the nozzle loads on P-101A are within the vendor limits.\n\nPlease review the isometrics before Friday.\n\nThe GA drawing follows tomorrow.', clientId: 'r1' });
  await owner.request('msg.send', { convId: sp.id, body: 'One more thing: the hydrotest pressure is 15 bar.', clientId: 'r2' });
  await owner.request('msg.send', { convId: sp.id, body: 'And the last line.', clientId: 'r3' });
  // more below, so the short one's column hangs down over the next messages
  for (let i = 4; i <= 9; i++) await owner.request('msg.send', { convId: sp.id, body: `Checked line 10${i}.`, clientId: `r${i}` });
  await page.locator('.lens-bar .lens', { hasText: 'Spaces' }).click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const tall1 = page.locator('.timeline .msg', { hasText: 'Line 101: the stress report' });
  await tall1.waitFor();
  await page.locator('.timeline .msg', { hasText: 'Checked line 109.' }).waitFor();
  await sleep(800);
  const tb = (await tall1.boundingBox())!;
  // into the message, then down-left and across the spine's gutter, up to its column
  await page.mouse.move(tb.x + tb.width * 0.6, tb.y + tb.height - 10, { steps: 3 });
  await page.mouse.move(tb.x + tb.width * 0.6, tb.y + tb.height - 6, { steps: 2 });
  await sleep(150);
  const rail = tall1.locator(':scope > .spine-tools');
  assert.ok(await rail.isVisible(), 'its tools show when the pointer is on it');
  const branch = (await rail.getByRole('button', { name: 'Side-track' }).boundingBox())!;
  const from = { x: tb.x + tb.width * 0.6, y: tb.y + tb.height - 6 };
  // first out to the gutter at the message's bottom, then up along it: ground that belongs to no message
  const path1 = [{ x: tb.x - 14, y: tb.y + tb.height - 6 }, { x: branch.x + branch.width / 2, y: branch.y + branch.height / 2 }];
  let at = from;
  for (const to of path1) {
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(at.x + ((to.x - at.x) * i) / 8, at.y + ((to.y - at.y) * i) / 8);
      await sleep(25);
      assert.ok(await rail.isVisible(), `the column stays on the way to it (${Math.round(at.x)},${Math.round(at.y)} → ${Math.round(to.x)},${Math.round(to.y)}, step ${i})`);
    }
    at = to;
  }
  assert.equal(await page.locator('.timeline .spine-tools:visible').count(), 1, 'one column at a time');
  await snap('uf-05-rail', [[1440, 900]]);
  await page.mouse.click(at.x, at.y);
  await page.locator('.side-track').waitFor();
  assert.match(await page.locator('.side-track .track-parent').innerText(), /stress report is attached/);
  await page.getByRole('button', { name: 'Close side-track' }).click();
  await page.locator('.side-track').waitFor({ state: 'detached' });
  await sleep(400);
  // a short message's column overhangs the next message: crossing the next one on the way keeps it
  const short = page.locator('.timeline .msg', { hasText: 'hydrotest pressure is 15 bar' });
  const next = page.locator('.timeline .msg', { hasText: 'And the last line.' });
  const sb = (await short.boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height / 2 - 2, { steps: 3 });
  await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height / 2, { steps: 2 });
  await sleep(120);
  const srail = short.locator(':scope > .spine-tools');
  assert.ok(await srail.isVisible(), 'the short message shows its tools');
  const keepBtn = srail.getByRole('button', { name: 'Keep on my Desk' });
  const keep = (await keepBtn.boundingBox())!;
  const nb = (await next.boundingBox())!;
  const target = { x: keep.x + keep.width / 2, y: keep.y + keep.height / 2 };
  const start = { x: sb.x + sb.width * 0.5, y: sb.y + sb.height / 2 };
  let crossed = false;
  for (let i = 1; i <= 10; i++) {
    const p = { x: start.x + ((target.x - start.x) * i) / 10, y: start.y + ((target.y - start.y) * i) / 10 };
    await page.mouse.move(p.x, p.y);
    await sleep(20);
    if (p.y > nb.y && p.y < nb.y + nb.height && p.x > nb.x) crossed = true;
    assert.ok(await srail.isVisible(), `the short message keeps its column (step ${i})`);
    assert.ok(!(await next.locator(':scope > .spine-tools').isVisible()), `the message crossed does not take the tools (step ${i})`);
  }
  assert.ok(crossed, 'the way to the column crossed the next message');
  // resting on the next message hands the tools over (no stale column left to catch a click)
  await page.mouse.move(nb.x + nb.width * 0.5, nb.y + nb.height / 2);
  await sleep(450);
  await page.mouse.move(nb.x + nb.width * 0.5 + 2, nb.y + nb.height / 2);
  await sleep(100);
  assert.ok(await next.locator(':scope > .spine-tools').isVisible(), 'the next message takes the tools');
  assert.equal(await page.locator('.timeline .spine-tools:visible').count(), 1, 'one column at a time');
  // touch: a tap shows a message's tools, a second tap puts them away
  await page.mouse.move(5, 5);
  await sleep(450);
  await page.mouse.move(6, 6);
  const tap = async (loc: any) => loc.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect(); const x = r.left + r.width * 0.7; const y = r.top + 8;
    const target = document.elementFromPoint(x, y) ?? el;
    for (const type of ['pointerdown', 'pointerup']) target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
  });
  await tap(short);
  await sleep(80);
  assert.ok(await srail.isVisible(), 'a tap shows the tools');
  await tap(short);
  await sleep(80);
  assert.ok(!(await srail.isVisible()), 'a second tap puts them away');
  console.log('message tools: reachable, one at a time, touch OK');

  // ------------------------------------------------------------ 4. the suggested page name
  await page.locator('.lens-bar .lens', { hasText: 'Calendar' }).click();
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByLabel('Title', { exact: true }).fill('FST project handover');
  const slugBox = page.getByLabel("The meeting's name on the meeting site");
  assert.equal(await slugBox.inputValue(), '');
  await page.getByRole('button', { name: 'Use …/fst-project-handover' }).click();
  for (let i = 0; i < 40 && (await slugBox.inputValue()) !== 'fst-project-handover'; i++) await sleep(50);
  assert.equal(await slugBox.inputValue(), 'fst-project-handover', 'the suggestion fills the field');
  await page.getByText('Free: …/fst-project-handover').waitFor({ timeout: 10000 });
  await sleep(400);
  assert.equal(await slugBox.inputValue(), 'fst-project-handover', 'and stays there once checked');
  await page.locator('.dialog').evaluate((d: HTMLElement) => { d.querySelector('.ev-page')?.scrollIntoView({ block: 'center' }); });
  await snap('uf-06-slug', [[1440, 900], [390, 844]], async () => { await page.locator('.dialog').evaluate((d: HTMLElement) => { d.querySelector('.ev-page')?.scrollIntoView({ block: 'center' }); }); });
  // typed over, then cleared: back to the meeting ID, and the suggestion is offered again
  await slugBox.fill('fst-project-handover-2');
  await page.getByText('Free: …/fst-project-handover-2').waitFor({ timeout: 10000 });
  await slugBox.fill('');
  await page.getByText('No name: the page is at the meeting ID.').waitFor();
  await page.getByRole('button', { name: 'Use …/fst-project-handover' }).click();
  await page.getByText('Free: …/fst-project-handover').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/Added to your calendar|Invitations sent/).first().waitFor({ timeout: 15000 });
  const evs = await req('cal.list', { from: Date.now() - 86400_000, to: Date.now() + 30 * 86400_000 });
  const made = (evs as Array<{ event: { id: string; title: string } }>).find((e) => e.event.title === 'FST project handover')!;
  assert.ok(made, 'the meeting was saved');
  const mi: MeetingInfo = await req('meet.event', { eventId: made.event.id });
  const pub = await req('meet.public.get', { id: mi.id });
  assert.equal(pub.slug, 'fst-project-handover', 'the name was saved with the meeting');
  console.log('scheduling: the suggested name fills, checks and saves OK');

  // one shot in Hindi: the recap's action point sheet
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor();
  await openRecap(ap.occurrenceId!);
  await sheet.waitFor();
  await sheet.locator('.recap-ap').first().locator('.ap-edit').click();
  await page.locator('.ap-sheet').waitFor();
  await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, 'uf-07-ap-sheet-hi.png') });
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('UIFIX E2E PASSED');
} catch (e) {
  await page.screenshot({ path: path.join(SHOTS, 'uf-FAIL.png') }).catch(() => {});
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
