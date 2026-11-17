// A realistic office for performance work: about 120 people, 300 conversations, two years of
// history (60,000 messages with mentions, reactions, side-tracks, edits and files), Desk items,
// a busy calendar, meetings and recordings. Written straight into a hub's database with the
// hub's own schema, so it takes seconds rather than the hour 60,000 sends would.
//
//   node apps/hub/scripts/seed-office.ts <dataDir> [--me <username>] [--scale 1]
//
// Or from a script: `seedOffice(hub.store.db, { meId, ownerId })` on a running hub (the e2e perf
// run seeds around the person whose app it measures). Everything is generated from a fixed seed,
// so two runs give the same office.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';

export interface SeedOptions {
  /** The person whose app is measured: a member of every conversation, with a full Desk and Calendar. */
  meId: string;
  /** The hub's owner (an administrator, kept as is). */
  ownerId?: string;
  /** Multiplies messages, files, Desk items and events (1 = the office described above). */
  scale?: number;
  /** Where the hub keeps file blobs (images get a real picture so they render). */
  filesDir?: string;
  people?: number;
  conversations?: number;
  messages?: number;
  /** The conversation with the longest history (for scrolling back through it). */
  busyName?: string;
  log?: (line: string) => void;
}

export interface SeedResult {
  users: number; conversations: number; messages: number; files: number; reminders: number; saved: number; scheduled: number;
  events: number; meetings: number; recordings: number;
  /** The Space with the longest history, its message count, and a Direct with a long history. */
  busyConvId: string; busyCount: number; busyDirectId: string;
  /** A word that appears in about 1 in 40 messages (for search timing). */
  searchWord: string;
}

// ------------------------------------------------------------------ deterministic randomness
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const FIRST = ['Aarav', 'Priyanka', 'Rohan', 'Ananya', 'Vivek', 'Kavya', 'Arjun', 'Meera', 'Siddharth', 'Divya', 'Karthik', 'Lakshmi', 'Nikhil', 'Pooja', 'Rahul', 'Sneha', 'Aditya', 'Neha', 'Varun', 'Shreya', 'Manoj', 'Deepa', 'Suresh', 'Anjali', 'Ganesh', 'Revathi', 'Harish', 'Swathi', 'Prakash', 'Gayathri', 'Ramesh', 'Bhavana', 'Sanjay', 'Nandini', 'Ajay', 'Keerthi', 'Vijay', 'Asha', 'Kiran', 'Madhu'];
const LAST = ['Iyer', 'Nair', 'Reddy', 'Menon', 'Sharma', 'Patel', 'Rao', 'Kumar', 'Pillai', 'Desai', 'Joshi', 'Krishnan', 'Subramanian', 'Bhat', 'Gupta', 'Shetty', 'Mehta', 'Verma', 'Naidu', 'Chopra'];
const TITLES = ['Piping Engineer', 'Senior Piping Designer', 'Stress Engineer', 'Civil Engineer', 'Structural Designer', 'Instrumentation Engineer', 'Electrical Engineer', 'Process Engineer', 'Document Controller', 'Project Manager', 'CAD Technician', 'HVAC Engineer', 'QA/QC Inspector', 'Admin Executive', 'HR Manager', 'IT Support'];
const DEPTS = ['Piping', 'Stress', 'Civil & Structural', 'Instrumentation', 'Electrical', 'Process', 'Projects', 'Document Control', 'HVAC', 'Administration'];
const PROJECTS = ['P-12', 'P-14', 'P-17', 'P-21', 'P-23', 'P-30', 'P-31', 'P-38', 'P-40', 'P-44', 'P-52', 'P-55'];
const AREAS = ['Piping', 'Civil', 'Stress', 'Instruments', 'Electrical', 'HVAC', 'Site', 'Client', 'Design review', 'Isometrics', '3D model', 'Procurement'];
const OTHER_SPACES = ['Office', 'IT help', 'Lunch plans', 'Training', 'Standards', 'CAD admin', 'Safety', 'Timesheets', 'Library', 'Announcements', 'Cricket', 'Book club', 'Hiring', 'Facilities', 'Travel desk'];
const WORDS = 'the drawing revision line isometric nozzle load valve flange support pipe rack spool weld schedule client comments marked up model clash review area stress check pump vessel tank foundation grid elevation section detail datasheet instrument loop cable tray tray route duct riser BOM MTO material take-off approved for construction issued for review hold point site visit inspection report tag number line list P&ID GA layout plot plan steel beam column bolt anchor baseplate grout concrete rebar slab trench nozzle orientation thermal expansion loop spring hanger shoe guide stop'.split(' ');
const OPENERS = ['Can someone check', 'I have updated', 'Please review', 'Quick question on', 'FYI:', 'Uploaded', 'Client wants changes to', 'Site reports an issue with', 'Who is handling', 'Reminder:', 'Done with', 'Starting on', 'Need help with', 'Sharing the latest', 'Comments are in for'];
const EMOJI = ['👍', '✅', '🙏', '👀', '🎉', '😂', '🔥', '❤️', '💯', '🤔'];
const FILE_KINDS: Array<[string, string, number, number]> = [
  // extension, mime, min KB, max KB
  ['pdf', 'application/pdf', 80, 9000],
  ['dwg', 'image/vnd.dwg', 300, 25000],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20, 2000],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 20, 1500],
  ['png', 'image/png', 40, 3000],
  ['jpg', 'image/jpeg', 60, 4000],
  ['zip', 'application/zip', 500, 60000],
];

/** A small solid-colour PNG with a grid, written by hand (zlib only), so images render. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const line = x % 40 === 0 || y % 40 === 0;
      raw[row + 1 + x * 3] = line ? 255 : rgb[0];
      raw[row + 2 + x * 3] = line ? 255 : rgb[1];
      raw[row + 3 + x * 3] = line ? 255 : rgb[2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function seedOffice(db: DatabaseSync, opts: SeedOptions): SeedResult {
  const rnd = prng(20261115);
  const log = opts.log ?? (() => {});
  const scale = opts.scale ?? 1;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const chance = (p: number) => rnd() < p;
  const ulidAt = (t: number) => {
    let time = Math.floor(t);
    let out = '';
    for (let i = 0; i < 10; i++) { out = ALPHABET[time % 32] + out; time = Math.floor(time / 32); }
    for (let i = 0; i < 16; i++) out += ALPHABET[Math.floor(rnd() * 32)];
    return out;
  };
  const now = Date.now();
  const DAY = 86400_000;
  const start = now - 730 * DAY;
  /** A time during office hours on a working day, between two moments. */
  const officeTime = (from: number, to: number): number => {
    for (let i = 0; i < 20; i++) {
      const t = from + rnd() * (to - from);
      const d = new Date(t);
      const h = d.getHours();
      if (d.getDay() !== 0 && h >= 9 && h < 19) return t;
    }
    return from + rnd() * (to - from);
  };

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return tx(() => {
    // ---------------------------------------------------------------- people
    const existing = db.prepare("SELECT id, account, display_name FROM users WHERE role != 'bot'").all() as Array<{ id: string; account: string; display_name: string }>;
    const want = opts.people ?? 120;
    const people: string[] = existing.map((u) => u.id);
    const names = new Map(existing.map((u) => [u.id, u.display_name] as const));
    const insUser = db.prepare('INSERT INTO users (id, account, display_name, role, title, status_text, created_at, availability) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insDevice = db.prepare("INSERT INTO devices (id, user_id, public_key, hostname, status, created_at, last_seen, decided_by, decided_at) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)");
    const insDept = db.prepare('INSERT OR IGNORE INTO departments (id, name, parent_id, head_id, created_at) VALUES (?, ?, NULL, NULL, ?)');
    const insProfile = db.prepare('INSERT OR REPLACE INTO profiles (account, title, department_id, manager_account, phone, extension, location, email, employee_id, joined_on, birthday) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const deptIds = DEPTS.map((d) => { const id = ulidAt(start); insDept.run(id, d, start); return (db.prepare('SELECT id FROM departments WHERE name = ?').get(d) as { id: string }).id; });
    const usedAccounts = new Set(existing.map((u) => u.account.toLowerCase()));
    let n = 0;
    while (people.length < want) {
      const first = FIRST[n % FIRST.length];
      const last = LAST[Math.floor(n / FIRST.length + n * 7) % LAST.length];
      n++;
      const account = `DEX\\${first.toLowerCase()}.${last.toLowerCase()}`;
      if (usedAccounts.has(account.toLowerCase())) continue;
      usedAccounts.add(account.toLowerCase());
      const id = ulidAt(start + rnd() * 30 * DAY);
      const display = `${first} ${last}`;
      const avail = chance(0.1) ? 'busy' : chance(0.05) ? 'dnd' : 'available';
      insUser.run(id, account, display, 'member', pick(TITLES), chance(0.2) ? pick(['On site today', 'Working from home', 'In client review', 'Back at 3']) : null, start, avail);
      insDevice.run(ulidAt(start), id, crypto.randomBytes(32).toString('base64'), `${first.toUpperCase()}-PC`, start, now - int(0, 20 * DAY), opts.ownerId ?? null, start);
      insProfile.run(account, pick(TITLES), pick(deptIds), null, `+91 98${int(10000000, 99999999)}`, String(int(200, 899)), pick(['Bay A', 'Bay B', 'Bay C', 'Site office', '2nd floor']), `${first.toLowerCase()}.${last.toLowerCase()}@dexterity.example`, `DX${int(1000, 9999)}`, new Date(start - int(0, 3000) * DAY).toISOString().slice(0, 10), `${int(1970, 2000)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`);
      people.push(id);
      names.set(id, display);
    }
    const me = opts.meId;
    const others = people.filter((p) => p !== me);
    log(`people: ${people.length}`);

    // ---------------------------------------------------------------- conversations
    const wantConvs = opts.conversations ?? 300;
    const insConv = db.prepare('INSERT INTO conversations (id, kind, name, topic, private, everyone, direct_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insMember = db.prepare('INSERT OR IGNORE INTO conv_members (conv_id, user_id, joined_at, last_read_id, muted, pinned_at) VALUES (?, ?, ?, NULL, ?, ?)');
    interface Conv { id: string; kind: 'space' | 'direct'; members: string[]; weight: number; created: number }
    const convs: Conv[] = [];
    // the office-wide Space (the hub made it when the owner joined)
    const office = db.prepare('SELECT id FROM conversations WHERE everyone = 1').get() as { id: string } | undefined;
    if (office) {
      for (const p of people) insMember.run(office.id, p, start, 0, null);
      convs.push({ id: office.id, kind: 'space', members: people, weight: 6, created: start });
    }
    const takenNames = new Set((db.prepare("SELECT name FROM conversations WHERE kind = 'space'").all() as Array<{ name: string }>).map((r) => r.name.toLowerCase()));
    const spaceNames: string[] = [];
    for (const p of PROJECTS) for (const a of AREAS) spaceNames.push(`${p} ${a}`);
    for (const s of OTHER_SPACES) spaceNames.push(s);
    const busyName = opts.busyName ?? 'P-12 Piping';
    // a third Spaces, the rest Direct (one to one with everyone, then groups)
    const wantSpaces = Math.round(wantConvs * 0.27);
    const spaceList = [busyName, ...spaceNames.filter((s) => s !== busyName)].filter((s) => !takenNames.has(s.toLowerCase())).slice(0, wantSpaces - convs.length);
    for (const name of spaceList) {
      const id = ulidAt(start + rnd() * 200 * DAY);
      const created = start + rnd() * 200 * DAY;
      const size = name === busyName ? 40 : int(4, 45);
      const members = [me, ...shuffle(others, rnd).slice(0, size)];
      insConv.run(id, 'space', name, chance(0.6) ? `${name}: drawings, comments and site questions` : null, chance(0.25) ? 1 : 0, 0, null, pick(members), created);
      for (const m of members) insMember.run(id, m, created, chance(0.05) ? 1 : 0, m === me && chance(0.06) ? now - int(1, 300) * DAY : null);
      convs.push({ id, kind: 'space', members, weight: name === busyName ? 0 : 0.4 + rnd() * 2.5, created });
    }
    const busy = convs.find((c) => c.kind === 'space' && c.id !== office?.id)!;
    let directs = 0;
    const wantDirects = wantConvs - convs.length;
    const directKeys = new Set((db.prepare('SELECT direct_key FROM conversations WHERE direct_key IS NOT NULL').all() as Array<{ direct_key: string }>).map((r) => r.direct_key));
    let busyDirect: Conv | null = null;
    for (let i = 0; directs < wantDirects && i < wantDirects * 4; i++) {
      const group = i >= others.length;
      const members = group ? [me, ...shuffle(others, rnd).slice(0, int(2, 7))] : [me, others[i]];
      const key = [...members].sort().join(',');
      if (directKeys.has(key)) continue;
      directKeys.add(key);
      const id = ulidAt(start + rnd() * 400 * DAY);
      const created = start + rnd() * 400 * DAY;
      insConv.run(id, 'direct', null, null, 1, 0, key, members[1], created);
      for (const m of members) insMember.run(id, m, created, 0, m === me && chance(0.05) ? now - int(1, 300) * DAY : null);
      const c: Conv = { id, kind: 'direct', members, weight: group ? 0.15 + rnd() * 0.6 : 0.05 + rnd() * rnd() * 3, created };
      if (!busyDirect && !group) { busyDirect = c; c.weight = 3; }
      convs.push(c);
      directs++;
    }
    log(`conversations: ${convs.length} (${convs.filter((c) => c.kind === 'space').length} Spaces)`);

    // ---------------------------------------------------------------- messages
    // side-tracks add about 8.5% on top of the conversation messages
    const wantMessages = Math.round((opts.messages ?? 60_000) * scale / 1.085);
    const busyCount = Math.round(wantMessages * 0.11); // about 6,100: the conversation to scroll back through
    const rest = wantMessages - busyCount;
    const totalWeight = convs.reduce((s, c) => s + c.weight, 0);
    interface Draft { conv: Conv; at: number; author: string; body: string; parent: number | null; mentions: string[]; edited: boolean; deleted: boolean; id?: string; files: number }
    const drafts: Draft[] = [];
    const sentence = (min: number, max: number) => {
      const k = int(min, max);
      const w: string[] = [];
      for (let i = 0; i < k; i++) w.push(pick(WORDS));
      return w.join(' ');
    };
    const tag = () => `${pick(PROJECTS)}-${pick(['ISO', 'GA', 'PID', 'STR', 'CIV'])}-${String(int(1, 999)).padStart(4, '0')}`;
    const bodyFor = (c: Conv, author: string): { body: string; mentions: string[] } => {
      const mentions: string[] = [];
      const r = rnd();
      let body: string;
      if (r < 0.35) body = pick(['ok', 'Thanks!', 'Noted', 'Will do', 'On it', 'Done', 'Sure', 'Give me 10 minutes', 'Checking now', 'Yes, approved', 'Sounds good', 'Not yet']);
      else if (r < 0.8) body = `${pick(OPENERS)} ${sentence(4, 18)} for ${tag()}`;
      else if (r < 0.93) body = `${pick(OPENERS)} ${sentence(15, 40)}.\n\n- ${sentence(4, 10)}\n- ${sentence(4, 10)}\n- ${sentence(4, 10)}\n\nRev ${int(0, 6)} is on \\\\fileserver\\projects\\${pick(PROJECTS)}\\${tag()}.pdf`;
      else if (r < 0.97) body = `${pick(OPENERS)} ${sentence(30, 90)}. **${sentence(2, 5)}** and \`${tag()}\` ${sentence(20, 60)}.`;
      else body = `Line list extract:\n\`\`\`\n${Array.from({ length: int(4, 14) }, () => `${tag()}  ${int(2, 24)}"  ${pick(['CS', 'SS316', 'A106-B', 'GRE'])}  ${int(10, 400)}°C`).join('\n')}\n\`\`\``;
      if (chance(0.1)) {
        const who = pick(c.members.filter((m) => m !== author)) ?? null;
        if (who) { mentions.push(who); body = `<@${who}> ${body}`; }
      }
      if (c.kind === 'space' && chance(0.004)) body = `<@all> ${body}`;
      if (chance(0.03)) body += ` #${pick(['rfi', 'urgent', 'clientcomment', 'hold', 'ifc'])}`;
      return { body, mentions };
    };
    const addConvMessages = (c: Conv, count: number) => {
      const from = Math.max(c.created, start);
      for (let i = 0; i < count; i++) {
        const author = c.members.length > 2 && chance(0.12) ? me : pick(c.members);
        const { body, mentions } = bodyFor(c, author);
        drafts.push({ conv: c, at: officeTime(from, now - 60_000), author, body, parent: null, mentions, edited: chance(0.03), deleted: chance(0.008), files: 0 });
      }
    };
    addConvMessages(busy, busyCount);
    for (const c of convs) if (c !== busy) addConvMessages(c, Math.round(rest * c.weight / totalWeight));
    // side-tracks: about 8% of messages are replies, in bursts under a few parents
    const roots = drafts.length;
    for (let i = 0; i < roots * 0.025; i++) {
      const p = int(0, roots - 1);
      const parent = drafts[p];
      const replies = int(1, 6);
      for (let k = 0; k < replies; k++) {
        const author = pick(parent.conv.members);
        const { body, mentions } = bodyFor(parent.conv, author);
        drafts.push({ conv: parent.conv, at: Math.min(now - 30_000, parent.at + rnd() * 3 * DAY), author, body, parent: p, mentions, edited: chance(0.02), deleted: false, files: 0 });
      }
    }
    // files: 3,000 over about 2,500 messages
    const wantFiles = Math.round(3000 * scale);
    let filesLeft = wantFiles;
    while (filesLeft > 0) {
      const d = drafts[int(0, drafts.length - 1)];
      if (d.deleted || d.files) continue;
      d.files = Math.min(filesLeft, chance(0.15) ? int(2, 4) : 1);
      filesLeft -= d.files;
    }
    // time order gives ULIDs in order, as the hub's own would be
    const order = drafts.map((_, i) => i).sort((a, b) => drafts[a].at - drafts[b].at);
    // two messages in the same millisecond still get rising ids, as the hub's monotonic ulid() gives them
    let prev = '';
    const bump = (id: string) => { const c = [...id]; for (let k = c.length - 1; k >= 10; k--) { const v = ALPHABET.indexOf(c[k]); if (v < 31) { c[k] = ALPHABET[v + 1]; return c.join(''); } c[k] = ALPHABET[0]; } return c.join(''); };
    for (const i of order) { let id = ulidAt(drafts[i].at); if (id <= prev) id = bump(prev); drafts[i].id = prev = id; }
    const insMsg = db.prepare('INSERT INTO messages (id, conv_id, author_id, body, parent_id, created_at, edited_at, deleted, pinned, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // the search index as the hub writes it: in message order, with search_rows where the hub keeps them
    const hasRows = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_rows'").get();
    let ftsRow = Math.max((db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM messages_fts').get() as { n: number }).n,
      hasRows ? (db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM search_rows').get() as { n: number }).n : 0);
    const insFtsRow = db.prepare('INSERT INTO messages_fts (rowid, body, message_id, conv_id) VALUES (?, ?, ?, ?)');
    const insSearchRow = hasRows ? db.prepare('INSERT INTO search_rows (n, message_id) VALUES (?, ?)') : null;
    const insFts = { run: (body: string, id: string, conv: string) => { ftsRow++; insSearchRow?.run(ftsRow, id); insFtsRow.run(ftsRow, body, id, conv); } };
    const insMention = db.prepare('INSERT OR IGNORE INTO mentions (message_id, conv_id, user_id) VALUES (?, ?, ?)');
    const insReaction = db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
    const insTag = db.prepare('INSERT OR IGNORE INTO message_tags (message_id, conv_id, tag, created_at) VALUES (?, ?, ?, ?)');
    const insFile = db.prepare('INSERT INTO files (id, name, mime, size, sha256, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insMsgFile = db.prepare('INSERT INTO message_files (message_id, file_id, conv_id, position) VALUES (?, ?, ?, ?)');
    // real pictures for image files, stored once like the hub stores uploads
    const pictures: Array<{ sha: string; size: number }> = [];
    for (const rgb of [[42, 140, 152], [30, 96, 102], [247, 175, 68], [120, 130, 140]] as Array<[number, number, number]>) {
      const buf = png(640, 400, rgb);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (opts.filesDir) { fs.mkdirSync(path.join(opts.filesDir, sha.slice(0, 2)), { recursive: true }); fs.writeFileSync(path.join(opts.filesDir, sha.slice(0, 2), sha), buf); }
      pictures.push({ sha, size: buf.length });
    }
    let fileCount = 0;
    let pinned = 0;
    const ftsNames = names;
    for (const i of order) {
      const d = drafts[i];
      const parentId = d.parent === null ? null : drafts[d.parent].id!;
      const pin = !d.deleted && d.parent === null && chance(0.002) && pinned++ < 400 ? 1 : 0;
      insMsg.run(d.id!, d.conv.id, d.author, d.body, parentId, Math.floor(d.at), d.edited ? Math.floor(d.at + rnd() * 3600_000) : null, d.deleted ? 1 : 0, pin, `seed-${d.id}`);
      if (d.deleted) continue;
      const text = d.body.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${ftsNames.get(id) ?? ''}`);
      insFts.run(text, d.id!, d.conv.id);
      for (const m of d.mentions) insMention.run(d.id!, d.conv.id, m);
      for (const t of d.body.match(/#[a-z]+/g) ?? []) insTag.run(d.id!, d.conv.id, t.slice(1), Math.floor(d.at));
      if (chance(0.15)) {
        const k = chance(0.7) ? 1 : int(2, 4);
        for (let r = 0; r < k; r++) {
          const emoji = pick(EMOJI);
          const people = int(1, Math.min(8, d.conv.members.length));
          for (let p = 0; p < people; p++) insReaction.run(d.id!, pick(d.conv.members), emoji, Math.floor(d.at + 60_000));
        }
      }
      for (let f = 0; f < d.files; f++) {
        const [ext, mime, lo, hi] = pick(FILE_KINDS);
        const image = mime.startsWith('image/') && ext !== 'dwg';
        const pic = image ? pick(pictures) : null;
        const fid = ulidAt(d.at);
        insFile.run(fid, `${tag()}-rev${int(0, 5)}.${image ? 'png' : ext}`, image ? 'image/png' : mime, pic ? pic.size : int(lo, hi) * 1024, pic ? pic.sha : crypto.randomBytes(32).toString('hex'), d.author, Math.floor(d.at));
        insMsgFile.run(d.id!, fid, d.conv.id, f);
        fileCount++;
      }
    }
    // read up to recently: most conversations read, a few with unread messages
    const setRead = db.prepare('UPDATE conv_members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?');
    const lastIds = new Map<string, string[]>();
    for (const i of order) { const d = drafts[i]; if (d.parent === null) { const a = lastIds.get(d.conv.id) ?? []; a.push(d.id!); if (a.length > 40) a.shift(); lastIds.set(d.conv.id, a); } }
    for (const c of convs) {
      const ids = lastIds.get(c.id) ?? [];
      if (!ids.length) continue;
      for (const m of c.members) setRead.run(chance(0.85) ? ids[ids.length - 1] : ids[Math.max(0, ids.length - 1 - int(1, 30))], c.id, m);
    }
    log(`messages: ${drafts.length}, files: ${fileCount}`);

    // ---------------------------------------------------------------- Desk
    const visible = drafts.filter((d) => !d.deleted && d.conv.members.includes(me));
    const insStar = db.prepare('INSERT OR IGNORE INTO stars (user_id, message_id, created_at, kind) VALUES (?, ?, ?, ?)');
    const insRem = db.prepare('INSERT INTO reminders (id, user_id, created_by, text, message_id, conv_id, due_at, repeat, done_at, fired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insSched = db.prepare("INSERT INTO scheduled (id, user_id, conv_id, parent_id, body, files, send_at, created_at, status) VALUES (?, ?, ?, NULL, ?, '[]', ?, ?, 'pending')");
    const wantDesk = Math.round(2000 * scale);
    let saved = 0, reminders = 0, scheduled = 0;
    const savedForMe = Math.round(wantDesk * 0.2);
    for (let i = 0; i < savedForMe; i++) {
      const d = pick(visible);
      insStar.run(me, d.id!, Math.floor(d.at + 3600_000), pick(['keep', 'keep', 'todo', 'important', 'followup', 'reference']));
      saved++;
    }
    // reminders: mine (open ones up to the hub's limit of 500, and many done), and other people's
    const openForMe = Math.min(450, Math.round(wantDesk * 0.22));
    const doneForMe = Math.round(wantDesk * 0.25);
    for (let i = 0; i < openForMe + doneForMe; i++) {
      const done = i >= openForMe;
      const onMsg = chance(0.5) ? pick(visible) : null;
      const created = officeTime(now - 400 * DAY, now - DAY);
      const due = done ? created + rnd() * 10 * DAY : now + (rnd() - 0.03) * 60 * DAY;
      insRem.run(ulidAt(created), me, chance(0.85) ? me : pick(others), onMsg ? 'About this message' : `${pick(OPENERS)} ${tag()}`, onMsg?.id ?? null, onMsg?.conv.id ?? null, Math.floor(due), chance(0.08) ? pick(['daily', 'weekly', 'monthly']) : 'none', done ? Math.floor(due) : null, due < now ? Math.floor(due) : null, Math.floor(created));
      reminders++;
    }
    const scheduledForMe = Math.min(150, Math.round(wantDesk * 0.04));
    const myConvs = convs.filter((c) => c.members.includes(me));
    for (let i = 0; i < scheduledForMe; i++) {
      const c = pick(myConvs);
      insSched.run(ulidAt(now - rnd() * 5 * DAY), me, c.id, `${pick(OPENERS)} ${sentence(4, 14)}`, Math.floor(now + rnd() * 30 * DAY + 3600_000), Math.floor(now - rnd() * 5 * DAY));
      scheduled++;
    }
    while (saved + reminders + scheduled < wantDesk) {
      const who = pick(others);
      const created = officeTime(now - 400 * DAY, now - DAY);
      insRem.run(ulidAt(created), who, who, `${pick(OPENERS)} ${tag()}`, null, null, Math.floor(now + (rnd() - 0.5) * 60 * DAY), 'none', chance(0.5) ? Math.floor(created + DAY) : null, null, Math.floor(created));
      reminders++;
    }
    log(`Desk: ${saved} kept, ${reminders} reminders, ${scheduled} scheduled`);

    // ---------------------------------------------------------------- Calendar
    const insEvent = db.prepare('INSERT INTO events (id, title, description, location, venue_id, start_at, end_at, all_day, organizer_id, conv_id, online, recurrence, until_at, reminder_min, cancelled, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)');
    const insAtt = db.prepare('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)');
    const wantEvents = Math.round(400 * scale);
    for (let i = 0; i < wantEvents; i++) {
      // most in the recent past and the next weeks: this week is always busy
      const r = rnd();
      const around = r < 0.25 ? now + (rnd() - 0.5) * 14 * DAY : r < 0.7 ? now - rnd() * 180 * DAY : now + rnd() * 90 * DAY;
      const s0 = new Date(officeTime(around - DAY, around + DAY));
      s0.setMinutes(rnd() < 0.5 ? 0 : 30, 0, 0);
      const startAt = s0.getTime();
      const len = pick([30, 30, 45, 60, 60, 90, 120]) * 60_000;
      const allDay = chance(0.03);
      const organizer = chance(0.3) ? me : pick(others);
      const c = chance(0.4) ? pick(myConvs) : null;
      const id = ulidAt(startAt - 3 * DAY);
      insEvent.run(id, `${pick(PROJECTS)} ${pick(['design review', 'client call', 'model review', 'stress walk-through', 'IFC planning', 'site coordination', 'weekly progress', 'clash check', '1:1', 'training'])}`,
        chance(0.5) ? sentence(8, 30) : null, chance(0.5) ? pick(['Meeting room 1', 'Meeting room 2', 'Board room', 'Site office']) : null,
        startAt, startAt + len, allDay ? 1 : 0, organizer, c?.id ?? null, chance(0.4) ? 1 : 0, chance(0.06) ? 'weekly' : 'none', chance(0.7) ? 10 : null, startAt - 3 * DAY);
      const att = new Set([organizer, me, ...shuffle(others, rnd).slice(0, int(1, 12))]);
      for (const a of att) insAtt.run(id, a, a === organizer ? 'yes' : pick(['yes', 'yes', 'maybe', 'no', 'pending']));
    }
    log(`events: ${wantEvents}`);

    // ---------------------------------------------------------------- meetings and recordings
    const insMeeting = db.prepare("INSERT OR IGNORE INTO meetings (id, kind, title, host_id, conv_id, event_id, lobby, join_before_host, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'outside', 1, ?)");
    const insLog = db.prepare('INSERT INTO meeting_log (room_id, meeting_id, title, kind, conv_id, host_id, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insLogP = db.prepare('INSERT OR IGNORE INTO meeting_log_people (room_id, user_id) VALUES (?, ?)');
    const insSession = db.prepare('INSERT OR IGNORE INTO meeting_sessions (room_id, meeting_id, title, kind, conv_id, host_id, started_at, ended_at, peak, breakouts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
    const insAttendance = db.prepare('INSERT INTO meeting_attendance (room_id, user_id, device_id, name, guest, joined_at, left_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
    const insRec = db.prepare("INSERT INTO meeting_recordings (id, title, meeting_id, room_id, conv_id, recorded_by, started_at, duration_ms, size, mime, received, file_id, status, chapters, share_conv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'video/webm', ?, ?, 'ready', '[]', 1, ?, ?)");
    const meetingIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = String(int(100000000, 999999999));
      insMeeting.run(id, 'conversation', `${pick(PROJECTS)} ${pick(['stand-up', 'review', 'client call'])}`, pick([me, ...others]), pick(myConvs).id, start + rnd() * 600 * DAY);
      meetingIds.push(id);
    }
    let meetings = 0, recordings = 0;
    const wantMeetings = Math.round(600 * scale);
    for (let i = 0; i < wantMeetings; i++) {
      const c = pick(myConvs);
      const startedAt = officeTime(start, now - DAY);
      const dur = int(5, 90) * 60_000;
      const room = ulidAt(startedAt);
      const meetingId = chance(0.6) ? pick(meetingIds) : null;
      const host = pick(c.members);
      const title = c.kind === 'space' ? `Room in ${pick(PROJECTS)}` : 'Call';
      insLog.run(room, meetingId, title, meetingId ? 'conversation' : 'instant', c.id, host, Math.floor(startedAt), Math.floor(startedAt + dur), dur);
      const present = c.members.slice(0, int(2, Math.min(15, c.members.length)));
      if (!present.includes(me) && chance(0.7)) present.push(me);
      for (const p of present) insLogP.run(room, p);
      insSession.run(room, meetingId, title, meetingId ? 'conversation' : 'instant', c.id, host, Math.floor(startedAt), Math.floor(startedAt + dur), present.length);
      for (const p of present) insAttendance.run(room, p, 'seed', names.get(p) ?? 'Someone', Math.floor(startedAt + rnd() * 60_000), Math.floor(startedAt + dur));
      meetings++;
      if (chance(0.25)) {
        const fid = ulidAt(startedAt + dur);
        const size = int(20, 900) * 1024 * 1024;
        insFile.run(fid, `Recording ${new Date(startedAt).toISOString().slice(0, 10)}.webm`, 'video/webm', size, crypto.randomBytes(32).toString('hex'), host, Math.floor(startedAt + dur));
        insRec.run(ulidAt(startedAt + dur), title, meetingId, room, c.id, host, Math.floor(startedAt), dur, size, size, fid, Math.floor(startedAt + dur), Math.floor(startedAt + dur));
        recordings++;
      }
    }
    log(`meetings: ${meetings}, recordings: ${recordings}`);

    // a word for search timing: common enough to fill a page of results
    return {
      users: people.length, conversations: convs.length, messages: drafts.length, files: fileCount + recordings, reminders, saved, scheduled,
      events: wantEvents, meetings, recordings, busyConvId: busy.id, busyCount, busyDirectId: busyDirect?.id ?? convs[convs.length - 1].id, searchWord: 'nozzle',
    };
  });
}

function shuffle<T>(a: readonly T[], rnd: () => number): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// ------------------------------------------------------------------ command line
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dataDir = args.find((a) => !a.startsWith('--'));
  if (!dataDir) { console.error('usage: node apps/hub/scripts/seed-office.ts <dataDir> [--me <username>] [--scale 1]'); process.exit(2); }
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const { Hub } = await import('../src/hub.ts');
  const hub = new Hub({ dataDir, name: 'Seeded Hub', updates: false, port: 0, discoveryPort: false });
  await hub.start();
  const db = hub.store.db;
  const meName = flag('me') ?? 'priya';
  let meRow = db.prepare('SELECT id FROM users WHERE account LIKE ?').get(`%\\${meName}`) as { id: string } | undefined;
  if (!meRow) {
    const id = `01SEED${'0'.repeat(20)}`;
    db.prepare("INSERT INTO users (id, account, display_name, role, created_at) VALUES (?, ?, ?, 'owner', ?)").run(id, `DEX\\${meName}`, meName, Date.now());
    db.prepare("INSERT INTO devices (id, user_id, public_key, hostname, status, created_at) VALUES (?, ?, 'seed', 'SEED-PC', 'approved', ?)").run(`01SEEDDEV${'0'.repeat(17)}`, id, Date.now());
    hub.messaging.ensureEveryoneSpace(id);
    meRow = { id };
  }
  const t0 = performance.now();
  const r = seedOffice(db, { meId: meRow.id, scale: Number(flag('scale') ?? 1), filesDir: path.join(dataDir, 'files'), log: (l) => console.log(l) });
  console.log(JSON.stringify(r), `${Math.round(performance.now() - t0)} ms`);
  await hub.stop();
}
