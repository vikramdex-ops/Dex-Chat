// Title bar fit: with a Room chip, nothing in the middle is covered, at several widths, on Windows padding too.
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('tbfit');
const { app, page } = await launch('priya', 'Priya Raman');
let bad = 0;
try {
  await page.evaluate(() => {
    const mid = document.querySelector('.titlebar-mid .lens-bar');
    mid?.insertAdjacentHTML('afterend', '<div class="room-chip" data-preview><button class="room-chip-main"><span class="room-chip-pip"></span><span class="room-chip-text">ROOM · 0:12</span></button><button class="room-chip-mic">M</button></div>');
  });
  for (const chip of [true, false]) {
  await page.evaluate((c) => { const el = document.querySelector('.room-chip[data-preview]') as HTMLElement; el.style.display = c ? '' : 'none'; if (!c) el.remove(); }, chip);
  for (const plat of ['linux', 'win32']) {
    await page.evaluate((p) => document.documentElement.setAttribute('data-platform', p), plat);
    for (const w of [1440, 1280, 1180, 1100, 1024, 960, 900]) {
      await page.setViewportSize({ width: w, height: 760 }); await sleep(250);
      const r = await page.evaluate(() => {
        const mid = document.querySelector('.titlebar-mid')!.getBoundingClientRect();
        const right = document.querySelector('.titlebar-right')!.getBoundingClientRect();
        const brand = document.querySelector('.titlebar .brand')!.getBoundingClientRect();
        const kids = [...document.querySelectorAll('.titlebar-mid > *, .titlebar-right > *')].filter((e) => (e as HTMLElement).offsetParent);
        // every visible control must be the top element at its own centre
        const covered = kids.filter((e) => { const b = e.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return t && !e.contains(t); }).map((e) => e.className);
        const m = document.querySelector('.room-chip-mic');
        const chip = m ? m.getBoundingClientRect() : document.querySelector('.goto')!.getBoundingClientRect();
        const top = document.elementFromPoint(chip.left + chip.width / 2, chip.top + chip.height / 2);
        const ov = mid.right > right.left + 1 || [...document.querySelectorAll('.titlebar-mid > *')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > right.left; });
        return { midR: Math.round(mid.right), rightL: Math.round(right.left), brandR: Math.round(brand.right), midL: Math.round(mid.left), covered, mic: !!top?.closest(m ? '.room-chip-mic' : '.goto'), ov, vw: innerWidth, scroll: document.documentElement.scrollWidth };
      });
      const ok = !r.ov && r.mic && r.covered.length === 0 && r.scroll <= r.vw;
      if (!ok) bad++;
      console.log(chip ? 'chip' : 'none', plat, w, ok ? 'ok' : 'BAD', JSON.stringify(r));
      if (w === 1280 || w === 1100) await shot(page, `tbfit-${chip ? 'chip' : 'none'}-${plat}-${w}`);
    }
  }
  }
  console.log(bad ? `TBFIT ${bad} BAD` : 'TBFIT E2E PASSED');
} finally { await app.close(); owner.disconnect(); await hub.stop(); }
