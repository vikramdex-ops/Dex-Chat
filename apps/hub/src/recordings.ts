// Meeting recordings kept on the hub. The recorder's PC composites the Room into one video
// (rooms/recorder.ts) and, when recording stops, uploads it here in chunks over the same
// connection as everything else (so it works through the gateway too). An upload resumes where it
// stopped; the office caps its size. Once complete, the video is stored with the office's files
// and listed on the Meet lens's Recordings shelf with its chapters (who spoke when).
//
// Who can watch is decided here: the recorder, administrators, the members of the meeting's
// conversation once it is shared with them, and anyone in the office (not guests) who opens its
// link once the link is on. Recordings follow the office's retention (Space or Direct, as their
// conversation), legal holds keep them, administrators can delete them, and every download is in
// the audit log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RECORDING_CHUNK, recordingLink, ulid } from '@dex/core';
import type { PublicUser, RecordingChapter, RecordingInfo } from '@dex/core';
import type { FileStore } from './files.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  meeting_id TEXT,
  room_id TEXT,
  conv_id TEXT,
  recorded_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  file_id TEXT,
  status TEXT NOT NULL,
  chapters TEXT NOT NULL DEFAULT '[]',
  share_conv INTEGER NOT NULL DEFAULT 0,
  link_token TEXT,
  link_on INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_recordings_room ON meeting_recordings(room_id);
CREATE INDEX IF NOT EXISTS idx_meeting_recordings_file ON meeting_recordings(file_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_recordings_token ON meeting_recordings(link_token) WHERE link_token IS NOT NULL;
CREATE TABLE IF NOT EXISTS recording_viewers (
  recording_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, user_id)
);
`;

export class RecordingError extends Error {}

interface Row {
  id: string; title: string; meeting_id: string | null; room_id: string | null; conv_id: string | null; recorded_by: string;
  started_at: number; duration_ms: number; size: number; mime: string; received: number; file_id: string | null; status: 'uploading' | 'ready';
  chapters: string; share_conv: number; link_token: string | null; link_on: number; created_at: number; updated_at: number;
}

export interface RecordingHost {
  db: DatabaseSync;
  files: FileStore;
  /** Where unfinished uploads wait (kept across restarts, so an upload can resume). */
  dir: string;
  userById(id: string): PublicUser | null;
  isMember(convId: string, userId: string): boolean;
  convKind(convId: string): 'space' | 'direct' | null;
  /** The meeting a Room held (from the reports), for a recording's title and conversation. */
  session(roomId: string): { meetingId: string | null; convId: string; title: string } | null;
  /** The person was in that Room. */
  attended(roomId: string, userId: string): boolean;
  maxBytes(): number;
  allowed(): boolean;
  retention(): { space: number | null; direct: number | null };
  held(convId: string | null, userId: string): boolean;
  audit(actorId: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  tell(userIds: string[], name: 'rec.updated' | 'rec.removed', data: unknown): void;
}

const DAY = 86400_000;
const MAX_UPLOADS_PER_PERSON = 3;
const MAX_CHAPTERS = 2000;
const isAdmin = (u: PublicUser) => u.role === 'owner' || u.role === 'admin';
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export class Recordings {
  private readonly h: RecordingHost;
  private readonly db: DatabaseSync;

  constructor(host: RecordingHost) {
    this.h = host;
    this.db = host.db;
    this.db.exec(SCHEMA);
    fs.mkdirSync(host.dir, { recursive: true });
    // a recording's video is never garbage, whatever messages it was or was not posted in
    host.files.keep.push('NOT EXISTS (SELECT 1 FROM meeting_recordings r WHERE r.file_id = f.id)');
    const prev = host.files.extraRead;
    host.files.extraRead = (userId, fileId) => prev(userId, fileId) || this.canReadFile(userId, fileId);
  }

  private part(id: string): string { return path.join(this.h.dir, `${id}.part`); }

  private row(id: unknown): Row | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM meeting_recordings WHERE id = ?').get(id) as Row | undefined : undefined;
  }

  private canView(r: Row, u: PublicUser): boolean {
    if (r.recorded_by === u.id || isAdmin(u)) return true;
    if (r.status !== 'ready') return false;
    if (r.share_conv && r.conv_id && this.h.isMember(r.conv_id, u.id)) return true;
    return !!r.link_on && u.role !== 'guest' && !!this.db.prepare('SELECT 1 FROM recording_viewers WHERE recording_id = ? AND user_id = ?').get(r.id, u.id);
  }

  private canManage(r: Row, u: PublicUser): boolean { return r.recorded_by === u.id || isAdmin(u); }

  /** May this person download this file because it is a recording they can watch? */
  canReadFile(userId: string, fileId: string): boolean {
    const u = this.h.userById(userId);
    if (!u) return false;
    const rows = this.db.prepare('SELECT * FROM meeting_recordings WHERE file_id = ?').all(fileId) as unknown as Row[];
    return rows.some((r) => this.canView(r, u));
  }

  isRecordingFile(fileId: string): string | null {
    return (this.db.prepare('SELECT id FROM meeting_recordings WHERE file_id = ? LIMIT 1').get(fileId) as { id: string } | undefined)?.id ?? null;
  }

  private expiresAt(r: Row): number | null {
    const kind = r.conv_id ? this.h.convKind(r.conv_id) : null;
    const ret = this.h.retention();
    const days = kind === 'direct' ? ret.direct : ret.space;
    if (days === null || this.h.held(r.conv_id, r.recorded_by)) return null;
    return r.created_at + days * DAY;
  }

  view(r: Row, viewer: PublicUser): RecordingInfo {
    let chapters: RecordingChapter[] = [];
    try { const v = JSON.parse(r.chapters) as unknown; if (Array.isArray(v)) chapters = v as RecordingChapter[]; } catch { /* none */ }
    const manage = this.canManage(r, viewer);
    return {
      id: r.id, title: r.title, meetingId: r.meeting_id, roomId: r.room_id, convId: r.conv_id,
      recordedBy: r.recorded_by, recordedByName: this.h.userById(r.recorded_by)?.displayName ?? 'Someone',
      startedAt: r.started_at, durationMs: r.duration_ms, size: r.size, mime: r.mime, fileId: r.status === 'ready' ? r.file_id : null,
      status: r.status, received: r.received, chapters, sharedWithConv: !!r.share_conv,
      link: manage && r.link_token ? recordingLink(r.link_token) : null, linkOn: !!r.link_on,
      createdAt: r.created_at, expiresAt: this.expiresAt(r), canManage: manage,
    };
  }

  // ---------------------------------------------------------------- upload
  begin(me: PublicUser, d: Record<string, unknown>): { id: string; received: number; chunk: number } {
    if (me.role === 'guest' || me.role === 'bot') throw new RecordingError('Only members of the office keep recordings on the hub.');
    if (!this.h.allowed()) throw new RecordingError('Recording calls is turned off for this office.');
    const size = Number(d.size);
    const startedAt = Number(d.startedAt);
    const max = this.h.maxBytes();
    if (!Number.isInteger(size) || size < 1) throw new RecordingError('The recording is empty.');
    if (size > max) throw new RecordingError(`Recordings can be up to ${Math.round(max / 1024 / 1024)} MB in this office. Save this one on your PC instead.`);
    if (!Number.isFinite(startedAt) || startedAt <= 0) throw new RecordingError('When did the recording start?');
    const mime = typeof d.mime === 'string' && /^video\/(webm|mp4)(;[\w=,.\s-]*)?$/.test(d.mime) ? d.mime.split(';')[0] : 'video/webm';
    // the same recording again (the connection dropped): carry on where the hub got to
    const again = this.db.prepare(`SELECT * FROM meeting_recordings WHERE recorded_by = ? AND started_at = ? AND size = ? AND status = 'uploading'`).get(me.id, Math.floor(startedAt), size) as Row | undefined;
    if (again) return { id: again.id, received: this.partSize(again), chunk: RECORDING_CHUNK };
    const busy = (this.db.prepare(`SELECT COUNT(*) AS n FROM meeting_recordings WHERE recorded_by = ? AND status = 'uploading'`).get(me.id) as { n: number }).n;
    if (busy >= MAX_UPLOADS_PER_PERSON) throw new RecordingError('Finish the recordings you are uploading first.');
    let roomId: string | null = typeof d.roomId === 'string' ? d.roomId : null;
    const session = roomId ? this.h.session(roomId) : null;
    if (roomId && (!session || !this.h.attended(roomId, me.id))) roomId = null;
    const title = clean(d.title, 120) || session?.title || `Room recording ${new Date(startedAt).toISOString().slice(0, 10)}`;
    const id = ulid();
    const now = Date.now();
    this.db.prepare(`INSERT INTO meeting_recordings (id, title, meeting_id, room_id, conv_id, recorded_by, started_at, size, mime, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`).run(id, title, roomId ? session!.meetingId : null, roomId, roomId ? session!.convId : null, me.id, Math.floor(startedAt), size, mime, now, now);
    fs.writeFileSync(this.part(id), '');
    this.h.audit(me.id, 'recording.uploadStarted', id, { roomId, size });
    return { id, received: 0, chunk: RECORDING_CHUNK };
  }

  /** What is on disk is what counts (a chunk written just before a crash is kept). */
  private partSize(r: Row): number {
    try { return Math.min(r.size, fs.statSync(this.part(r.id)).size); } catch { return 0; }
  }

  chunk(me: PublicUser, d: Record<string, unknown>): { received: number } {
    const r = this.row(d.id);
    if (!r || r.recorded_by !== me.id) throw new RecordingError('That upload is not yours or has ended.');
    if (r.status !== 'uploading') return { received: r.size };
    const received = this.partSize(r);
    const offset = Number(d.offset);
    if (typeof d.data !== 'string' || d.data.length > Math.ceil(RECORDING_CHUNK / 3) * 4 + 4) throw new RecordingError('Chunks are at most 512 KB.');
    const bytes = Buffer.from(d.data, 'base64');
    // a chunk sent twice (the answer was lost) is fine; a gap is not: the app starts again from `received`
    if (!Number.isInteger(offset) || offset !== received) return { received };
    if (received + bytes.length > r.size) throw new RecordingError('More data than the recording\'s size.');
    try {
      fs.appendFileSync(this.part(r.id), bytes);
    } catch (e) {
      throw new RecordingError((e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'The hub is out of disk space.' : 'The hub could not save the recording.');
    }
    const now = received + bytes.length;
    this.db.prepare('UPDATE meeting_recordings SET received = ?, updated_at = ? WHERE id = ?').run(now, Date.now(), r.id);
    return { received: now };
  }

  status(me: PublicUser, d: Record<string, unknown>): { received: number; size: number; status: 'uploading' | 'ready' } {
    const r = this.row(d.id);
    if (!r || r.recorded_by !== me.id) throw new RecordingError('That upload is not yours or has ended.');
    return { received: r.status === 'ready' ? r.size : this.partSize(r), size: r.size, status: r.status };
  }

  finish(me: PublicUser, d: Record<string, unknown>): RecordingInfo {
    const r = this.row(d.id);
    if (!r || r.recorded_by !== me.id) throw new RecordingError('That upload is not yours or has ended.');
    if (r.status === 'ready') return this.view(r, me);
    if (this.partSize(r) !== r.size) throw new RecordingError('The upload is not complete yet.');
    const duration = Math.max(0, Math.min(24 * 3600_000, Math.round(Number(d.durationMs) || 0)));
    const chapters: RecordingChapter[] = (Array.isArray(d.chapters) ? d.chapters : []).slice(0, MAX_CHAPTERS).map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { at: Math.max(0, Math.min(duration, Math.round(Number(o.at) || 0))), userId: clean(o.userId, 64), name: clean(o.name, 80) || 'Someone' };
    }).filter((c, i, a) => i === 0 || c.at >= a[i - 1].at);
    const stamp = new Date(r.started_at).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    const info = this.h.files.adopt(this.part(r.id), me.id, `${r.title.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 80)} ${stamp}.webm`, r.mime);
    this.db.prepare(`UPDATE meeting_recordings SET status = 'ready', file_id = ?, received = size, duration_ms = ?, chapters = ?, updated_at = ? WHERE id = ?`)
      .run(info.id, duration, JSON.stringify(chapters), Date.now(), r.id);
    const done = this.row(r.id)!;
    this.h.audit(me.id, 'recording.stored', r.id, { roomId: r.room_id, size: r.size, durationMs: duration, chapters: chapters.length });
    this.h.tell([me.id], 'rec.updated', this.view(done, me));
    return this.view(done, me);
  }

  // ---------------------------------------------------------------- the shelf
  list(me: PublicUser, limit: unknown): RecordingInfo[] {
    const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 60;
    const rows = this.db.prepare(`SELECT * FROM meeting_recordings WHERE (status = 'ready' OR recorded_by = ?) ORDER BY started_at DESC LIMIT 2000`).all(me.id) as unknown as Row[];
    return rows.filter((r) => this.canView(r, me)).slice(0, n).map((r) => this.view(r, me));
  }

  forRoom(roomId: string, me: PublicUser): RecordingInfo[] {
    const rows = this.db.prepare(`SELECT * FROM meeting_recordings WHERE room_id = ? AND status = 'ready' ORDER BY started_at`).all(roomId) as unknown as Row[];
    return rows.filter((r) => this.canView(r, me)).map((r) => this.view(r, me));
  }

  get(me: PublicUser, d: Record<string, unknown>): RecordingInfo {
    if (typeof d.token === 'string') {
      const r = this.db.prepare('SELECT * FROM meeting_recordings WHERE link_token = ?').get(d.token) as Row | undefined;
      if (!r || !r.link_on || r.status !== 'ready') throw new RecordingError('That recording link does not work any more.');
      if (me.role === 'guest' && !this.canView(r, me)) throw new RecordingError('Recording links are for people in the office.');
      if (me.role !== 'guest') this.db.prepare('INSERT OR IGNORE INTO recording_viewers (recording_id, user_id, at) VALUES (?, ?, ?)').run(r.id, me.id, Date.now());
      return this.view(r, me);
    }
    const r = this.row(d.id);
    if (!r || !this.canView(r, me)) throw new RecordingError('Recording not found.');
    return this.view(r, me);
  }

  share(me: PublicUser, d: Record<string, unknown>): RecordingInfo {
    const r = this.row(d.id);
    if (!r || !this.canView(r, me)) throw new RecordingError('Recording not found.');
    if (!this.canManage(r, me)) throw new RecordingError('Only the person who recorded it, or an administrator, can share it.');
    if (r.status !== 'ready') throw new RecordingError('Wait for the upload to finish.');
    if (typeof d.conv === 'boolean') {
      if (d.conv && !r.conv_id) throw new RecordingError('This recording is not from a meeting with a conversation.');
      this.db.prepare('UPDATE meeting_recordings SET share_conv = ? WHERE id = ?').run(d.conv ? 1 : 0, r.id);
    }
    if (typeof d.link === 'boolean') {
      const token = r.link_token ?? crypto.randomBytes(18).toString('base64url');
      this.db.prepare('UPDATE meeting_recordings SET link_on = ?, link_token = ? WHERE id = ?').run(d.link ? 1 : 0, token, r.id);
    }
    const next = this.row(r.id)!;
    this.h.audit(me.id, 'recording.shared', r.id, { withConversation: !!next.share_conv, link: !!next.link_on });
    return this.view(next, me);
  }

  rename(me: PublicUser, d: Record<string, unknown>): RecordingInfo {
    const r = this.row(d.id);
    if (!r || !this.canManage(r, me)) throw new RecordingError('Recording not found.');
    const title = clean(d.title, 120);
    if (!title) throw new RecordingError('Give the recording a title.');
    this.db.prepare('UPDATE meeting_recordings SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), r.id);
    return this.view(this.row(r.id)!, me);
  }

  delete(me: PublicUser, d: Record<string, unknown>): { ok: true } {
    const r = this.row(d.id);
    if (!r || !this.canView(r, me)) throw new RecordingError('Recording not found.');
    if (!this.canManage(r, me)) throw new RecordingError('Only the person who recorded it, or an administrator, can delete it.');
    this.remove(r);
    this.h.audit(me.id, 'recording.deleted', r.id, { title: r.title, recordedBy: r.recorded_by, byAdmin: r.recorded_by !== me.id });
    return { ok: true };
  }

  private remove(r: Row): void {
    this.db.prepare('DELETE FROM meeting_recordings WHERE id = ?').run(r.id);
    this.db.prepare('DELETE FROM recording_viewers WHERE recording_id = ?').run(r.id);
    fs.rmSync(this.part(r.id), { force: true });
    if (r.file_id) this.h.files.drop(r.file_id);
    this.h.tell([r.recorded_by], 'rec.removed', { id: r.id });
  }

  /** A recording was downloaded or played: who, from where. */
  downloaded(fileId: string, userId: string, partial: boolean, ip: string): void {
    const id = this.isRecordingFile(fileId);
    if (id && !partial) this.h.audit(userId, 'recording.downloaded', id, { ip });
  }

  /** Retention: recordings older than their conversation's period go (unless on hold); stale uploads too. */
  purge(now = Date.now()): number {
    let n = 0;
    for (const r of this.db.prepare(`SELECT * FROM meeting_recordings WHERE status = 'ready'`).all() as unknown as Row[]) {
      const until = this.expiresAt(r);
      if (until !== null && until < now) { this.remove(r); n++; }
    }
    for (const r of this.db.prepare(`SELECT * FROM meeting_recordings WHERE status = 'uploading' AND updated_at < ?`).all(now - 2 * DAY) as unknown as Row[]) { this.remove(r); n++; }
    if (n) this.h.audit(null, 'recording.purged', null, { recordings: n });
    return n;
  }

  stats(sinceMs: number): { count: number; bytes: number } {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM meeting_recordings WHERE status = 'ready' AND created_at >= ?`).get(sinceMs) as { n: number; b: number };
    return { count: r.n, bytes: r.b };
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    switch (op) {
      case 'rec.begin': return this.begin(me, d);
      case 'rec.chunk': return this.chunk(me, d);
      case 'rec.status': return this.status(me, d);
      case 'rec.finish': return this.finish(me, d);
      case 'rec.list': return this.list(me, d.limit);
      case 'rec.get': return this.get(me, d);
      case 'rec.share': return this.share(me, d);
      case 'rec.title': return this.rename(me, d);
      case 'rec.delete': return this.delete(me, d);
    }
    return undefined;
  }
}
