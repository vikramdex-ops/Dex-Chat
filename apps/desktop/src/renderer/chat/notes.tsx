// Notes: shared in a conversation (side panel) or personal (on the Desk). The editor saves as
// you type, never overwrites a colleague's newer save, and on Windows can hand the note to
// Slate (the office text editor); whatever is saved there comes back into the note.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NoteSummary, PublicUser } from '@dex/core';
import { Icon, confirmAction, relativeTime, useToast } from '../ui.tsx';
import { renderBody } from './format.tsx';

export function useNotes(convId: string | null): NoteSummary[] | null {
  const [list, setList] = useState<NoteSummary[] | null>(null);
  const load = useCallback(() => { void window.dex.request('note.list', { convId }).then(setList).catch(() => setList((x) => x ?? [])); }, [convId]);
  useEffect(() => {
    load();
    return window.dex.onHubEvent((name, data) => {
      if (name === 'note.removed') setList((l) => l?.filter((n) => n.id !== (data as { id: string }).id) ?? l);
      if (name === 'note.updated' && ((data as Note).convId ?? null) === convId) {
        const n = data as Note;
        setList((l) => [n, ...(l ?? []).filter((x) => x.id !== n.id)]);
      }
    });
  }, [convId, load]);
  return list;
}

export function NotesList({ convId, users, onOpen, onNew }: { convId: string | null; users: Map<string, PublicUser>; onOpen: (id: string) => void; onNew: () => void }) {
  const list = useNotes(convId);
  return (
    <div className="notes-list">
      <button className="btn" onClick={onNew}><Icon name="plus" size={15} />New note</button>
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <div className="empty"><Icon name="doc" size={28} /><span>{convId ? 'Shared notes for everyone here: checklists, minutes, decisions.' : 'Personal notes only you can see.'}</span></div>}
      {list?.map((n) => (
        <button key={n.id} className="note-row" onClick={() => onOpen(n.id)}>
          <b translate="no">{n.title}</b>
          <span className="faint">{n.preview || 'Empty'}</span>
          <span className="note-meta">{users.get(n.updatedBy)?.displayName.split(' ')[0] ?? 'Someone'} · {relativeTime(n.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

type SaveState = 'saved' | 'saving' | 'dirty' | 'conflict' | 'error';

export function NoteEditor({ id, convId, users, meId, onClose }: { id: string | null; convId: string | null; users: Map<string, PublicUser>; meId: string; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState<SaveState>('saved');
  const [preview, setPreview] = useState(false);
  const [theirs, setTheirs] = useState<Note | null>(null);
  const version = useRef(0);
  const noteId = useRef<string | null>(id);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title: '', body: '' });
  latest.current = { title, body };

  // load once per note: the Pane around it re-renders often, and must not reset what is being written
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!id) { setNote(null); setTitle(''); setBody(''); return; }
    void window.dex.request('note.get', { id }).then((n) => { setNote(n); setTitle(n.title); setBody(n.body); version.current = n.version; }).catch((e: Error) => { toast(e.message, true); closeRef.current(); });
  }, [id, toast]);

  const save = useCallback(async (force = false) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const { title: t, body: b } = latest.current;
    if (!noteId.current && !t.trim() && !b.trim()) return;
    setState('saving');
    try {
      const n = await window.dex.request('note.save', { id: noteId.current ?? undefined, convId: noteId.current ? undefined : convId, title: t || 'Untitled note', body: b, baseVersion: force || !noteId.current ? undefined : version.current });
      noteId.current = n.id;
      version.current = n.version;
      setNote(n);
      if (latest.current.title === t && latest.current.body === b) setState('saved'); else setState('dirty');
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('CONFLICT')) {
        setState('conflict');
        if (noteId.current) void window.dex.request('note.get', { id: noteId.current }).then(setTheirs);
      } else { setState('error'); toast(msg, true); }
    }
  }, [convId, toast]);

  const change = (t: string, b: string) => {
    setTitle(t); setBody(b);
    if (state === 'conflict') return;
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 900);
  };

  // a colleague saved: take their text if we have nothing unsaved
  useEffect(() => window.dex.onHubEvent((name, data) => {
    if (name !== 'note.updated') return;
    const n = data as Note;
    if (n.id !== noteId.current || n.version <= version.current) return;
    if (state === 'saved') { setNote(n); setTitle(n.title); setBody(n.body); version.current = n.version; }
    else { setTheirs(n); setState('conflict'); }
  }), [state]);

  // edits made in Slate come back here
  useEffect(() => window.dex.onSlateChange?.((nid, text) => {
    if (nid !== noteId.current) return;
    setBody(text);
    latest.current = { title: latest.current.title, body: text };
    void save();
  }), [save]);

  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void save(); } }, [save]);

  const close = () => { if (state === 'dirty') void save(); onClose(); };
  const editor = note ?? (id ? null : { updatedBy: meId, updatedAt: Date.now() } as Partial<Note>);
  if (id && !note) return <div className="note-editor"><div className="tl-more"><span className="spinner" /></div></div>;
  return (
    <div className="note-editor">
      <div className="note-bar">
        <button className="icon-btn" onClick={close} aria-label="Back to notes"><Icon name="back" size={16} /></button>
        <input className="note-title" value={title} placeholder="Title" maxLength={120} onChange={(e) => change(e.target.value, body)} />
        <span className={`note-state ${state}`}>{state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Editing' : state === 'conflict' ? 'Changed by someone else' : 'Not saved'}</span>
      </div>
      {state === 'conflict' && theirs && (
        <div className="note-conflict">
          <Icon name="warning" size={15} />
          <span>{users.get(theirs.updatedBy)?.displayName ?? 'Someone'} saved this note while you were editing.</span>
          <button className="btn sm" onClick={() => { setTitle(theirs.title); setBody(theirs.body); version.current = theirs.version; setNote(theirs); setTheirs(null); setState('saved'); }}>Use theirs</button>
          <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(body); toast('Your text is copied; paste it back in as needed'); setTitle(theirs.title); setBody(theirs.body); version.current = theirs.version; setNote(theirs); setTheirs(null); setState('saved'); }}>Use theirs, copy mine</button>
          <button className="btn sm danger" onClick={() => { setTheirs(null); void save(true); }}>Keep mine</button>
        </div>
      )}
      <div className="note-tools">
        <div className="seg" role="group" aria-label="Mode">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Read</button>
        </div>
        <span style={{ flex: 1 }} />
        {window.dex.editInSlate && (
          <button className="btn ghost sm" title={window.dex.hasSlate ? 'Edit in Slate; saving there updates this note' : 'Edit in your text editor; saving there updates this note'} onClick={() => {
            void (async () => {
              if (!noteId.current) await save();
              if (!noteId.current) return;
              try { const where = await window.dex.editInSlate!(noteId.current, latest.current.title || 'Note', latest.current.body); toast(where === 'slate' ? 'Opened in Slate. Save there to update the note.' : 'Opened in your editor. Save there to update the note.'); } catch (e) { toast((e as Error).message, true); }
            })();
          }}><Icon name="open" size={14} />{window.dex.hasSlate ? 'Edit in Slate' : 'Edit in your editor'}</button>
        )}
        {editor?.updatedAt && <span className="faint" style={{ fontSize: 12 }}>{users.get(editor.updatedBy ?? '')?.displayName ?? ''} · {relativeTime(editor.updatedAt)}</span>}
      </div>
      {preview
        ? <div className="note-preview selectable">{body.trim() ? renderBody(body, users, meId) : <span className="faint">Nothing written yet.</span>}</div>
        : <textarea className="note-body" value={body} placeholder={'Write here. **bold**, *italic*, - lists, `code`, > quotes'} onChange={(e) => change(title, e.target.value)} autoFocus={!id} />}
      {note && (note.ownerId === meId || !note.convId) && (
        <button className="link danger note-delete" onClick={() => void confirmAction({ title: `Delete "${note.title}"?`, confirm: 'Delete', danger: true }).then((ok) => { if (ok) void window.dex.request('note.delete', { id: note.id }).then(onClose).catch((e: Error) => toast(e.message, true)); })}>Delete note</button>
      )}
    </div>
  );
}
