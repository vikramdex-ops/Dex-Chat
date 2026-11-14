// The keyboard shortcuts sheet (Ctrl+/).
import { Dialog } from '../ui.tsx';

const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  { title: 'Getting around', keys: [
    [['Ctrl', 'G'], 'Go to a person, conversation or command'],
    [['Ctrl', 'Shift', 'F'], 'Search messages and files, with filters'],
    [['Ctrl', '1…6'], 'Pulse, Direct, Spaces, Desk, Calendar, Directory'],
    [['Alt', '↑'], 'Previous conversation in the Switchboard'],
    [['Alt', '↓'], 'Next conversation in the Switchboard'],
    [['Ctrl', 'Click'], 'Lay a conversation beside the open ones (up to three)'],
    [['Ctrl', ','], 'Preferences'],
    [['Ctrl', 'Alt', 'D'], 'Show Dexterity Connect from any app'],
    [['Ctrl', '/'], 'This list'],
    [['Esc'], 'Close a dialog, menu or selection'],
  ] },
  { title: 'Writing', keys: [
    [['Enter'], 'Send'],
    [['Shift', 'Enter'], 'New line'],
    [['Ctrl', 'Shift', 'Enter'], 'Send later'],
    [['Ctrl', '↑'], 'Edit your last message'],
    [['Ctrl', 'B'], 'Bold'],
    [['Ctrl', 'I'], 'Italic'],
    [['Ctrl', 'U'], 'Underline (++text++)'],
    [['Ctrl', '5'], 'Strikethrough'],
    [['Ctrl', 'K'], 'Add a link'],
    [['Ctrl', '.'], 'Emoji'],
    [['/'], 'Commands: /remind, /poll, /headsdown, /startday and more'],
    [['@'], 'Call out someone'],
    [['Tab'], 'Accept a suggestion'],
  ] },
  { title: 'View', keys: [
    [['Ctrl', '='], 'Larger text'],
    [['Ctrl', '-'], 'Smaller text'],
    [['Ctrl', '0'], 'Default text size'],
    [['Ctrl', 'Shift', 'Q'], 'Sounds quiet, or back on'],
  ] },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts">
        {GROUPS.map((g) => (
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
