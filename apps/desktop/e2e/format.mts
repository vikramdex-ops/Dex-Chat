import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('fmt');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Formatting', members: [priya.id] });
  const body = [
    '#### Line list review', 'See [the MTO sheet](https://intranet.example/mto) and ++do not++ skip __old marks__ or ~~old~~ notes.', '---',
    '- Area 1', '  - Rack A', '    - Line 101', '  - Rack B', '- Area 2', '1. First', '2. Second',
    '```js', 'const total = 42; // pipes', 'function sum(a, b) { return a + b; }', '```',
  ].join('\n');
  await owner.request('msg.send', { convId: sp.id, body, clientId: 'f1' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Formatting' }).click();
  const m = page.locator('.msg', { hasText: 'Line list review' });
  await m.waitFor();
  assert.equal(await m.locator('h6.md-h').innerText(), 'Line list review');
  assert.equal(await m.locator('a[href="https://intranet.example/mto"]').innerText(), 'the MTO sheet');
  assert.equal(await m.locator('u').innerText(), 'do not');
  assert.equal(await m.locator('u').count(), 1, '__text__ is no longer underline');
  assert.equal(await m.locator('hr.md-hr').count(), 1);
  assert.equal(await m.locator('ul ul ul li').innerText(), 'Line 101', 'three levels of nesting');
  assert.equal(await m.locator('ol li').count(), 2);
  assert.equal(await m.locator('.hl-k').first().innerText(), 'const');
  assert.equal(await m.locator('.hl-c').innerText(), '// pipes');
  assert.equal(await m.locator('.hl-n').first().innerText(), '42');
  await shot(page, 'fmt-01-render');
  // shortcuts in the composer, undo keeps working
  const dock = page.locator('.dock textarea').first();
  await dock.click();
  await page.keyboard.type('valve');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+u');
  assert.equal(await dock.inputValue(), '++valve++');
  await page.keyboard.press('Control+z');
  assert.equal(await dock.inputValue(), 'valve', 'undo removes the underline marks');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  console.log('SEL', await dock.evaluate((t: HTMLTextAreaElement) => [t.value, t.selectionStart, t.selectionEnd]));
  await page.keyboard.press('Control+k');
  assert.equal(await dock.inputValue(), '[valve](https://)');
  assert.equal(await page.locator('.palette').count(), 0, 'Ctrl+K in the Dock adds a link, it does not open Go to');
  // Ctrl+5 strikes through (and does not switch lens)
  await dock.fill('old');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+5');
  assert.equal(await dock.inputValue(), '~~old~~');
  assert.equal(await page.locator('.lens[aria-current="page"]').first().innerText(), 'Spaces');
  await dock.fill('Great work ');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+.');
  await page.getByLabel('Find an emoji').fill('rocket');
  await page.keyboard.press('Enter');
  assert.equal(await dock.inputValue(), 'Great work 🚀');
  await page.locator('.dock-hint').getByRole('button', { name: 'Formatting' }).click();
  await page.locator('.md-help').waitFor();
  await shot(page, 'fmt-02-help');
  await page.keyboard.press('Escape');
  // Ctrl+G opens Go to
  await page.keyboard.press('Control+g');
  await page.locator('.palette').waitFor();
  await page.keyboard.press('Escape');
  // the Stamp flyout's picker searches too
  await m.hover();
  await m.getByTitle('Stamp', { exact: true }).click();
  await page.getByRole('button', { name: 'More stamps' }).click();
  await page.getByLabel('Find an emoji').fill('coffee');
  await page.keyboard.press('Enter');
  await m.locator('.reaction', { hasText: '☕' }).waitFor();
  console.log('FORMAT E2E PASSED');
} catch (e) { await shot(page, 'fmt-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
