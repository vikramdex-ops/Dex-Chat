// "Control room ▸ Policies ▸ Meetings": every pointer into the Control room, in a message, a hint or
// a comment, names a section the Control room has. A section renamed or moved breaks this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '../../..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? (['i18n', 'node_modules'].includes(n) ? [] : files(p)) : /\.tsx?$/.test(n) ? [p] : [];
});
const admin = readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/views/Admin.tsx'), 'utf8');
const SECTIONS = new Set([...admin.matchAll(/\{ value: '[a-z]+', label: '([^']+)', icon:/g)].map((m) => m[1]));

test('every Control room pointer names a real section', () => {
  assert.ok(SECTIONS.has('Policies') && SECTIONS.has('Outside the office'), [...SECTIONS].join(', '));
  let n = 0;
  for (const dir of ['apps/hub/src', 'apps/desktop/src', 'apps/gateway/src', 'packages/core/src']) {
    for (const f of files(path.join(ROOT, dir))) {
      for (const m of readFileSync(f, 'utf8').replace(/&amp;/g, '&').matchAll(/Control room\s*(?:▸|→|>)\s*([^.,:;)'"`<*\n]+)/g)) {
        const section = m[1].split(/\s*(?:▸|→|>)\s*/)[0].replace(/\s*\(.*$/, '').trim();
        assert.ok(SECTIONS.has(section), `${path.relative(ROOT, f)}: "Control room ▸ ${section}" is not a section of the Control room`);
        n++;
      }
    }
  }
  assert.ok(n > 10, `${n} pointers checked`);
});

test('guest links are switched off under Policies', () => {
  const policies = readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/views/PoliciesUsage.tsx'), 'utf8');
  const meetings = readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/meet/MeetAdmin.tsx'), 'utf8');
  assert.match(policies, /<MeetingPolicies /, 'the Meetings card is part of Policies');
  assert.match(meetings, /<div className="eyebrow">Meetings<\/div>/);
  assert.match(meetings, /Hosts can invite guests who join from a browser/);
});
