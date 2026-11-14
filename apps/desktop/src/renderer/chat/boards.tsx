// The list of a conversation's whiteboards (the board itself loads on demand from Whiteboard.tsx).
import { useCallback, useEffect, useState } from 'react';
import type { Board } from '@dex/core';
import { Icon, relativeTime, useToast } from '../ui.tsx';

export function BoardsList({ convId, onOpen }: { convId: string; onOpen: (b: Board) => void }) {
  const toast = useToast();
  const [list, setList] = useState<Board[] | null>(null);
  const load = useCallback(() => { void window.dex.request('board.list', { convId }).then(setList).catch(() => setList([])); }, [convId]);
  useEffect(() => {
    load();
    return window.dex.onHubEvent((name, data) => {
      if (name === 'board.updated' && (data as Board).convId === convId) load();
      if (name === 'board.removed') setList((l) => l?.filter((b) => b.id !== (data as { boardId: string }).boardId) ?? l);
    });
  }, [convId, load]);
  return (
    <div className="notes-list">
      <button className="btn" onClick={() => void window.dex.request('board.create', { convId, title: `Whiteboard ${new Date().toLocaleDateString([], { day: 'numeric', month: 'short' })}` }).then(onOpen).catch((e: Error) => toast(e.message, true))}>
        <Icon name="plus" size={15} />New whiteboard
      </button>
      {list?.length === 0 && <div className="empty"><Icon name="drawing" size={28} /><span>Sketch layouts and ideas together. Everyone here sees it live.</span></div>}
      {list?.map((b) => (
        <button key={b.id} className="note-row" onClick={() => onOpen(b)}>
          <b>{b.title}</b>
          <span className="note-meta">changed {relativeTime(b.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

