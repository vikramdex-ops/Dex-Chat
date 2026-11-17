// References: a message or file from one conversation posted into another as a pointer. What it
// points at is shown only to people who may open the source; files are never shared further.
// Also: authors removing link cards from their messages, and cards for meeting links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { REF_BODY } from '@dex/core';
import type { LinkCard, Message, MeetingInfo } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { office, me, nextClientId, nextEvent, send } from './office.ts';
import type { Hub } from '../src/hub.ts';

/** Ask the hub's file server for a file as someone: the status code. */
function fetchFile(hub: Hub, c: HubClient, fileId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: hub.port, path: `/files/${fileId}`, method: 'GET', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${c.session!.fileToken}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}

test('a reference shows the source only to people who may open it; others see only that it exists and who wrote it', async () => {
  const { owner, priya, ravi } = await office();
  // the source: a private Space with Vikram and Priya
  const leads = await owner.request('conv.create', { kind: 'space', name: 'Leads', private: true, members: [me(priya)] });
  const src = await send(priya, leads.id, 'Rev C of ISO-1001 is the one to use');
  // the target: a Space with all three
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [me(priya), me(ravi)] });

  // before posting: one person in Site team cannot open the source
  assert.deepEqual(await priya.request('refs.check', { convId: site.id, target: { convId: leads.id, messageId: src.id } }), { members: 2, without: 1 });

  const forRavi = nextEvent<Message>(ravi, 'msg.new', (m) => m.convId === site.id);
  const forOwner = nextEvent<Message>(owner, 'msg.new', (m) => m.convId === site.id);
  const ref = await priya.request('refs.send', { convId: site.id, target: { convId: leads.id, messageId: src.id }, clientId: nextClientId() });
  assert.equal(ref.body, REF_BODY, 'the stored text says nothing about the source');
  assert.equal(ref.files.length, 0, 'nothing is copied');
  assert.equal(ref.ref?.access, true);
  assert.equal(ref.ref?.message?.body, 'Rev C of ISO-1001 is the one to use');
  assert.equal(ref.ref?.convName, 'Leads');

  // Ravi is not in Leads: only the author, nothing else
  const r = (await forRavi).ref!;
  assert.deepEqual(r, { kind: 'message', authorId: me(priya), access: false });
  assert.equal(JSON.stringify(await forRavi).includes('ISO-1001'), false);
  assert.deepEqual(await ravi.request('refs.resolve', { messageId: ref.id }), { kind: 'message', authorId: me(priya), access: false });
  // Vikram is in Leads: the excerpt
  assert.equal((await forOwner).ref?.message?.body, 'Rev C of ISO-1001 is the one to use');

  // joining the source later opens it; leaving closes it again
  await owner.request('conv.addMembers', { convId: leads.id, userIds: [me(ravi)] });
  assert.equal((await ravi.request('refs.resolve', { messageId: ref.id })).message?.id, src.id);
  await ravi.request('conv.leave', { convId: leads.id });
  assert.equal((await ravi.request('refs.resolve', { messageId: ref.id })).access, false);

  // editing the source shows in the reference; deleting it leaves a note for people with access
  await priya.request('msg.edit', { messageId: src.id, body: 'Rev D of ISO-1001 is the one to use' });
  assert.equal((await owner.request('refs.resolve', { messageId: ref.id })).message?.body, 'Rev D of ISO-1001 is the one to use');
  await priya.request('msg.delete', { messageId: src.id });
  const gone = await owner.request('refs.resolve', { messageId: ref.id });
  assert.equal(gone.gone, true);
  assert.equal(gone.message, undefined);

  // a reference cannot be edited into something else
  await assert.rejects(priya.request('msg.edit', { messageId: ref.id, body: 'sneaky' }), /cannot be edited/);
});

test('only people who can open a source may reference it, and only into conversations they are in', async () => {
  const { owner, priya, ravi } = await office();
  const leads = await owner.request('conv.create', { kind: 'space', name: 'Leads', private: true, members: [me(priya)] });
  const src = await send(owner, leads.id, 'Budget for P-12 is approved');
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(ravi)] });
  const mine = await owner.request('conv.create', { kind: 'direct', members: [me(ravi)] });
  // Ravi is not in Leads
  await assert.rejects(ravi.request('refs.send', { convId: site.id, target: { convId: leads.id, messageId: src.id } }), /Message not found/);
  await assert.rejects(ravi.request('refs.check', { convId: site.id, target: { convId: leads.id, messageId: src.id } }), /Message not found/);
  // the wrong conversation for the message
  await assert.rejects(owner.request('refs.send', { convId: site.id, target: { convId: site.id, messageId: src.id } }), /Message not found/);
  // Priya is not in Site
  await assert.rejects(priya.request('refs.send', { convId: site.id, target: { convId: leads.id, messageId: src.id } }), /Conversation not found/);
  // not into the same conversation
  await assert.rejects(owner.request('refs.send', { convId: leads.id, target: { convId: leads.id, messageId: src.id } }), /already in this conversation/);
  await assert.rejects(owner.request('refs.send', { convId: site.id, target: {} as never }), /Choose a message or a file/);
  // a reference to a reference points at the original, and needs access to it
  const first = await owner.request('refs.send', { convId: site.id, target: { convId: leads.id, messageId: src.id } });
  await assert.rejects(ravi.request('refs.send', { convId: mine.id, target: { convId: site.id, messageId: first.id } }), /cannot reference something you cannot open/);
  const second = await owner.request('refs.send', { convId: mine.id, target: { convId: site.id, messageId: first.id } });
  assert.equal(second.ref?.messageId, src.id);
  // forwarding a reference keeps it a reference
  const [fwd] = await owner.request('msg.forward', { messageId: first.id, convIds: [mine.id] });
  assert.equal(fwd.ref?.messageId, src.id);
  assert.equal((await ravi.request('msg.get', { messageId: fwd.id })).ref?.access, false);
  // other people's references: access is checked for the viewer, not the person who posted it
  await assert.rejects(ravi.request('refs.resolve', { messageId: src.id }), /Message not found/);
  await assert.rejects(owner.request('refs.resolve', { messageId: src.id }), /not a reference/);
});

test('a file reference points at the same file: it is not shared further, and opens only for people who could already open it', async () => {
  const { hub, owner, priya, ravi } = await office();
  const leads = await owner.request('conv.create', { kind: 'space', name: 'Leads', private: true, members: [me(priya)] });
  const f = hub.files.storeBuffer(me(owner), 'budget.txt', 'text/plain', Buffer.from('P-12 budget'));
  await owner.request('msg.send', { convId: leads.id, body: 'Budget attached', files: [f.id], clientId: nextClientId() });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site', members: [me(priya), me(ravi)] });
  assert.deepEqual(await owner.request('refs.check', { convId: site.id, target: { fileId: f.id } }), { members: 2, without: 1 });
  const ref = await owner.request('refs.send', { convId: site.id, target: { fileId: f.id }, clientId: nextClientId() });
  assert.equal(ref.files.length, 0);
  assert.equal(ref.ref?.file?.id, f.id);
  assert.equal(ref.ref?.file?.name, 'budget.txt');
  // Ravi sees that a file exists and who shared it, not its name, and the file store still refuses him
  const forRavi = await ravi.request('msg.get', { messageId: ref.id });
  assert.deepEqual(forRavi.ref, { kind: 'file', authorId: me(owner), access: false });
  assert.equal(JSON.stringify(forRavi).includes('budget'), false);
  assert.equal(await fetchFile(hub, ravi, f.id), 404, 'the file server refuses him');
  assert.equal(await fetchFile(hub, priya, f.id), 200);
  // someone who cannot open a file cannot reference it
  await assert.rejects(ravi.request('refs.send', { convId: site.id, target: { fileId: f.id } }), /File not found/);
  await assert.rejects(ravi.request('refs.send', { convId: site.id, target: { fileId: '../../etc/passwd' } }), /File not found/);
});

test('authors remove link cards from their own messages', async () => {
  const { owner, priya } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Links', members: [me(priya)] });
  const m = await send(owner, sp.id, 'See https://example.test/a and \\\\fs01\\jobs\\P-12');
  await assert.rejects(priya.request('links.hide', { messageId: m.id, url: 'https://example.test/a', hidden: true }), /Only the person who wrote/);
  const told = nextEvent<Message>(priya, 'msg.updated', (x) => x.id === m.id);
  const hidden = await owner.request('links.hide', { messageId: m.id, url: 'https://example.test/a', hidden: true });
  assert.deepEqual(hidden.hiddenPreviews, ['https://example.test/a']);
  assert.deepEqual((await told).hiddenPreviews, ['https://example.test/a']);
  const back = await owner.request('links.hide', { messageId: m.id, url: 'https://example.test/a', hidden: false });
  assert.equal(back.hiddenPreviews, undefined);
});

test('a meeting link gets a card with its host and a way in', async () => {
  const { owner, priya, ravi } = await office();
  const m = await priya.request('meet.create', { title: 'Pump skid review', invite: [me(ravi)] }) as MeetingInfo;
  const card = await owner.request('links.preview', { url: m.link }) as LinkCard;
  assert.equal(card.kind, 'meeting');
  assert.equal(card.title, 'Pump skid review');
  assert.match(card.subtitle ?? '', /^Meeting \d{3}-\d{3}-\d{3}$/);
  assert.deepEqual(card.meta.find((x) => x.key === 'author')?.value, 'Priya');
  assert.deepEqual(card.actions.map((a) => [a.kind, a.target]), [['join', m.link], ['copy-path', m.link]]);
  assert.equal(card.ref?.convId, undefined, 'outsiders are not told which conversation holds it');
  const inside = await ravi.request('links.preview', { url: m.link }) as LinkCard;
  assert.equal(inside.ref?.convId, m.convId);
  assert.equal((await owner.request('links.preview', { url: 'dexconnect://meet/123-456-789' })).kind, 'restricted');
  assert.equal((await owner.request('links.preview', { url: 'dexconnect://meet/not-a-number' })).kind, 'restricted');
});
