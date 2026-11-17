// Realistic office content for the polish walk: people with long and non-Latin names, a busy
// project Space (long messages, code, a table, images, files, many reactions, Hindi and Tamil),
// a Direct, a side-track, Desk items and mentions for Pulse.
import https from 'node:https';
import zlib from 'node:zlib';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';

export function png(W: number, H: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * (W * 4 + 1) + 1 + x * 4;
    const stripe = ((x >> 4) + (y >> 4)) % 2;
    raw[o] = stripe ? rgb[0] : 240; raw[o + 1] = stripe ? rgb[1] : 240; raw[o + 2] = stripe ? rgb[2] : 236; raw[o + 3] = 255;
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const upload = (port: number, token: string, name: string, data: Buffer) => new Promise<{ id: string }>((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port, path: `/files?name=${encodeURIComponent(name)}`, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, 'content-length': String(data.length) } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s)));
  });
  r.on('error', reject); r.end(data);
});

export async function join(hub: any, username: string, name: string): Promise<HubClient> {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName: name, hostname: `${username}-pc` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); res(); } }; c.on('state', on); });
  return c;
}

export async function seed(hub: any, owner: any, page: any) {
  const ravi = await join(hub, 'ravi', 'Ravi Kulkarni');
  const anand = await join(hub, 'anand', 'Anantharaman Venkatasubramanian Krishnamurthy');
  const rajesh = await join(hub, 'rajesh', 'राजेश कुमार शर्मा');
  const murugan = await join(hub, 'murugan', 'முருகன் செல்வராஜ்');
  const meera = await join(hub, 'meera', 'Meera Iyer');
  const crew = [ravi, anand, rajesh, murugan, meera];
  const users = (await owner.request('directory.list')).users;
  const id = (acc: string) => users.find((u: any) => u.account.endsWith(acc))!.id;
  const priyaId = id('priya');
  const piping = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  const civil = await owner.request('admin.org.saveDepartment', { name: 'Civil and Structural' });
  for (const [acc, dep] of [['priya', piping], ['ravi', piping], ['anand', piping], ['rajesh', civil], ['murugan', civil], ['meera', civil]] as const) await owner.request('admin.org.setProfile', { userId: id(acc), departmentId: dep.id, title: acc === 'anand' ? 'Principal Piping Stress Engineer, Refinery Projects' : acc === 'priya' ? 'Piping Designer' : 'Engineer' }).catch(() => owner.request('admin.org.setProfile', { userId: id(acc), departmentId: dep.id }));
  await ravi.request('me.update', { statusText: 'At the Jamnagar site till Thursday, slow to reply' });
  await anand.request('me.update', { availability: 'busy' });
  await meera.request('me.update', { availability: 'dnd' });

  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12513 Jamnagar hydrotreater revamp, unit 4 piping', topic: 'Isometrics, MTOs and stress for unit 4. Drawings live on the P drive.', members: [priyaId, ...['ravi', 'anand', 'rajesh', 'murugan', 'meera'].map(id)] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', topic: 'Jamnagar site, day to day', members: [priyaId, id('ravi'), id('murugan')] });
  await owner.request('conv.create', { kind: 'space', name: 'Drafting standards', topic: 'Title blocks, layers, line weights', members: [priyaId] });
  const send = (c: any, convId: string, body: string, extra: any = {}) => c.request('msg.send', { convId, body, clientId: `s${Math.random()}`, ...extra });
  await send(owner, sp.id, 'Morning all. The revised MTO for area 3 is on the share. Please check lines 6"-P-1001-A1B and 2-CW-2045 before Friday.');
  await send(ravi, sp.id, 'Checked the first batch. Two supports on ISO-1001-01 clash with the cable tray at EL 104.5; I have marked them in red on the PDF. The remaining 14 isometrics look clean, but the bolt lengths on the 300# flanges need a second look because the gasket thickness changed in the last revision of the line class. Could someone from stress confirm the nozzle loads on N3 before we issue for construction? The client wants the package by end of next week and I would rather not send it twice.');
  await send(anand, sp.id, 'Nozzle loads from the last run:\n```\nNOZZLE  FX(N)   FY(N)   FZ(N)   MX(Nm)  MY(Nm)  MZ(Nm)\nN3      1240    -860    2210    410     -1290   375\nN4      980     -420    1650    290     -870    260\n```\nAll within the vendor allowables.');
  await send(rajesh, sp.id, 'Area | Lines | Status\n--- | --- | ---\nArea 3 | 42 | Checked\nArea 4 | 37 | In progress\nArea 5 | 18 | Not started');
  await send(rajesh, sp.id, 'प्लेटफ़ॉर्म की ऊँचाई 104.5 मीटर पर पक्की है। सपोर्ट को 300 मिमी खिसकाना होगा।');
  await send(murugan, sp.id, 'சைட்டில் பைப் ரேக் வேலை நாளை காலை தொடங்கும். கிரேன் 8 மணிக்கு வரும்.');
  const img = await upload(hub.port, (ravi as any).session.fileToken, 'clash-EL104.png', png(640, 360, [42, 140, 152]));
  const img2 = await upload(hub.port, (ravi as any).session.fileToken, 'support-detail.png', png(360, 480, [200, 120, 60]));
  await send(ravi, sp.id, 'Photos from the model review', { files: [img.id, img2.id] });
  const pdf = await upload(hub.port, (meera as any).session.fileToken, 'P-12513-ISO-1001-01 Rev C - Area 3 isometric (issued for review).pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'));
  const xls = await upload(hub.port, (meera as any).session.fileToken, 'MTO area 3.xlsx', Buffer.alloc(24000, 1));
  await send(meera, sp.id, 'Issued drawings attached', { files: [pdf.id, xls.id] });
  const hot = await send(owner, sp.id, `<@${priyaId}> can you take the bolt lengths? Thanks!`);
  for (const [c, e] of [[ravi, '👍'], [anand, '👍'], [rajesh, '✅'], [murugan, '🙏'], [meera, '👀'], [ravi, '🔥'], [anand, '🎉'], [rajesh, '💯'], [murugan, '😂'], [meera, '❤️']] as const) await c.request('msg.react', { messageId: hot.id, emoji: e, on: true }).catch(() => {});
  const parent = await send(ravi, sp.id, 'Starting a side-track for the cable tray clash so we do not flood the Space.');
  await send(anand, sp.id, 'I can move the tray 150 mm east if civil agrees.', { parentId: parent.id });
  await send(rajesh, sp.id, 'Civil agrees, the beam has room.', { parentId: parent.id });
  await send(owner, site.id, 'Crane arrives at 8 tomorrow. Safety briefing at 7:45 at the gate.');

  // a Direct from Ravi, unread, and one from the long-named colleague
  const dm = await ravi.request('conv.create', { kind: 'direct', members: [priyaId] });
  await send(ravi, dm.id, 'Hi Priya, are you free for a quick look at the pipe rack GA after lunch?');
  await send(ravi, dm.id, 'No rush, 2:30 works too.');
  const dm2 = await anand.request('conv.create', { kind: 'direct', members: [priyaId] });
  await send(anand, dm2.id, 'Sent you the stress report for N3.');

  // Desk: a reminder due now, one later today, one tomorrow; a kept message
  const now = Date.now();
  await page.evaluate(async ({ hotId, now }: any) => {
    await window.dex.request('remind.create', { text: 'Send bolt lengths to Vikram', messageId: hotId, dueAt: now - 60_000 });
    await window.dex.request('remind.create', { text: 'Call the client about the area 5 hold', dueAt: now + 2 * 3600_000 });
    await window.dex.request('remind.create', { text: 'Check the revised GA for the pipe rack in area 4 against the structural model and mark any clashes', dueAt: now + 26 * 3600_000 });
    await window.dex.request('msg.star', { messageId: hotId, on: true });
  }, { hotId: hot.id, now });
  return { sp, site, dm, dm2, crew, priyaId, hot, parent, ids: { ravi: id('ravi'), anand: id('anand') } };
}
