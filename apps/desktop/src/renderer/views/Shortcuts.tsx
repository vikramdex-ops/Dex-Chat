// The keyboard shortcuts sheet (Ctrl+/): the keys for the main actions can be changed here (kept on
// this PC, checked for clashes, reset one by one or all at once); "G then a letter" moves between
// lenses; the rest are listed for reference.
import { useEffect, useState } from 'react';
import { Dialog, Icon } from '../ui.tsx';
import {
  ACTIONS, G_KEYS, RESERVED, comboOf, isChosen, keyFor, keyParts, lensFallback, resetAllKeys, resetKey, setKey, usable, useKeys,
} from '../chat/keys.ts';
import type { KeyAction } from '../chat/keys.ts';

const FIXED: Array<{ title: string; keys: Array<[string[], string]> }> = [
  { title: 'Getting around', keys: [
    [['Alt', '↑'], 'Previous conversation in the Switchboard'],
    [['Alt', '↓'], 'Next conversation in the Switchboard'],
    [['Ctrl', 'Click'], 'Lay a conversation beside the open ones (up to three)'],
    [['Ctrl', 'Alt', 'D'], 'Show Dexterity Connect from any app'],
    [['Ctrl', '/'], 'This list'],
    [['Esc'], 'Close a dialog, menu or selection'],
  ] },
  { title: 'Writing', keys: [
    [['Enter'], 'Send'],
    [['Shift', 'Enter'], 'New line'],
    [['Ctrl', 'B'], 'Bold'],
    [['Ctrl', 'I'], 'Italic'],
    [['Ctrl', 'U'], 'Underline (++text++)'],
    [['Ctrl', '5'], 'Strikethrough'],
    [['Ctrl', 'K'], 'Add a link'],
    [['Ctrl', '.'], 'Emoji'],
    [['/'], 'Commands: /remind, /poll, /headsdown, /startday and more'],
    [['@'], 'Call out someone'],
    [['#'], 'A tag, or a Space by name'],
    [['Tab'], 'Accept a suggestion'],
  ] },
  { title: 'View', keys: [
    [['Ctrl', '='], 'Larger text'],
    [['Ctrl', '-'], 'Smaller text'],
    [['Ctrl', '0'], 'Default text size'],
  ] },
];

export function ShortcutsSheet({ onClose, lenses = [] }: { onClose: () => void; lenses?: Array<{ id: string; label: string }> }) {
  useKeys();
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [problem, setProblem] = useState<{ action: KeyAction; text: string } | null>(null);
  const rows: Array<{ id: KeyAction; label: string; fallback: string }> = [
    ...ACTIONS,
    ...lenses.map((l, i) => ({ id: `lens:${l.id}` as KeyAction, label: `${l.label} lens`, fallback: lensFallback(i) })),
  ];
  const current = (id: KeyAction) => keyFor(id, rows.find((r) => r.id === id)?.fallback);

  // while recording, the next key press becomes the shortcut (and nothing else acts on it)
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { setRecording(null); return; }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) { setKey(recording, ''); setRecording(null); setProblem(null); return; }
      const combo = comboOf(e);
      if (!combo) return;
      const bad = usable(combo);
      if (bad) { setProblem({ action: recording, text: bad }); return; }
      const reserved = RESERVED[combo];
      if (reserved) { setProblem({ action: recording, text: `${keyParts(combo).join('+')} already ${reserved}.` }); return; }
      const other = rows.find((r) => r.id !== recording && current(r.id) === combo);
      if (other) { setProblem({ action: recording, text: `${keyParts(combo).join('+')} is already ${other.label.charAt(0).toLowerCase()}${other.label.slice(1)}. Change that one first.` }); return; }
      setKey(recording, combo);
      setProblem(null);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const anyChosen = rows.some((r) => isChosen(r.id));
  const gKeys = G_KEYS.filter((g) => lenses.some((l) => l.id === g.lens));
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => { if (!recording) onClose(); }}>
      <div className="shortcuts">
        <section className="keys-own">
          <h4>Your keys <span className="faint">· this PC</span></h4>
          {rows.map((r) => {
            const combo = current(r.id);
            const rec = recording === r.id;
            return (
              <div key={r.id} className={`shortcut editable${rec ? ' recording' : ''}`}>
                <span>{r.label}</span>
                <span className="keys">
                  <button type="button" className="key-set" aria-label={`Change the keys for ${r.label}`} title="Change"
                    onClick={() => { setProblem(null); setRecording(rec ? null : r.id); }}>
                    {rec ? <span className="key-wait">Press the keys · Esc to cancel</span> : combo ? keyParts(combo).map((k, i) => <kbd key={i}>{k}</kbd>) : <span className="faint">None</span>}
                  </button>
                  {isChosen(r.id) && !rec && <button type="button" className="icon-btn key-reset" title="Back to the usual keys" aria-label={`Reset ${r.label}`} onClick={() => { resetKey(r.id); setProblem(null); }}><Icon name="rotate" size={13} /></button>}
                </span>
                {problem?.action === r.id && <span className="key-problem" role="alert">{problem.text}</span>}
              </div>
            );
          })}
          <div className="keys-foot">
            <span className="faint">Click keys to change them. Backspace leaves an action without keys.</span>
            <button type="button" className="btn ghost sm" disabled={!anyChosen} onClick={() => { resetAllKeys(); setProblem(null); setRecording(null); }}>Reset all</button>
          </div>
        </section>
        {gKeys.length > 0 && (
          <section>
            <h4>G then a letter <span className="faint">· outside text fields</span></h4>
            {gKeys.map((g) => (
              <div key={g.letter} className="shortcut">
                <span>{g.label}</span>
                <span className="keys"><kbd>G</kbd><span className="then">then</span><kbd>{g.letter}</kbd></span>
              </div>
            ))}
          </section>
        )}
        {FIXED.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            {g.keys.map(([keys, what]) => (
              <div key={what} className="shortcut">
                <span>{what}</span>
                <span className="keys">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
