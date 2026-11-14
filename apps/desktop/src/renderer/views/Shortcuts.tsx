// The keyboard shortcuts sheet (Ctrl+/).
import { Dialog } from '../ui.tsx';

const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  { title: 'Getting around', keys: [
    [['Ctrl', 'K'], 'Find people, conversations and commands'],
    [['Ctrl', 'Shift', 'F'], 'Search messages and files, with filters'],
    [['Ctrl', '1…6'], 'Pulse, Direct, Spaces, Desk, Calendar, Directory'],
    [['Alt', '↑'], 'Previous conversation in the list'],
    [['Alt', '↓'], 'Next conversation in the list'],
    [['Ctrl', ','], 'Preferences'],
    [['Ctrl', 'Alt', 'D'], 'Show Dexterity Connect from any app'],
    [['Ctrl', '/'], 'This list'],
    [['Esc'], 'Close a dialog, menu or selection'],
  ] },
  { title: 'Writing', keys: [
    [['Enter'], 'Send'],
    [['Shift', 'Enter'], 'New line'],
    [['↑'], 'Edit your last message (when the box is empty)'],
    [['Ctrl', 'B'], 'Bold'],
    [['Ctrl', 'I'], 'Italic'],
    [['Ctrl', 'U'], 'Underline'],
    [['Ctrl', 'Shift', 'X'], 'Strikethrough'],
    [['Ctrl', 'L'], 'Add a link'],
    [['Ctrl', 'E'], 'Emoji'],
    [['Ctrl', 'Shift', 'S'], 'Schedule the message'],
    [['/'], 'Commands: /remind, /poll, /away and more'],
    [['@'], 'Mention someone'],
    [['Tab'], 'Accept a suggestion'],
  ] },
  { title: 'View', keys: [
    [['Ctrl', '='], 'Larger text'],
    [['Ctrl', '-'], 'Smaller text'],
    [['Ctrl', '0'], 'Default text size'],
    [['Ctrl', 'Shift', 'M'], 'Notification sounds off or on'],
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
