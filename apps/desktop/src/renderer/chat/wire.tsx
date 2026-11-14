// What a message offers beyond writing: pins that end, filing kept messages by kind, starting a
// Space from a message, taking it to a group Direct with the people named, stickers, office emoji
// and stickers added by anyone the office allows, and the actions integrations add to messages.
import { useEffect, useRef, useState } from 'react';
import { KEEP_KINDS } from '@dex/core';
import type { BotAction, Conversation, KeepKind, Message, PublicUser, Sticker } from '@dex/core';
import { Dialog, Icon, ToggleRow, useToast } from '../ui.tsx';
import { KEEP_LABEL, setKeepKind, toggleSaved, useDesk } from '../desk/store.ts';
import { StickerImg, useStickers } from '../emoji.tsx';
import { usePolicy } from '../policy.ts';
import { timeOpts } from '../time.ts';
import { addConversation, chatState, meUser, setDraft, tlKey } from './store.ts';
import { plainPreview } from './format.tsx';

// ------------------------------------------------------------------ pins that end
const DAY = 86_400_000;
export const PIN_FOR: Array<{ id: string; label: string; until: () => number | null }> = [
  { id: 'day', label: 'For a day', until: () => Date.now() + DAY },
  { id: 'week', label: 'For a week', until: () => Date.now() + 7 * DAY },
  { id: 'month', label: 'For a month', until: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.getTime(); } },
  { id: 'ever', label: 'Until unpinned', until: () => null },
];

/** "Till 21 Nov" (with the time when it ends within two days). */
export function pinEnd(until: number): string {
  const d = new Date(until);
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return until - Date.now() < 2 * DAY ? `Till ${date}, ${d.toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' })}` : `Till ${date}`;
}

/** The small mono flags under a message: a pin that ends, and what it is kept as on your Desk. */
export function MsgFlags({ m }: { m: Message }) {
  const kind = useDesk((s) => s.saved.get(m.id)?.kind);
  const ends = m.pinned && m.pinnedUntil ? m.pinnedUntil : null;
  const filed = kind && kind !== 'keep' ? kind : null;
  if (!ends && !filed) return null;
  return (
    <div className="msg-flags">
      {ends && <span className="flag pin" title={`Pinned for everyone until ${new Date(ends).toLocaleString()}`}><Icon name="pin" size={10} />Pinned · {pinEnd(ends)}</span>}
      {filed && <span className={`flag keep k-${filed}`} title="On your Desk (only you see this)">{KEEP_LABEL[filed]}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ kept messages, by kind
/** The Keep flyout: what to file it as, and taking it off the Desk. */
export function KeepMenu({ m, onClose }: { m: Message; onClose: () => void }) {
  const toast = useToast();
  const cur = useDesk((s) => s.saved.get(m.id));
  const kind: KeepKind = cur?.kind ?? 'keep';
  const file = (k: KeepKind) => { onClose(); void setKeepKind(m, k).then(() => toast(`On your Desk · ${KEEP_LABEL[k]}`)).catch((e: Error) => toast(e.message, true)); };
  return (
    <>
      <div className="menu-label label">File on my Desk as</div>
      {KEEP_KINDS.map((k) => (
        <button key={k} role="menuitemradio" aria-checked={!!cur && kind === k} onClick={() => file(k)}>
          <span className={`keep-swatch k-${k}`} aria-hidden="true" />{KEEP_LABEL[k]}{cur && kind === k && <Icon name="check" size={14} className="menu-check" />}
        </button>
      ))}
      {cur && <>
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => { onClose(); void toggleSaved(m).then(() => toast('Taken off your Desk')).catch((e: Error) => toast(e.message, true)); }}><Icon name="drawer" size={16} />Take off my Desk</button>
      </>}
    </>
  );
}

// ------------------------------------------------------------------ open a conversation with a quote in its Dock
/** Open a conversation and put text at the start of its Dock (the Dock takes it if it is on screen, otherwise its draft does). */
export function openWithQuote(convId: string, text: string): void {
  window.dispatchEvent(new CustomEvent('dex-open', { detail: convId }));
  const detail = { key: tlKey(convId), text, taken: false };
  window.dispatchEvent(new CustomEvent('dex-quote', { detail }));
  if (!detail.taken) setDraft(tlKey(convId), `${text}${chatState().drafts.get(tlKey(convId)) ?? ''}`);
}

/** The people a message names, with its author: who a group Direct about it is with (never you). */
export function namedPeople(m: Message, meId: string, users: Map<string, PublicUser>): string[] {
  const named = m.mentions.filter((id) => id !== 'all');
  if (!named.length) return [];
  return [...new Set([m.authorId, ...named])].filter((id) => id !== meId && !!users.get(id) && users.get(id)!.role !== 'bot');
}

// ------------------------------------------------------------------ start a Space from a message
export function StartSpaceDialog({ m, users, onClose }: { m: Message; users: Map<string, PublicUser>; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const author = users.get(m.authorId)?.displayName ?? 'its author';
  const lead = plainPreview(m.body, users);
  const go = async () => {
    setBusy(true);
    try {
      const c = await window.dex.request('conv.fork', { messageId: m.id, name: name.trim(), private: priv });
      addConversation(c);
      window.dispatchEvent(new CustomEvent('dex-open', { detail: c.id }));
      toast(`Space started: ${c.name ?? name.trim()}`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="Start a Space from this" onClose={onClose} narrow>
      <blockquote className="fork-quote" translate="no">{lead.length > 180 ? `${lead.slice(0, 177)}…` : lead || '📎'}</blockquote>
      <form className="fork-form" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void go(); }}>
        <div className="field"><label htmlFor="fork-name">Name the Space</label>
          <input id="fork-name" className="input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. P-12 valve tags" /></div>
        <ToggleRow checked={priv} onChange={setPriv} label="Private: only the people added can find it" />
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>The message and its side-track are copied in, credited to who wrote them. {author === 'its author' ? 'Its author' : author} and everyone who replied join it with you.</p>
        <div className="dialog-actions">
          <span />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || busy}><Icon name="grid" size={15} />Start the Space</button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ office emoji and stickers from anyone
/** May I add office emoji and stickers here (administrators always; others when the office allows it)? */
export function useCanAddArt(): boolean {
  const policy = usePolicy();
  const me = meUser();
  if (!window.dex.uploadFile || !me || me.role === 'guest' || me.role === 'bot') return false;
  return me.role === 'owner' || me.role === 'admin' || !!policy.memberEmoji;
}

/** Upload an image picked for an emoji or a sticker, then add it. */
export function AddArtForm({ kind, pack, onDone }: { kind: 'emoji' | 'sticker'; pack?: string; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [packName, setPackName] = useState(pack ?? 'Office');
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const preview = useRef<string | null>(null);
  useEffect(() => () => { if (preview.current) URL.revokeObjectURL(preview.current); }, []);
  const emojiName = name.trim().toLowerCase().replace(/^:|:$/g, '');
  const okName = kind === 'emoji' ? /^[a-z0-9][a-z0-9_-]{1,31}$/.test(emojiName) : !!name.trim();
  const choose = (f: File | undefined) => {
    if (!f) return;
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = URL.createObjectURL(f);
    setFile(f);
    if (!name) setName(kind === 'emoji' ? f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) : f.name.replace(/\.[^.]+$/, '').slice(0, 40));
  };
  const add = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const info = await window.dex.uploadFile!(`${kind}-${Date.now().toString(36)}`, { data: await file.arrayBuffer(), name: file.name, mime: file.type || undefined });
      if (kind === 'emoji') await window.dex.request('emoji.add', { name: emojiName, fileId: info.id });
      else await window.dex.request('sticker.add', { name: name.trim(), pack: packName.trim() || 'Office', fileId: info.id });
      toast(kind === 'emoji' ? `:${emojiName}: is ready for everyone` : `${name.trim()} is in ${packName.trim() || 'Office'}`);
      onDone();
    } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); setBusy(false); }
  };
  return (
    <form className="art-form" onSubmit={(e) => { e.preventDefault(); if (okName && file && !busy) void add(); }}>
      <div className="label">{kind === 'emoji' ? 'Add an office emoji' : 'Add a sticker'}</div>
      <div className="art-row">
        <button type="button" className={`art-pick${file ? ' has' : ''}`} onClick={() => pick.current?.click()} aria-label="Choose an image">
          {file && preview.current ? <img src={preview.current} alt="" /> : <Icon name="plus" size={16} />}
        </button>
        <input ref={pick} type="file" hidden accept={kind === 'emoji' ? 'image/png,image/gif,image/webp,image/jpeg' : 'image/png,image/gif,image/webp'} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
        <input className="input mono" value={name} maxLength={kind === 'emoji' ? 34 : 40} onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'emoji' ? 'name, e.g. pipe-ok' : 'Name'} aria-label={kind === 'emoji' ? 'Emoji name' : 'Sticker name'} />
        {kind === 'sticker' && <input className="input" value={packName} maxLength={40} onChange={(e) => setPackName(e.target.value)} placeholder="Pack" aria-label="Pack" />}
      </div>
      <div className="art-foot">
        <span className="faint">{kind === 'emoji' ? (emojiName && !okName ? '2 to 32 letters, numbers, - or _' : `Used as :${emojiName || 'name'}: · up to 256 KB`) : 'PNG, GIF or WebP with a clear background · up to 512 KB'}</span>
        <button type="button" className="btn ghost sm" onClick={onDone}>Cancel</button>
        <button className="btn primary sm" disabled={!okName || !file || busy}>{busy ? <span className="spinner" /> : null}Add</button>
      </div>
    </form>
  );
}

/** Insert → Stickers: the office's packs as sheet tabs along the bottom. */
export function StickerSheet({ onPick, onClose }: { onPick: (s: Sticker) => void; onClose: () => void }) {
  const all = useStickers();
  const packs = [...new Set(all.map((s) => s.pack))];
  const [pack, setPack] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const can = useCanAddArt();
  const cur = pack && packs.includes(pack) ? pack : packs[0] ?? null;
  const shown = all.filter((s) => s.pack === cur);
  return (
    <div className="sticker-sheet" role="dialog" aria-label="Stickers" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      {adding ? <AddArtForm kind="sticker" pack={cur ?? 'Office'} onDone={() => setAdding(false)} /> : (
        <div className="sticker-grid">
          {shown.map((s) => (
            <button key={s.id} type="button" title={s.name} aria-label={`Send the sticker ${s.name}`} onClick={() => onPick(s)}><StickerImg id={s.id} size={64} /></button>
          ))}
          {!shown.length && <p className="faint sticker-empty">{can ? 'No stickers yet. Add the first one from the tab below.' : 'No stickers yet. An administrator can add them in the Control room.'}</p>}
        </div>
      )}
      <div className="sheet-tabs" role="tablist" aria-label="Sticker packs">
        {packs.map((p) => <button key={p} type="button" role="tab" aria-selected={p === cur && !adding} onClick={() => { setPack(p); setAdding(false); }} translate="no">{p}</button>)}
        {can && <button type="button" className="add" aria-pressed={adding} onClick={() => setAdding(!adding)}><Icon name="plus" size={12} />Add a sticker</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ integrations' message actions
let actions: Promise<BotAction[]> | null = null;
let actionsAt = 0;
/** The actions integrations add to messages (fetched when a menu opens, kept for a minute). */
function loadActions(): Promise<BotAction[]> {
  if (!actions || Date.now() - actionsAt > 60_000) {
    actionsAt = Date.now();
    actions = window.dex.request('actions.list').catch(() => { actions = null; return []; });
  }
  return actions;
}
/** Actions that fit this conversation, loaded while `on` (the menu is open). */
export function useActions(conv: Conversation, on: boolean): BotAction[] {
  const [list, setList] = useState<BotAction[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadActions().then((l) => { if (live) setList(l.filter((a) => a.scope === 'everywhere' || (a.scope === 'spaces') === (conv.kind === 'space'))); });
    return () => { live = false; };
  }, [on, conv.kind]);
  return list;
}

/** Run an action on a message; a reply only for you shows as a note, other replies go in the side-track. */
export async function runAction(a: BotAction, m: Message, conv: Conversation, toast: (t: string, bad?: boolean) => void): Promise<void> {
  try {
    // an encrypted Direct message: the hub cannot read it, so the app sends the text it shows
    const r = await window.dex.request('action.run', { actionId: a.id, messageId: m.id, ...(conv.kind === 'direct' && m.e2e ? { text: m.body } : {}) });
    if (r.text && r.ephemeral) toast(`${a.botName}: ${r.text}`);
    else toast(r.text ? `${a.botName} answered in the side-track` : `Sent to ${a.botName}`);
  } catch (e) { toast((e as Error).message, true); }
}
