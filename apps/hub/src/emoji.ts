// Custom emoji: small images an administrator adds with a short name. People use them in
// messages as :name: and as reactions. Their image files are readable by everyone.
import type { DatabaseSync } from 'node:sqlite';
import type { CustomEmoji, Ops, PublicUser } from '@dex/core';
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
`;

export class Emoji {
  private readonly db: DatabaseSync;
  private readonly store: Store;
  private readonly files: FileStore;
  private readonly changed: (list: CustomEmoji[]) => void;

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
    return !!this.db.prepare('SELECT 1 FROM custom_emoji WHERE file_id = ? LIMIT 1').get(fileId);
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (op === 'emoji.list') return this.list() satisfies Ops['emoji.list']['res'];
    if (me.role !== 'owner' && me.role !== 'admin') throw new EmojiError('Only administrators can do that.');
    switch (op) {
      case 'admin.emoji.add': {
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
        return list.find((e) => e.name === name)! satisfies Ops['admin.emoji.add']['res'];
      }
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
