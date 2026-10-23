// §7.12 — the "?" shortcut sheet. Esc closes wherever focus is (D7).
import { useRef } from 'react';
import { useDialog } from './SettingsPanel';
const ROWS: [string, string][] = [
  ['↑ ↓ ← →', 'Select cards'],
  ['Enter', 'Open the selected card'],
  ['Space', 'Toggle its circle'],
  ['1 · 2 · 3', 'To do · Doing · Done'],
  ['S / R', 'Make it a note / Repeat'],
  ['⌘1 / ⌘2', 'Board / Notes'],
  ['⌘⇧E', 'Expand the open card'],
  ['⌘↑ ⌘↓', 'Reorder'],
  ['⌘⌫', 'Delete'],
  ['N', 'Create a note in the editor'],
  ['/ or ⌘K', 'Search'],
  ['⌘Enter', 'Toggle done (detail)'],
  ['Esc', 'Clear selection · close'],
  ['⌘Z', 'Undo'],
];

export default function ShortcutSheet({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div className="shortcut-backdrop" onClick={onClose}>
      <div ref={ref} className="shortcut-sheet" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-head">
          <span>Shortcuts</span>
          <button className="mono shortcut-esc" onClick={onClose}>esc</button>
        </div>
        <dl className="shortcut-list">
          {ROWS.map(([k, v]) => (
            <div key={k} className="shortcut-row">
              <dt className="mono">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
