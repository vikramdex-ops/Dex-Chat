/** @jsxImportSource react */
// Markdown attachments (README.md, notes) shown formatted, without leaving the conversation.
import { useEffect, useState } from 'react';
import type { FileInfo, PublicUser } from '@dex/core';
import { Dialog } from '../ui.tsx';
import { renderBody } from './format.tsx';
import { fileSrc } from './files.tsx';

export function MdPreview({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const [f, setF] = useState<FileInfo | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => { setF((e as CustomEvent).detail as FileInfo); setText(null); setErr(null); };
    window.addEventListener('dex-mdpreview', on);
    return () => window.removeEventListener('dex-mdpreview', on);
  }, []);
  useEffect(() => {
    if (!f) return;
    void (async () => {
      try {
        const url = window.dex.fileUrl ? await window.dex.fileUrl(f.id, f.name) : fileSrc(f.id);
        setText((await (await fetch(url)).text()).slice(0, 200_000));
      } catch { setErr('This file could not be opened.'); }
    })();
  }, [f]);
  if (!f) return null;
  return (
    <Dialog title={f.name} onClose={() => setF(null)}>
      <div className="md-preview msg-body">{err ?? (text === null ? <span className="spinner" /> : renderBody(text, users, meId))}</div>
    </Dialog>
  );
}
