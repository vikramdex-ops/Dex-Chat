// The on-device index of end-to-end encrypted Direct messages: Unicode words (Hindi and Tamil
// included), prefix search, edits and deletes, and a compact form that survives a round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, snippet, terms, tokenize, wordSpans } from '../src/renderer/localsearch/tokenize.ts';
import { LocalIndex } from '../src/renderer/localsearch/invindex.ts';

const ID = (n: number) => `01J${String(n).padStart(23, '0')}`;
const doc = (n: number, convId = 'c1', authorId = 'u1', createdAt = 1_700_000_000_000 + n * 1000) => ({ id: ID(n), convId, authorId, parentId: null, createdAt });

test('words by Unicode word boundaries: English, Hindi and Tamil keep their letters together', () => {
  assert.deepEqual(tokenize('Valve schedule for AREA-3 is ready, rev 4.2!'), ['valve', 'schedule', 'for', 'area', '3', 'is', 'ready', 'rev', '4.2']);
  // Devanagari vowel signs (matras) and the virama stay inside the word
  assert.deepEqual(tokenize('पाइपलाइन का नक्शा तैयार है।'), ['पाइपलाइन', 'का', 'नक्शा', 'तैयार', 'है']);
  // Tamil: pulli (virama) and vowel signs too
  assert.deepEqual(tokenize('வரைபடம் தயார், சரிபார்க்கவும்'), ['வரைபடம்', 'தயார்', 'சரிபார்க்கவும்']);
  // mixed scripts in one message
  assert.deepEqual(tokenize('P-12 का drawing'), ['p', '12', 'का', 'drawing']);
  // mentions by id and link targets are not words
  assert.deepEqual(tokenize('<@01HZZZZZZZZZZZZZZZZZZZZZZZ> see [sheet](https://x.example/a/b)'), ['see', 'sheet']);
  // folding: case, full-width letters, zero-width joiners
  assert.equal(fold('ＶＡＬＶＥ'), 'valve');
  assert.equal(fold('क्‍ष'), 'क्ष');
  assert.deepEqual(terms('Valve valve VALVE'), ['valve']);
});

test('without Intl.Segmenter the tokenizer still keeps Indic words whole', () => {
  assert.deepEqual(tokenize('पाइपलाइन का नक्शा', null), ['पाइपलाइन', 'का', 'नक्शा']);
  assert.deepEqual(tokenize('வரைபடம் தயார்', null), ['வரைபடம்', 'தயார்']);
  assert.deepEqual(tokenize("Ravi's rev 4.2, P-12", null), ["ravi's", 'rev', '4.2', 'p', '12']);
});

test('prefix search across every word of the query, newest first, with filters', () => {
  const ix = new LocalIndex();
  ix.add(doc(1), 'Valve schedule for area 3 is ready');
  ix.add(doc(2, 'c2', 'u2'), 'The valve pit flooded again');
  ix.add(doc(3), 'वाल्व की सूची तैयार है');
  ix.add(doc(4, 'c2'), 'வால்வு அட்டவணை தயார்');
  ix.add(doc(5), 'Lunch?');
  assert.equal(ix.size, 5);
  assert.deepEqual(ix.search('valve').map((h) => h.meta.id), [ID(2), ID(1)]);
  assert.deepEqual(ix.search('val sch').map((h) => h.meta.id), [ID(1)], 'every word, each as a prefix');
  assert.deepEqual(ix.search('VALVE PIT').map((h) => h.meta.id), [ID(2)]);
  assert.deepEqual(ix.search('वाल्').map((h) => h.meta.id), [ID(3)], 'a Hindi prefix');
  assert.deepEqual(ix.search('तैयार').map((h) => h.meta.id), [ID(3)]);
  assert.deepEqual(ix.search('வால்').map((h) => h.meta.id), [ID(4)], 'a Tamil prefix');
  assert.deepEqual(ix.search('valve nothing'), []);
  assert.deepEqual(ix.search('  '), []);
  // filters: conversation, author, time, conversations still open, paging
  assert.deepEqual(ix.search('valve', { convId: 'c1' }).map((h) => h.meta.id), [ID(1)]);
  assert.deepEqual(ix.search('valve', { from: 'u2' }).map((h) => h.meta.id), [ID(2)]);
  assert.deepEqual(ix.search('valve', { after: doc(2).createdAt }).map((h) => h.meta.id), [ID(2)]);
  assert.deepEqual(ix.search('valve', { before: doc(2).createdAt }).map((h) => h.meta.id), [ID(1)]);
  assert.deepEqual(ix.search('valve', { convs: new Set(['c2']) }).map((h) => h.meta.id), [ID(2)]);
  assert.deepEqual(ix.search('valve', { olderThan: ID(2) }).map((h) => h.meta.id), [ID(1)]);
  assert.equal(ix.search('valve', {}, 1).length, 1);
  const hit = ix.search('valve pit')[0];
  assert.deepEqual(hit.meta, { ...doc(2, 'c2', 'u2'), rev: 0 });
  assert.deepEqual(hit.words, ['valve', 'pit']);
});

test('edits replace what was indexed; deleted messages are not found; compaction keeps the rest', () => {
  const ix = new LocalIndex();
  for (let i = 1; i <= 50; i++) ix.add(doc(i), `drawing ${i} revision ${i % 3 === 0 ? 'approved' : 'pending'}`);
  ix.add(doc(7), 'drawing seven, superseded'); // an edit
  assert.equal(ix.search('pending').some((h) => h.meta.id === ID(7)), false);
  assert.equal(ix.search('superseded')[0].meta.id, ID(7));
  assert.equal(ix.remove(ID(9)), true);
  assert.equal(ix.remove(ID(9)), false);
  assert.equal(ix.search('approved').some((h) => h.meta.id === ID(9)), false);
  assert.equal(ix.stale, 2);
  const before = ix.search('drawing', {}, 100).map((h) => h.meta.id);
  ix.compact();
  assert.equal(ix.stale, 0);
  assert.deepEqual(ix.search('drawing', {}, 100).map((h) => h.meta.id), before);
  assert.equal(ix.size, 49);
  // a message with no words is not indexed
  ix.add(doc(99), '👍 !!');
  assert.equal(ix.has(ID(99)), false);
});

test('the index serialises compactly and reads back the same; damage is refused', () => {
  const ix = new LocalIndex();
  const words = ['valve', 'pump', 'flange', 'gasket', 'nozzle', 'वाल्व', 'பம்ப்', 'isometric', 'line', 'P-101'];
  for (let i = 1; i <= 2000; i++) ix.add(doc(i, `c${i % 7}`, `u${i % 5}`), `${words[i % words.length]} ${words[(i * 3) % words.length]} number ${i}`);
  ix.remove(ID(10));
  const bytes = ix.serialize();
  // 2,000 messages in about 50 bytes each: ids and dates dominate; the postings are a byte or two each
  assert.ok(bytes.length < 2000 * 56, `compact: ${bytes.length} bytes`);
  const back = LocalIndex.deserialize(bytes);
  assert.equal(back.size, 1999);
  for (const q of ['valve', 'pum', 'वाल्व', 'பம்', 'number 1999', 'p-101', 'line gasket']) {
    assert.deepEqual(back.search(q, {}, 50).map((h) => h.meta), ix.search(q, {}, 50).map((h) => h.meta), q);
  }
  back.add(doc(5000), 'added after loading');
  assert.equal(back.search('loading')[0].meta.id, ID(5000));
  assert.throws(() => LocalIndex.deserialize(new Uint8Array([1, 2, 3])));
  assert.throws(() => LocalIndex.deserialize(bytes.subarray(0, bytes.length - 3)));
  const bad = bytes.slice();
  bad[0] ^= 0xff;
  assert.throws(() => LocalIndex.deserialize(bad));
});

test('snippets mark the words that matched', () => {
  assert.equal(snippet('The valve pit flooded again', terms('valve fl')), 'The [[valve]] pit [[flooded]] again');
  assert.equal(snippet('नक्शा तैयार है', terms('तैया')), 'नक्शा [[तैयार]] है');
  const long = `${'word '.repeat(80)}valve at the end`;
  const s = snippet(long, ['valve'], 60);
  assert.ok(s.startsWith('…word ') && s.endsWith('[[valve]] at the end') && s.length <= 66, s);
  assert.equal(snippet('nothing here', ['zzz']), 'nothing here');
  assert.deepEqual(wordSpans('Hi राम', null).map((w) => [w.start, w.end]), [[0, 2], [3, 6]]);
});
