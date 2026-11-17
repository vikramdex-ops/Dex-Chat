// Link cards: up to three per message, fetched when on screen, in a reserved box (no layout shift);
// a restricted stub; actions (copy path, reply, discuss); the author removes a card; meeting cards;
// file/calendar/desk deep links; the Control room's web preview settings.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
const { owner, hub } = await startOffice('lcards');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  const src = await owner.request('msg.send', { convId: sp.id, body: 'Rev C of ISO-1001 is the one to use on site', clientId: 'c1' });
  const hidden = await owner.request('conv.create', { kind: 'space', name: 'Leads only', private: true, members: [] });
  const hm = await owner.request('msg.send', { convId: hidden.id, body: 'Budget numbers', clientId: 'c2' });
  const meet = await owner.request('meet.create', { title: 'Pump skid review', invite: [priya.id] });
  const ev = await owner.request('cal.create', { title: 'Nozzle load workshop', startAt: Date.now() + 86400_000, endAt: Date.now() + 86400_000 + 3600_000, attendees: [priya.id] } as any);
  const task = await owner.request('remind.create', { text: 'Send the revised MTO', dueAt: Date.now() + 2 * 3600_000, forUserId: priya.id } as any);
  // padding so the timeline scrolls
  for (let i = 0; i < 14; i++) await owner.request('msg.send', { convId: sp.id, body: `Line list check ${i + 1}: done`, clientId: `p${i}` });
  await owner.request('msg.send', { convId: sp.id, body: `Use dexconnect://message/${sp.id}/${src.id} and the folder \\\\fs01\\jobs\\P-12513\\ISO\\ and sleuth://search?q=ISO-1001 and datum://c/PSV-101 and https://example.com/fifth`, clientId: 'c3' });
  await owner.request('msg.send', { convId: sp.id, body: `Not for you: dexconnect://message/${hidden.id}/${hm.id}`, clientId: 'c4' });
  await owner.request('msg.send', { convId: sp.id, body: `Join ${meet.link} · workshop dexconnect://calendar/event/${ev.id} · task dexconnect://desk/task/${task.id}`, clientId: 'c5' });

  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const linkMsg = page.locator('.msg', { hasText: 'Use ' }).last();
  await linkMsg.waitFor();
  // three cards at most, each in the reserved box
  await linkMsg.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const slots = linkMsg.locator('.lcard-slot');
  assert.equal(await slots.count(), 3, 'up to three cards per message');
  const before = await linkMsg.boundingBox();
  await linkMsg.locator('.lcard.k-folder').waitFor();
  await linkMsg.locator('.lcard.k-search').waitFor();
  await linkMsg.locator('.lcard.k-component').waitFor();
  await linkMsg.locator('.msg-link-card .mlc-reply').waitFor();
  const after = await linkMsg.boundingBox();
  assert.equal(Math.round(before!.height), Math.round(after!.height), 'no layout shift when the cards arrive');
  for (const h of await slots.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))) assert.equal(h, 108);
  // the link to a message is that message's card in the text
  assert.match(await linkMsg.locator('.msg-link-card').innerText(), /Vikram Shah[\s\S]*Rev C of ISO-1001/);
  assert.equal(await linkMsg.locator('.lcard-slot[data-url^="https://"]').count(), 0, 'the fifth link has no card');
  assert.match(await linkMsg.locator('.lcard.k-folder').innerText(), /ISO[\s\S]*Open folder[\s\S]*Copy path/);
  // copy path
  await linkMsg.locator('.lcard.k-folder').getByRole('button', { name: 'Copy path' }).click();
  await sleep(300);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), '\\\\fs01\\jobs\\P-12513\\ISO\\');
  // Open folder refuses on this (non-Windows) PC with a plain message
  await linkMsg.locator('.lcard.k-folder').getByRole('button', { name: 'Open folder' }).click();
  await page.locator('.toast', { hasText: /open on Windows PCs/ }).waitFor();
  await both(page, 'lcards-01-cards');

  // a card the viewer may not see: the quiet stub, nothing else
  const stub = page.locator('.msg', { hasText: 'Not for you' }).locator('.msg-link-none');
  await stub.waitFor();
  assert.match(await stub.innerText(), /You don't have access to this message/);
  assert.equal((await stub.innerText()).includes('Budget'), false);

  // meeting, calendar and Desk task cards
  const third = page.locator('.msg', { hasText: 'Join ' }).last();
  await third.locator('.lcard.k-meeting').waitFor();
  assert.match(await third.locator('.lcard.k-meeting').innerText(), /Pump skid review[\s\S]*Meeting \d{3}-\d{3}-\d{3}/);
  await third.locator('.lcard.k-event').waitFor();
  await third.locator('.lcard.k-task').waitFor();
  await third.scrollIntoViewIfNeeded();
  await both(page, 'lcards-02-meeting-event-task');

  // Reply on a message's card opens that message's side-track
  await linkMsg.locator('.msg-link-card').getByRole('button', { name: 'Reply in a side-track' }).click();
  await page.locator('.side-track .track-parent', { hasText: 'Rev C of ISO-1001' }).waitFor();
  await page.getByRole('button', { name: 'Close side-track' }).click();

  // Discuss: the side-track about the link
  await linkMsg.locator('.lcard.k-search').getByRole('button', { name: 'Discuss' }).click();
  await page.locator('.side-track .track-parent', { hasText: 'search?q=ISO-1001' }).waitFor();
  await page.locator('.side-track .dock textarea').fill('Search finds 4 sheets');
  await page.locator('.side-track .dock textarea').press('Enter');
  await page.locator('.side-track .track-reply', { hasText: 'Search finds 4 sheets' }).waitFor();
  await page.getByRole('button', { name: 'Close side-track' }).click();

  // deep links: the calendar event and the Desk task open their screens
  await third.locator('.lcard.k-event').getByRole('button', { name: 'Open' }).click();
  await page.getByText('Nozzle load workshop').last().waitFor();
  await page.locator('.dialog, .event-details, [role=dialog]').filter({ hasText: 'Nozzle load workshop' }).first().waitFor();
  await shot(page, 'lcards-03-event-opened');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.locator('.msg', { hasText: 'Join ' }).last().locator('.lcard.k-task').getByRole('button', { name: 'Open' }).click();
  await page.locator('.desk-row.flash', { hasText: 'Send the revised MTO' }).waitFor();
  await shot(page, 'lcards-04-task-opened');

  // the author removes a card from their own message, for everyone
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.locator('.dock textarea').fill('Spec sheet: https://example.com/spec');
  await page.locator('.dock textarea').press('Enter');
  const mine = page.locator('.msg', { hasText: 'Spec sheet:' }).last();
  await mine.locator('.lcard-slot').waitFor();
  await mine.locator('.lcard').hover();
  await mine.getByRole('button', { name: 'Remove this card from your message' }).click();
  await mine.locator('.lcard-slot').waitFor({ state: 'detached' });
  const stored = (await owner.request('msg.list', { convId: sp.id })).messages.at(-1);
  assert.deepEqual(stored.hiddenPreviews, ['https://example.com/spec']);

  // Control room → Policies: web previews
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Policies' }).click();
  const card = page.locator('.link-policy');
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('switch', { name: 'Preview web pages for guests too' }).or(card.getByLabel('Preview web pages for guests too')).first().click();
  await sleep(400);
  assert.equal((await owner.request('admin.links.get')).guestExternalPreviews, true);
  await card.getByLabel('Office hosts the hub may preview').fill('wiki.dexterity.local');
  await card.getByRole('button', { name: 'Save hosts' }).click();
  await sleep(400);
  assert.deepEqual((await owner.request('admin.links.get')).allowLanHosts, ['wiki.dexterity.local']);
  await both(page, 'lcards-05-policies');
  console.log('LCARDS E2E PASSED');
} catch (e) { await shot(page, 'lcards-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
