// Finding words in a PDF's text and where they are drawn, with no DOM. A page's text comes as
// runs (pieces of text, each with the matrix it is drawn with and its width); the runs are joined
// into the page's text, a search finds matches in it, and each match is cut back into the runs it
// spans to get a box on the page for its highlight.

export interface TextRun { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }
export interface PageText { runs: TextRun[]; text: string; starts: number[] }
export interface Match { page: number; start: number; end: number }
export interface Segment { run: number; from: number; to: number }
/** A box as fractions of the unrotated page (0..1 from the top-left corner). */
export interface Box { left: number; top: number; width: number; height: number }

const MAX_QUERY = 200;

/** The page's text: the runs one after another, a line break where a run ends a line. */
export function pageText(runs: TextRun[]): PageText {
  let text = '';
  const starts: number[] = [];
  for (const r of runs) {
    starts.push(text.length);
    text += r.str;
    if (r.hasEOL) text += '\n';
  }
  return { runs, text, starts };
}

/** A search as a pattern: letters as typed (any case), any run of spaces matching any space or line break. */
export function queryPattern(query: string): RegExp | null {
  const q = query.normalize('NFC').trim().slice(0, MAX_QUERY);
  if (!q) return null;
  const body = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(body, 'giu');
}

/** Every match on a page, up to `max`. */
export function findMatches(page: PageText, query: string, pageIndex: number, max = 1000): Match[] {
  const re = queryPattern(query);
  if (!re) return [];
  // pdf.js normalises the text it extracts, so offsets in page.text are used as they are
  const out: Match[] = [];
  for (const m of page.text.matchAll(re)) {
    if (m.index === undefined || !m[0].length) continue;
    out.push({ page: pageIndex, start: m.index, end: m.index + m[0].length });
    if (out.length >= max) break;
  }
  return out;
}

/** The runs a match spans, with the part of each it covers. */
export function matchSegments(page: PageText, start: number, end: number): Segment[] {
  const out: Segment[] = [];
  // the last run that starts at or before `start`
  let lo = 0;
  let hi = page.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (page.starts[mid] <= start) lo = mid; else hi = mid - 1;
  }
  for (let i = Math.max(0, lo); i < page.runs.length && page.starts[i] < end; i++) {
    const s = page.starts[i];
    const len = page.runs[i].str.length;
    const from = Math.max(0, start - s);
    const to = Math.min(len, end - s);
    if (to > from) out.push({ run: i, from, to });
  }
  return out;
}

const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** How wide a piece of text is in some font (any unit): makes partial boxes follow the letters. */
export type Measure = (s: string) => number;
const evenly: Measure = (s) => s.length;

/** The four corners (PDF user space) of characters from..to of a run. */
export function segmentQuad(run: TextRun, from: number, to: number, measure: Measure = evenly): Array<[number, number]> {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = run.transform;
  const ul = Math.hypot(a, b) || 1;
  const vl = Math.hypot(c, d) || 1;
  const u: [number, number] = [a / ul, b / ul];
  const v: [number, number] = [c / vl, d / vl];
  const h = vl > 0 ? vl : run.height;
  const whole = measure(run.str) || Math.max(1, run.str.length);
  const x0 = from <= 0 ? 0 : (run.width * measure(run.str.slice(0, from))) / whole;
  const x1 = to >= run.str.length ? run.width : (run.width * measure(run.str.slice(0, to))) / whole;
  const lo = -0.2 * h;
  const up = 0.85 * h;
  const at = (x: number, y: number): [number, number] => [e + u[0] * x + v[0] * y, f + u[1] * x + v[1] * y];
  return [at(x0, lo), at(x1, lo), at(x1, up), at(x0, up)];
}

/** A quad as a box on the unrotated page, given the page's view box [x0, y0, x1, y1] in points. */
export function quadToBox(quad: Array<[number, number]>, view: number[]): Box {
  const [vx0 = 0, vy0 = 0, vx1 = 612, vy1 = 792] = view;
  const w = vx1 - vx0 || 1;
  const h = vy1 - vy0 || 1;
  // PDF space runs upwards from the bottom-left; the page box downwards from the top-left
  const flip = [1, 0, 0, -1, -vx0, vy1];
  const pts = quad.map(([x, y]) => apply(flip, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left: left / w, top: top / h, width: (Math.max(...xs) - left) / w, height: (Math.max(...ys) - top) / h };
}

/** Highlight boxes for a match. */
export function matchBoxes(page: PageText, m: Pick<Match, 'start' | 'end'>, view: number[], measure?: Measure): Box[] {
  return matchSegments(page, m.start, m.end).map((s) => quadToBox(segmentQuad(page.runs[s.run], s.from, s.to, measure), view));
}

/** The page's text for copying: runs joined, lines kept. */
export function copyText(page: PageText): string {
  return page.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
