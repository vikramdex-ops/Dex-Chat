// Screenshots of the other tools and the Control room tab, in light and dark, with real files:
// a CSV, an SVG and a vector PDF shared in the Space. Also checks the consent prompt and markers.
import assert from 'node:assert/strict';
import https from 'node:https';
import zlib from 'node:zlib';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('look');
const priya = await launch('priya', 'Priya Raman', { width: 1360, height: 860 });
const upload = (name: string, data: Buffer) => new Promise<any>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: hub.port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${owner.session!.fileToken}`, 'content-length': String(data.length) } }, (res) => { let raw = ''; res.on('data', (x) => { raw += x; }); res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(raw)) : reject(new Error(raw)))); });
  r.on('error', reject); r.end(data);
});
function pdf(): Buffer {
  const ops: string[] = ['0.2 w 0 0 0 RG 20 20 802 555 re S 1.2 w 30 30 782 535 re S'];
  // a title block and a grid of pipe runs
  ops.push('0.6 w 592 30 220 90 re S 592 60 m 812 60 l S 592 90 m 812 90 l S 700 30 m 700 90 l S');
  ops.push('BT /F1 9 Tf 600 100 Td (DEXTERITY DESIGN SERVICES) Tj ET BT /F1 7 Tf 600 70 Td (DRG ISO-1001-01  REV C) Tj ET BT /F1 7 Tf 708 40 Td (SCALE 1:50) Tj ET');
  ops.push('0 0.45 0.5 RG 2.4 w 80 400 m 300 400 l 300 250 l 520 250 l S 300 400 m 300 480 l S');
  ops.push('0.8 0.2 0.1 rg 296 246 8 8 re f 516 246 8 8 re f');
  ops.push('0.4 w 1 0 0 1 0 0 cm 80 395 m 80 380 l S 300 395 m 300 380 l S 85 384 m 295 384 l S BT /F1 8 Tf 170 374 Td (6000) Tj ET');
  ops.push('BT /F1 8 Tf 310 410 Td (6"-P-1001-A1B) Tj ET BT /F1 8 Tf 400 258 Td (FLOW) Tj ET');
  ops.push('0 0 0 RG 0.5 w 150 150 m 150 200 230 200 230 150 c 230 100 150 100 150 150 c S');
  const content = zlib.deflateSync(Buffer.from(ops.join('\n')));
  const objs: Array<[number, Buffer]> = [
    [1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')],
    [2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 2 >>')],
    [3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>')],
    [4, Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')])],
    [5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')],
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  for (const [n, o] of objs) parts.push(Buffer.from(`${n} 0 obj\n`), o, Buffer.from('\nendobj\n'));
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'));
  return Buffer.concat(parts);
}
const csv = ['Line,Service,Size (in),Length (m),Pressure (bar)', '6"-P-1001-A1B,Process water,6,42.5,10', '4"-P-1002-A1B,Cooling water,4,18.2,6', '8"-P-1003-B2A,Steam,8,61,16', '2"-P-1004-A1B,Drain,2,7.4,1.5', '3"-P-1005-C1A,Fuel gas,3,25.9,4', '10"-P-1006-A1B,Fire water,10,88.1,12'].join('\n');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#fff"/><g stroke="#123" stroke-width="2" fill="none"><rect x="40" y="40" width="720" height="420"/><path d="M100 300 H400 V150 H700"/><circle cx="400" cy="300" r="40"/></g><text x="60" y="80" font-family="monospace" font-size="18">GA-200 PUMP HOUSE</text></svg>';
try {
  const users = (await owner.request('directory.list')).users;
  const priyaId = users.find((u: any) => u.account.endsWith('priya'))!.id;
  await owner.request('admin.setRole', { userId: priyaId, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Pump house', members: [priyaId] });
  const files = [await upload('line-list.csv', Buffer.from(csv)), await upload('ISO-1001-01.pdf', pdf()), await upload('GA-200.svg', Buffer.from(svg))];
  await owner.request('msg.send', { convId: sp.id, body: 'Line list and drawings for the walk-down', files: files.map((f) => f.id), clientId: 'f1' });
  await owner.request('miniapp.add', { convId: sp.id, appId: 'dex-diagram', clientId: 'd1' });
  await page();
  async function page() {
    await priya.page.reload(); await priya.page.locator('.frame').waitFor();
    await priya.page.getByRole('button', { name: /^Spaces/ }).first().click();
    await priya.page.locator('.sb-row', { hasText: 'Pump house' }).first().click();
  }
  // the drawing viewer: open the PDF (with consent), drop two markers
  const dv = priya.page.frameLocator('iframe[title="Drawing viewer (tool)"]');
  await dv.locator('#file').waitFor({ timeout: 20000 });
  await dv.locator('#file').selectOption({ label: 'ISO-1001-01.pdf' });
  await dv.locator('#open').click();
  await priya.page.getByRole('dialog', { name: /wants to open a file/ }).waitFor({ timeout: 8000 });
  await shot(priya.page, 'look-01-consent-light');
  await priya.page.getByRole('button', { name: 'Open it' }).click();
  await dv.locator('#layer canvas').waitFor({ timeout: 15000 });
  await dv.locator('#mark').click();
  const box = await priya.page.locator('iframe[title="Drawing viewer (tool)"]').boundingBox();
  await priya.page.mouse.click(box!.x + 200, box!.y + 220);
  await sleep(400);
  await dv.locator('.note').first().fill('Check support at the bend');
  await dv.locator('.note').first().press('Tab');
  await priya.page.mouse.click(box!.x + 330, box!.y + 260);
  await sleep(600);
  assert.equal(await dv.locator('.balloon').count(), 2);
  assert.match(await dv.locator('#msg').innerText(), /Page 1 of 2/);
  const state = await owner.request('miniapp.state.get', { instanceId: (await owner.request('msg.list', { convId: sp.id })).messages.find((m: any) => m.miniapp)!.miniapp.instanceId });
  assert.equal((state.state as any).markers.length, 2);
  await shot(priya.page, 'look-02-drawing-viewer-light');
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'dark' })); await sleep(500);
  await shot(priya.page, 'look-03-drawing-viewer-dark');
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'light' })); await sleep(300);

  // data sheet, unit converter and punch list
  await owner.request('miniapp.add', { convId: sp.id, appId: 'dex-table', clientId: 't1' });
  await sleep(800);
  const ds = priya.page.frameLocator('iframe[title="Data sheet (tool)"]');
  await ds.locator('#file').waitFor({ timeout: 20000 });
  await ds.locator('#open').click();
  await priya.page.getByRole('button', { name: 'Open it' }).click();
  await ds.locator('#tbody tr').first().waitFor({ timeout: 10000 });
  await ds.getByRole('button', { name: 'Sort by Length (m)' }).click();
  assert.match(await ds.locator('#tbody tr').first().innerText(), /2"-P-1004/);
  await shot(priya.page, 'look-04-data-sheet-table-light');
  await ds.locator('.tab[data-tab="chart"]').click();
  await ds.locator('#chart svg').waitFor();
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'dark' })); await sleep(500);
  await shot(priya.page, 'look-05-data-sheet-chart-dark');
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'light' })); await sleep(300);

  await owner.request('miniapp.add', { convId: sp.id, appId: 'dex-units', clientId: 'u1' });
  await sleep(800);
  const uc = priya.page.frameLocator('iframe[title="Unit converter (tool)"]');
  await uc.locator('#v').waitFor({ timeout: 20000 });
  await uc.locator('#v').fill('16');
  assert.match(await uc.locator('#res').innerText(), /232\.06\d* psi/);
  await uc.locator('.tab[data-q="flow"]').click();
  await uc.locator('#v').fill('120');
  await uc.locator('#note').click();
  await shot(priya.page, 'look-06-units-light');

  await owner.request('miniapp.add', { convId: sp.id, appId: 'dex-punchlist', clientId: 'p1' });
  await sleep(800);
  const pl = priya.page.frameLocator('iframe[title="Punch list (tool)"]');
  await pl.locator('#text').waitFor({ timeout: 20000 });
  for (const [t, a, d, p] of [['Missing gasket at N3 flange', 'Pump house', 'Piping', 'A'], ['Cable tray cover loose', 'Pump house', 'Electrical', 'B'], ['Handrail toe plate short', 'Pipe rack', 'Structural', 'B']]) {
    await pl.locator('#text').fill(t); await pl.locator('#area').fill(a); await pl.locator('#disc').selectOption(d); await pl.locator('#pri').selectOption(p);
    await pl.getByRole('button', { name: 'Log it' }).click();
    await sleep(200);
  }
  await pl.getByLabel('Fixed: Cable tray cover loose').click();
  await pl.locator('.tab[data-show="all"]').click();
  await sleep(400);
  assert.equal(await pl.locator('#open').innerText(), '2');
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'dark' })); await sleep(500);
  await shot(priya.page, 'look-07-punch-list-dark');
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'light' })); await sleep(300);
  await shot(priya.page, 'look-08-punch-list-light');

  // Control room → Bots & tools
  await priya.page.locator('.me-btn').click();
  await priya.page.getByRole('menuitem', { name: /Control room/ }).click();
  await priya.page.getByRole('button', { name: /^Bots & tools/ }).click();
  await priya.page.locator('.bots-row', { hasText: 'Request a plot' }).waitFor({ timeout: 8000 });
  await shot(priya.page, 'look-09-control-flows-light');
  await priya.page.getByRole('button', { name: /^Tools in conversations/ }).click();
  await priya.page.locator('.bots-row', { hasText: 'Punch list' }).waitFor({ timeout: 8000 });
  await priya.page.evaluate(() => window.dex.setSettings({ theme: 'dark' })); await sleep(500);
  await shot(priya.page, 'look-10-control-tools-dark');
  console.log('LOOK E2E PASSED');
} catch (e) { await shot(priya.page, 'look-FAIL'); throw e; } finally { await priya.app.close(); owner.disconnect(); await hub.stop(); }
