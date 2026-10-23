// Settings → Labels: rename, recolor (palette + custom) and delete board labels.
// The built-in Sherlock label can be renamed and recolored but not deleted.
import { useEffect, useState } from 'react';
import type { Label } from '../lib/types';
import { useStore } from '../hooks/useStore';
import { SHERLOCK } from '../lib/labels';
import { labelCopy } from '../lib/copy';
import { ColorChoice } from './Labels';
import { isActionEnter, NO_AUTOFILL } from '../lib/keys';
import LabelSettings from './LabelSettings';
import FlowsSection from './FlowsSection';
import { isWorkflowLabel } from '../../shared/workflow.mjs';

export default function LabelsSection() {
  const { labels } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const selected = labels.find(l => l.id === editing);
  if (selected) return <section><button type="button" className="automation-text" onClick={() => setEditing(null)}>← Back to labels and flows</button><LabelSettings label={selected} onBack={() => setEditing(null)} /></section>;
  return (
    <><FlowsSection /><section className="settings-group settings-labels" aria-label={labelCopy.labels}>
      <div className="settings-row">
        <span>{labelCopy.labels}</span>
      </div>
      <ul className="labels-edit">
        {labels.map((l) => (
          <LabelRow key={l.id} label={l} onEdit={() => setEditing(l.id)} />
        ))}
      </ul>
    </section></>
  );
}

function LabelRow({ label, onEdit }: { label: Label; onEdit(): void }) {
  const { updateLabel, deleteLabel } = useStore();
  const [name, setName] = useState(label.name);
  const [colorOpen, setColorOpen] = useState(false);
  useEffect(() => setName(label.name), [label.name]);
  const save = () => {
    if (!name.trim()) setName(label.name);
    else updateLabel(label.id, { name });
  };
  const workflow = isWorkflowLabel(label.id);
  const builtIn = workflow || !!label.flowStage || label.id === SHERLOCK.id;
  return (
    <li className="labels-edit-row">
      <div className="labels-edit-main">
        <button
          type="button"
          className="swatch labels-edit-swatch"
          style={{ ['--label' as string]: label.color }}
          aria-label={labelCopy.color(label.name)}
          aria-expanded={colorOpen}
          disabled={workflow}
          onClick={() => setColorOpen((v) => !v)}
        />
        <input
          className="label-name-input"
          {...NO_AUTOFILL}
          value={name}
          readOnly={workflow}
          maxLength={40}
          aria-label={labelCopy.rename(label.name)}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (isActionEnter(e)) {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button type="button" className="automation-text" aria-label={`Edit ${label.name} behavior`} onClick={onEdit}>Edit</button>
        {builtIn ? (
          <span className="mono labels-edit-tag">{label.flowStage ? 'flow stage' : labelCopy.builtIn}</span>
        ) : (
          <button type="button" className="iconbtn labels-edit-del" aria-label={labelCopy.remove(label.name)} onClick={() => deleteLabel(label.id)}>
            ×
          </button>
        )}
      </div>
      {colorOpen && <ColorChoice value={label.color} name={label.name} onChange={(c) => updateLabel(label.id, { color: c })} />}
    </li>
  );
}
