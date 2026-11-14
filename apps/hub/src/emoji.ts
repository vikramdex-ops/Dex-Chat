// Custom emoji: small images an administrator adds with a short name. People use them in
// messages as :name: and as reactions. Their image files are readable by everyone.
import type { DatabaseSync } from 'node:sqlite';
import type { CustomEmoji, Ops, PublicUser, Sticker } from '@dex/core';
import { ulid } from '@dex/core';
import type { FileStore } from './files.ts';
import type { Store } from './store.ts';

export class EmojiError extends Error {}

export const EMOJI_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const MAX_EMOJI = 300;
const MAX_BYTES = 256 * 1024;
const TYPES = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg']);

export const EMOJI_SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_emoji (
  name TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_emoji_file ON custom_emoji(file_id);
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pack TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_file ON stickers(file_id);
`;
const MAX_STICKERS = 500;
const MAX_STICKER_BYTES = 512 * 1024;

export class Emoji {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly files: FileStore;
  private readonly changed: (list: CustomEmoji[]) => void;
  /** Whether everyone may add emoji and stickers (an office policy). */
  membersMay: () => boolean = () => true;
  stickersChanged: (list: Sticker[]) => void = () => {};

  constructor(store: Store, files: FileStore, changed: (list: CustomEmoji[]) => void) {
    this.store = store;
    this.db = store.db;
    this.files = files;
    this.changed = changed;
    this.db.exec(EMOJI_SCHEMA);
  }

  list(): CustomEmoji[] {
    return (this.db.prepare('SELECT * FROM custom_emoji ORDER BY name').all() as Array<{ name: string; file_id: string; created_by: string; created_at: number }>)
      .map((r) => ({ name: r.name, fileId: r.file_id, createdBy: r.created_by, createdAt: r.created_at }));
  }

  exists(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM custom_emoji WHERE name = ?').get(name);
  }

  isEmojiFile(fileId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM custom_emoji WHERE file_id = ? LIMIT 1').get(fileId)
      || !!this.db.prepare('SELECT 1 FROM stickers WHERE file_id = ? LIMIT 1').get(fileId);
  }

  stickers(): Sticker[] {
    return (this.db.prepare('SELECT * FROM stickers ORDER BY pack, created_at').all() as Array<{ id: string; name: string; pack: string; file_id: string; created_by: string; created_at: number }>)
      .map((r) => ({ id: r.id, name: r.name, pack: r.pack, fileId: r.file_id, createdBy: r.created_by, createdAt: r.created_at }));
  }

  private addEmoji(me: PublicUser, d: Record<string, unknown>): CustomEmoji {
    const name = typeof d.name === 'string' ? d.name.trim().toLowerCase().replace(/^:|:$/g, '') : '';
    if (!EMOJI_NAME.test(name)) throw new EmojiError('Use 2 to 32 lowercase letters, numbers, - or _ for the name.');
    if (this.exists(name)) throw new EmojiError(`:${name}: already exists.`);
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM custom_emoji').get() as { n: number }).n >= MAX_EMOJI) throw new EmojiError(`The office can have up to ${MAX_EMOJI} custom emoji.`);
    const f = typeof d.fileId === 'string' ? this.files.info(d.fileId) : null;
    if (!f || f.uploaderId !== me.id) throw new EmojiError('Upload the image first.');
    if (!TYPES.has(f.mime)) throw new EmojiError('Use a PNG, GIF, WebP or JPEG image.');
    if (f.size > MAX_BYTES) throw new EmojiError('Emoji images can be up to 256 KB.');
    this.db.prepare('INSERT INTO custom_emoji (name, file_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(name, f.id, me.id, Date.now());
    this.store.audit(me.id, 'emoji.add', null, { name });
    const list = this.list();
    this.changed(list);
    return list.find((e) => e.name === name)!;
  }

  private stickerOp(op: string, me: PublicUser, d: Record<string, unknown>, admin: boolean): unknown {
    switch (op) {
      case 'sticker.list': return this.stickers() satisfies Ops['sticker.list']['res'];
      case 'sticker.add': {
        if (!admin && !this.membersMay()) throw new EmojiError('Only administrators add stickers in this office.');
        const name = typeof d.name === 'string' ? d.name.trim().slice(0, 40) : '';
        if (!name) throw new EmojiError('Give the sticker a name.');
        const pack = (typeof d.pack === 'string' && d.pack.trim() ? d.pack.trim() : 'Office').slice(0, 40);
        if ((this.db.prepare('SELECT COUNT(*) AS n FROM stickers').get() as { n: number }).n >= MAX_STICKERS) throw new EmojiError(`The office can have up to ${MAX_STICKERS} stickers.`);
        const f = typeof d.fileId === 'string' ? this.files.info(d.fileId) : null;
        if (!f || f.uploaderId !== me.id) throw new EmojiError('Upload the image first.');
        if (!TYPES.has(f.mime) || f.mime === 'image/jpeg') throw new EmojiError('Use a PNG, GIF or WebP image (with a transparent background).');
        if (f.size > MAX_STICKER_BYTES) throw new EmojiError('Stickers can be up to 512 KB.');
        const id = ulid();
        this.db.prepare('INSERT INTO stickers (id, name, pack, file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, pack, f.id, me.id, Date.now());
        this.store.audit(me.id, 'sticker.add', id, { name, pack });
        const list = this.stickers();
        this.stickersChanged(list);
        return list.find((x) => x.id === id)! satisfies Ops['sticker.add']['res'];
      }
      case 'sticker.remove': {
        const row = this.db.prepare('SELECT created_by FROM stickers WHERE id = ?').get(String(d.id ?? '')) as { created_by: string } | undefined;
        if (!row) throw new EmojiError('That sticker does not exist.');
        if (!admin && row.created_by !== me.id) throw new EmojiError('You can remove the stickers you added.');
        this.db.prepare('DELETE FROM stickers WHERE id = ?').run(String(d.id));
        this.store.audit(me.id, 'sticker.remove', String(d.id), {});
        this.stickersChanged(this.stickers());
        return { ok: true } satisfies Ops['sticker.remove']['res'];
      }
      default: return undefined;
    }
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (op === 'emoji.list') return this.list() satisfies Ops['emoji.list']['res'];
    const admin = me.role === 'owner' || me.role === 'admin';
    if (op.startsWith('sticker.')) {
      if (me.role === 'bot' || (me.role === 'guest' && op !== 'sticker.list')) throw new EmojiError('Only members of the office can do that.');
      return this.stickerOp(op, me, d, admin);
    }
    if (op === 'emoji.add') {
      if (me.role === 'guest' || me.role === 'bot') throw new EmojiError('Only members of the office can add emoji.');
      if (!admin && !this.membersMay()) throw new EmojiError('Only administrators add emoji in this office.');
      return this.addEmoji(me, d) satisfies Ops['emoji.add']['res'];
    }
    if (op === 'emoji.remove') {
      const row = this.db.prepare('SELECT created_by FROM custom_emoji WHERE name = ?').get(String(d.name ?? '')) as { created_by: string } | undefined;
      if (!row) throw new EmojiError('That emoji does not exist.');
      if (!admin && row.created_by !== me.id) throw new EmojiError('You can remove the emoji you added.');
      this.db.prepare('DELETE FROM custom_emoji WHERE name = ?').run(String(d.name));
      this.store.audit(me.id, 'emoji.remove', null, { name: d.name });
      this.changed(this.list());
      return { ok: true } satisfies Ops['emoji.remove']['res'];
    }
    if (!admin) throw new EmojiError('Only administrators can do that.');
    switch (op) {
      case 'admin.emoji.add':
        return this.addEmoji(me, d) satisfies Ops['admin.emoji.add']['res'];
      case 'admin.emoji.remove': {
        const name = typeof d.name === 'string' ? d.name : '';
        if (!this.exists(name)) throw new EmojiError('That emoji does not exist.');
        this.db.prepare('DELETE FROM custom_emoji WHERE name = ?').run(name);
        this.store.audit(me.id, 'emoji.remove', null, { name });
        this.changed(this.list());
        return { ok: true } satisfies Ops['admin.emoji.remove']['res'];
      }
      default:
        return undefined;
    }
  }
}
