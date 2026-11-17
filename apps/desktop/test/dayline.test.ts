// The day's line: one line per day for everyone, every line once per cycle, office lines first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, dayNumber, lineForDay } from '../src/renderer/pulse/lines.ts';
import { drawingForDay } from '../src/renderer/pulse/drawing.ts';

test('every line comes round once a cycle, and the same day gives the same line', () => {
  const seen = new Set<number>();
  for (let d = 20000; d < 20000 + LINES.length; d++) seen.add(lineForDay(d).index);
  assert.equal(seen.size, LINES.length);
  assert.equal(lineForDay(20500).line.text, lineForDay(20500).line.text);
  assert.notEqual(lineForDay(20500).line.by, lineForDay(20501).line.by);
  assert.equal(dayNumber(new Date(2026, 10, 14, 23, 59).getTime()), dayNumber(new Date(2026, 10, 14, 0, 1).getTime()));
});

test('a drawing for every day: six kinds, all inside the sheet', () => {
  const titles = new Set<string>();
  for (let d = 20400; d < 20412; d++) {
    const g = drawingForDay(d);
    titles.add(g.title);
    assert.ok(g.strokes.length > 5, g.title);
    for (const s of g.strokes) assert.doesNotMatch(s.d, /NaN|Infinity/, g.title);
  }
  assert.equal(titles.size, 6);
});

test("a drawing's figures never write over each other", () => {
  const box = (l: { x: number; y: number; text: string; rotate?: number; anchor?: string }) => {
    const w = l.text.length * 6.2, h = 11;
    const cx = l.anchor === 'middle' ? l.x : l.x + w / 2, cy = l.y - h / 2 + 2;
    const a = (l.rotate ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const hw = (w * c + h * s) / 2, hh = (w * s + h * c) / 2;
    return [cx - hw, cy - hh, cx + hw, cy + hh];
  };
  for (let day = 20000; day < 21000; day++) {
    const g = drawingForDay(day);
    for (let i = 0; i < g.labels.length; i++) for (let j = i + 1; j < g.labels.length; j++) {
      const p = box(g.labels[i]), q = box(g.labels[j]);
      assert.ok(!(p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]), `${g.title} on day ${day}: "${g.labels[i].text}" over "${g.labels[j].text}"`);
    }
  }
});
