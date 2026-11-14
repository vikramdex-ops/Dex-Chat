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
