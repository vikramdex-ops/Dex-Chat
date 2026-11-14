// Pins that end, kinds of kept messages, hashtags, starting a Space from a message, stickers and
// emoji added by anyone, file and scan answers in forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { office, me, send } from './office.ts';

const upload = (port: number, token: string, name: string, data: Buffer) => new Promise<{ id: string }>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, 'content-length': String(data.length) } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s)));
  });
  r.on('error', reject); r.end(data);
});
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('pins that end by themselves; kinds of kept messages', async () => {
  const { hub, owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Notices', members: [me(priya)] });
  const m = await send(owner, sp.id, 'Fire drill at 4');
  await assert.rejects(owner.request('msg.pin', { messageId: m.id, pinned: true, until: Date.now() + 1000 }), /a minute to a year/);
  const p = await owner.request('msg.pin', { messageId: m.id, pinned: true, until: Date.now() + 3600_000 });
  assert.equal(p.pinned, true);
  assert.ok(p.pinnedUntil! > Date.now());
  hub.messaging.tick(Date.now() + 2 * 3600_000);
  assert.equal((await owner.request('msg.list', { convId: sp.id })).messages[0].pinned, false);
  await priya.request('msg.star', { messageId: m.id, on: true, kind: 'todo' });
  assert.equal((await priya.request('desk.saved'))[0].kind, 'todo');
  await priya.request('msg.star', { messageId: m.id, on: true, kind: 'reference' });
  assert.equal((await priya.request('desk.saved'))[0].kind, 'reference');
});

test('hashtags are found exactly and listed by use', async () => {
  const { owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Piping', members: [me(priya)] });
  await send(owner, sp.id, 'Rev C issued #P12 #isometrics');
  await send(owner, sp.id, 'More #isometrics tomorrow');
  await send(owner, sp.id, 'isometrics without a tag, and a colour #1a2b3c and an anchor a#b');
  const r = await priya.request('search', { q: '#isometrics' });
  assert.equal(r.messages.length, 2);
  assert.equal((await priya.request('search', { q: '#isometrics tomorrow' })).messages.length, 1);
  const top = await priya.request('tags.top', { prefix: 'iso' });
  assert.deepEqual(top[0], { tag: 'isometrics', count: 2 });
  assert.deepEqual((await priya.request('tags.top')).map((t) => t.tag).sort(), ['isometrics', 'p12']);
});

test('a message and its side-track start a new Space, with credit', async () => {
  const { owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'General', members: [me(priya), me(ravi)] });
  const head = await send(priya, sp.id, 'Should the flare stack get its own Space?');
  await send(ravi, sp.id, 'Yes, lots coming', head.id);
  const fork = await owner.request('conv.fork', { messageId: head.id, name: 'Flare stack' });
  assert.equal(fork.name, 'Flare stack');
  assert.deepEqual([...fork.members].sort(), [me(owner), me(priya), me(ravi)].sort());
  const list = (await owner.request('msg.list', { convId: fork.id })).messages.filter((x) => !x.system);
  assert.equal(list[0].body, 'Should the flare stack get its own Space?');
  assert.equal(list[0].forwardedFrom?.authorId, me(priya));
  assert.equal(list[0].replyCount, 1);
  await assert.rejects(owner.request('conv.fork', { messageId: list[0].id + 'x', name: 'x' }), /not found/i);
});

test('stickers and emoji added by anyone, unless the office says otherwise', async () => {
  const { hub, owner, priya } = await office();
  const f = await upload(hub.port, priya.session!.fileToken, 'thumbs.png', PNG);
  const e = await priya.request('emoji.add', { name: 'well-done', fileId: f.id });
  assert.equal(e.createdBy, me(priya));
  const s = await priya.request('sticker.add', { name: 'Hard hat', pack: 'Site', fileId: f.id });
  assert.equal((await owner.request('sticker.list'))[0].name, 'Hard hat');
  await assert.rejects(owner.request('emoji.remove', { name: 'nope' }), /does not exist/);
  await owner.request('admin.policy.set', { memberEmoji: false });
  const f2 = await upload(hub.port, priya.session!.fileToken, 'b.png', PNG);
  await assert.rejects(priya.request('emoji.add', { name: 'another', fileId: f2.id }), /Only administrators/);
  await priya.request('sticker.remove', { id: s.id });
  await priya.request('emoji.remove', { name: 'well-done' });
  assert.equal((await owner.request('emoji.list')).length, 0);
});

test('forms take files and scanned codes; the author can open the files', async () => {
  const { hub, owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(priya), me(ravi)] });
  const msg = await owner.request('form.create', { convId: sp.id, title: 'Valve check', clientId: 'f1', fields: [
    { label: 'Tag', type: 'scan', required: true }, { label: 'Photo', type: 'file', required: true },
  ] });
  const form = msg.form!;
  const photo = await upload(hub.port, priya.session!.fileToken, 'valve.png', PNG);
  const notMine = await upload(hub.port, ravi.session!.fileToken, 'x.png', PNG);
  await assert.rejects(priya.request('form.respond', { formId: form.id, answers: { [form.fields[0].id]: 'V-2201', [form.fields[1].id]: notMine.id } }), /again/);
  await priya.request('form.respond', { formId: form.id, answers: { [form.fields[0].id]: 'V-2201', [form.fields[1].id]: photo.id } });
  const res = await owner.request('form.responses', { formId: form.id });
  assert.equal(res.responses[0].answers[form.fields[1].id], photo.id);
  assert.ok(hub.files.canRead(me(owner), photo.id), 'the form author opens the photo');
  assert.ok(!hub.files.canRead(me(ravi), photo.id), 'others do not');
});
