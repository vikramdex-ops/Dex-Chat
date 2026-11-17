import { startOffice, launch } from './harness.mts';
const { owner, hub } = await startOffice('clip');
const { app, page } = await launch('priya', 'Priya Raman');
console.log('main rw', await app.evaluate(({ clipboard }) => { clipboard.writeText('abc'); return clipboard.readText(); }));
console.log('nav', await page.evaluate(() => navigator.clipboard.writeText('xyz').then(() => 'ok', (e) => String(e))));
console.log('after nav', await app.evaluate(({ clipboard }) => clipboard.readText()));
await app.close(); owner.disconnect(); await hub.stop();
