// A brief preview of a meeting chat line while the Chat tab is closed: who and the first words,
// at the foot of the Room for a few seconds; clicking it opens the chat. Unobtrusive: no sound,
// no focus taken, announced politely, and still (no slide) when motion is reduced.
import { useEffect } from 'react';
import { capName } from '../rooms/engine.ts';
import { clearPeek, useLive } from './live.ts';

const SHOW_MS = 5000;

export function ChatPeek({ onOpen }: { onOpen: () => void }) {
  const peek = useLive((s) => s.peek);
  useEffect(() => {
    if (!peek) return;
    const t = setTimeout(clearPeek, SHOW_MS);
    return () => clearTimeout(t);
  }, [peek]);
  if (!peek) return null;
  const text = peek.text || peek.file?.name || '';
  return (
    <button className="room-chat-peek" onClick={() => { clearPeek(); onOpen(); }} title="Open the meeting chat">
      <span className="mono room-chat-peek-who"><span translate="no">{capName(peek.name)}</span>{peek.guest ? ' · GUEST' : ''}</span>
      <span className="room-chat-peek-text" translate="no">{text.length > 120 ? `${text.slice(0, 117)}…` : text}</span>
      <span className="knock-sr" role="status">{`New in the meeting chat from ${peek.name}`}</span>
    </button>
  );
}
