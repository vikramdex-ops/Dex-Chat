// Polish tour helpers: shots of one screen at several widths and both themes, in the language the
// run was started with (TLANG=en|hi|ta), plus automatic checks (clipped text, page overflow,
// small touch targets on phones, covered meeting controls, axe contrast and ARIA rules).
import fs from 'node:fs';
import path from 'node:path';
import { OUT, sleep } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));

export const LANG = process.env.TLANG ?? 'en';
const DICT: Record<string, string> = LANG === 'en' ? {} : JSON.parse(fs.readFileSync(`${ROOT}apps/desktop/src/renderer/i18n/${LANG}.json`, 'utf8'));
/** The label as the app draws it in this run's language (for selectors). */
export const T = (s: string) => DICT[s] ?? s;
export const TAG = process.env.TTAG ?? 'before';
export const DIR = path.join(OUT, `tour-${TAG}-${LANG}`);
fs.mkdirSync(DIR, { recursive: true });
// accessibility checks run when DEX_AXE points at axe.min.js (axe-core is not a dependency)
const AXE = process.env.DEX_AXE ? fs.readFileSync(process.env.DEX_AXE, 'utf8') : '';
const AUDIT = path.join(DIR, 'audit.jsonl');

type Size = [number, number];
const ALL: Size[] = process.env.TSIZES ? JSON.parse(process.env.TSIZES) : LANG === 'en' ? [[1440, 900], [1280, 800], [1024, 768], [390, 844]] : [[1280, 800], [1024, 768], [390, 844]];
const THEMES = LANG === 'en' ? ['light', 'dark'] : ['light'];

export async function setLang(page: any) {
  await page.evaluate((c: string) => localStorage.setItem('dex.language', c), LANG);
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(600);
}

async function resize(app: any, page: any, w: number, h: number) {
  const win = await app.browserWindow(page);
  await win.evaluate((bw: any, s: number[]) => bw.setSize(s[0], s[1]), [w, h]);
  await page.setViewportSize({ width: w, height: h });
}

const CHECKS = (phone: boolean) => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden],.folded,[aria-hidden="true"]'); };
  const name = (e: Element) => { const h = e as HTMLElement; return `${h.tagName.toLowerCase()}.${String(h.className).split(' ').slice(0, 2).join('.')}"${(h.getAttribute('aria-label') ?? h.innerText ?? '').trim().slice(0, 40).replace(/\s+/g, ' ')}"`; };
  const clipped: string[] = []; const ellipsis: string[] = []; const offscreen: string[] = []; const small: string[] = []; const covered: string[] = [];
  const W = innerWidth;
  for (const e of document.querySelectorAll('body *')) {
    const h = e as HTMLElement;
    if (!vis(e) || ['svg', 'path', 'video', 'img', 'canvas', 'input', 'select', 'textarea', 'option'].includes(h.tagName.toLowerCase()) || h.closest('svg')) continue;
    const s = getComputedStyle(h);
    const hasText = [...h.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
    if (hasText && h.scrollWidth > h.clientWidth + 2 && s.overflowX !== 'visible') (s.textOverflow === 'ellipsis' ? ellipsis : clipped).push(name(h));
    if (hasText && h.scrollHeight > h.clientHeight + 3 && s.overflowY === 'hidden' && s.textOverflow !== 'ellipsis' && !/line-clamp/.test(h.style.cssText) && s.webkitLineClamp === 'none') clipped.push(`${name(h)} (height)`);
    const r = h.getBoundingClientRect();
    if (r.right > W + 2 && s.position !== 'fixed' && hasText) offscreen.push(`${name(h)} right=${Math.round(r.right)}`);
  }
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem], [role=option], input:not([type=hidden]), select, summary, [role=radio], [role=menuitemradio]')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (phone && (r.height < 40 || r.width < 40) && !(e as HTMLInputElement).type?.match?.(/checkbox|radio/)) small.push(`${name(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (e.closest('.tb-controls, .tb-foot, .room-banner, .lobby-controls')) {
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && !e.contains(hit) && !hit.closest('.popover, .menu, .scrim, .toast')) covered.push(`${name(e)} under ${name(hit)}`);
    }
  }
  return { clipped, ellipsis, offscreen, small, covered, docOverflow: document.documentElement.scrollWidth > W + 1 };
};

/** Shots at every width and theme, with the checks; the window goes back to its size after. */
export async function snap(app: any, page: any, name: string, opts: { sizes?: Size[]; axe?: boolean } = {}) {
  const before = page.viewportSize() ?? { width: 1280, height: 800 };
  const sizes = opts.sizes ?? ALL;
  for (const [w, h] of sizes) {
    if (w !== page.viewportSize()?.width || h !== page.viewportSize()?.height) { await resize(app, page, w, h); await sleep(450); }
    const checks = await page.evaluate(CHECKS, w < 500).catch((e: Error) => ({ error: e.message }));
    let axe: unknown = null;
    for (const t of THEMES) {
      await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
      await sleep(180);
      await page.screenshot({ path: path.join(DIR, `${name}-${w}-${t}.png`) });
      if (AXE && opts.axe !== false && (w === 1280 || (w === 390 && t === 'light'))) {
        axe = await page.evaluate(async (src: string) => {
          if (!(window as any).axe) (0, eval)(src);
          const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, resultTypes: ['violations'] });
          return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, n: v.nodes.length, nodes: v.nodes.slice(0, 6).map((n: any) => `${n.target.join(' ')} :: ${(n.any[0]?.message ?? n.failureSummary ?? '').slice(0, 160)}`) }));
        }, AXE).catch((e: Error) => [{ id: 'axe-error', message: e.message }]);
        fs.appendFileSync(AUDIT, `${JSON.stringify({ name, w, theme: t, axe })}\n`);
      }
    }
    fs.appendFileSync(AUDIT, `${JSON.stringify({ name, w, checks })}\n`);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }
  if (before.width !== page.viewportSize()?.width || before.height !== page.viewportSize()?.height) { await resize(app, page, before.width, before.height); await sleep(350); }
}

/** One quick shot (no variants), for states that do not survive a resize. */
export async function one(page: any, name: string) { await page.screenshot({ path: path.join(DIR, `${name}.png`) }); }

/** The checks and axe on a page as it is (browser pages of the gateway), into this run's audit file. */
export async function audit(page: any, name: string) {
  const w = page.viewportSize()?.width ?? 1280;
  const checks = await page.evaluate(CHECKS, w < 500).catch((e: Error) => ({ error: e.message }));
  const axe = !AXE ? [] : await page.evaluate(async (src: string) => {
    if (!(window as any).axe) (0, eval)(src);
    const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, n: v.nodes.length, nodes: v.nodes.slice(0, 6).map((n: any) => `${n.target.join(' ')} :: ${(n.any[0]?.message ?? n.failureSummary ?? '').slice(0, 160)}`) }));
  }, AXE).catch((e: Error) => [{ id: 'axe-error', message: e.message }]);
  const theme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  fs.appendFileSync(AUDIT, `${JSON.stringify({ name, w, theme, axe })}\n${JSON.stringify({ name, w, checks })}\n`);
}
