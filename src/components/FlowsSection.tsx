import { useLayoutEffect, useRef, useState } from 'react';
import { flowGroup, isFlowStage, stagesOf, finishedStage } from '../../shared/workflow.mjs';
import { useStore } from '../hooks/useStore';
import type { Label } from '../lib/types';

type Stage = { id?: string; name: string; finished: boolean };
export default function FlowsSection() {
  const { labels, readOnly, setLabelFilter, showToast } = useStore();
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const [reveal, setReveal] = useState(0);
  useLayoutEffect(() => {
    const body = root.current?.closest('.dialog-body');
    if (reveal && body && root.current) body.scrollTop += Math.round(root.current.getBoundingClientRect().top - body.getBoundingClientRect().top);
  }, [reveal]);
  const groups = [...new Set(labels.filter(isFlowStage).map(flowGroup))];
  return <section ref={root} className="settings-group flows-section" aria-label="Flows">
    <div className="settings-row"><span>Flows</span>{!readOnly && editing === undefined && <button type="button" onClick={() => setEditing(null)}>Create flow</button>}</div>
    <p className="automation-hint">A flow is a set of stage labels. Each note has one stage at a time; other labels stay. On a note, choose + Label, then a stage. The ring finishes or reopens it.</p>
    {editing !== undefined ? <FlowEditor key={editing ?? 'new'} group={editing} labels={labels} onClose={() => { setEditing(undefined); setReveal(n => n + 1); }} /> : groups.map(group => <div className="flow-overview" key={group}>
      <div className="automation-heading"><strong>{group === 'Workflow' ? 'Todos' : group}</strong>{group !== 'Workflow' && !readOnly && <button type="button" aria-label={`Edit ${group} flow`} onClick={() => setEditing(group ?? null)}>Edit</button>}</div>
      <p>{stagesOf(group, labels).map((l, i) => <span key={l.id}>{i > 0 && <span aria-hidden> → </span>}{l.name}{finishedStage(l) && <small> · finished</small>}</span>)}</p>
      <button type="button" onClick={() => { setLabelFilter(stagesOf(group, labels).map(l => l.id)); showToast(`${group === 'Workflow' ? 'Todos' : group} stages selected for the board`); }}>Use as board columns</button>
    </div>)}
  </section>;
}

function FlowEditor({ group, labels, onClose }: { group: string | null; labels: Label[]; onClose(): void }) {
  const { saveFlow, cards } = useStore();
  const [name, setName] = useState(group ?? '');
  const [source, setSource] = useState(group);
  const available = [...new Set(labels.filter(l => l.group && !isFlowStage(l) && l.group !== 'Workflow' && !labels.some(stage => stage.group === l.group && isFlowStage(stage))).map(l => l.group!))];
  const [stages, setStages] = useState<Stage[]>(() => group ? stagesOf(group, labels).map(l => ({ id: l.id, name: l.name, finished: finishedStage(l) })) : [{ name: '', finished: false }, { name: '', finished: false }, { name: '', finished: true }]);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const affected = source ? cards.filter(c => c.labels.some(id => labels.some(l => l.id === id && l.group === source))).length : 0;
  const save = () => {
    if (affected && !confirm) { setConfirm(true); return; }
    if (saveFlow(source, name, stages)) onClose();
    else setError('Use a unique flow name, 2–12 different stage names, and one finished stage after the first stage.');
  };
  const move = (index: number, to: number) => setStages(before => { const next = [...before]; [next[index], next[to]] = [next[to], next[index]]; return next; });
  return <div className="flow-editor">
    {!group && available.length > 0 && <label className="automation-field">Start from<select aria-label="Start from" value={source ?? ''} onChange={e => { const selected = e.target.value || null; setSource(selected); setName(selected ?? ''); setConfirm(false); if (selected) setStages(labels.filter(l => l.group === selected).map((l, n, all) => ({ id: l.id, name: l.name, finished: n === all.length - 1 }))); else setStages([{ name: '', finished: false }, { name: '', finished: true }]); }}><option value="">New stages</option>{available.map(g => <option key={g} value={g}>{g} labels</option>)}</select></label>}
    {!group && <button type="button" onClick={() => { setSource(null); setName('Editorial'); setStages([{ name: 'Draft', finished: false }, { name: 'Review', finished: false }, { name: 'Published', finished: true }]); }}>Use Editorial example</button>}
    <label className="automation-field">Flow name<input aria-label="Flow name" autoFocus value={name} maxLength={40} placeholder="e.g. Editorial" onChange={e => { setName(e.target.value); setConfirm(false); }} /></label>
    <p className="automation-hint">The first stage is where a note starts. Choose the stage that means finished.</p>
    <ol className="flow-stage-list">{stages.map((stage, index) => <li key={index}>
      <label className="automation-field">Stage {index + 1}<input aria-label={`Stage ${index + 1}`} value={stage.name} maxLength={40} onChange={e => { setStages(stages.map((s, n) => n === index ? { ...s, name: e.target.value } : s)); setConfirm(false); }} /></label>
      <div className="flow-stage-actions"><label><input type="radio" name="flow-finished" aria-label={`Stage ${index + 1} means finished`} disabled={index === 0} checked={stage.finished} onChange={() => { setStages(stages.map((s, n) => ({ ...s, finished: n === index }))); setConfirm(false); }} />Finished</label>
      <button type="button" disabled={index === 0} aria-label={`Move stage ${index + 1} up`} onClick={() => { move(index, index - 1); setConfirm(false); }}>↑</button><button type="button" disabled={index === stages.length - 1} aria-label={`Move stage ${index + 1} down`} onClick={() => { move(index, index + 1); setConfirm(false); }}>↓</button><button type="button" disabled={stages.length <= 2} aria-label={`Remove stage ${index + 1}`} onClick={() => { setStages(stages.filter((_, n) => n !== index)); setConfirm(false); }}>×</button></div>
    </li>)}</ol>
    <button type="button" disabled={stages.length >= 12} onClick={() => { setStages([...stages, { name: '', finished: false }]); setConfirm(false); }}>Add stage</button>
    <p className="automation-hint">Finishing keeps a note visible and leaves its checklist ticks unchanged. Reopening returns to its previous stage, or the first stage. Removed stages remain ordinary labels.</p>
    {confirm && <p role="status">These changes affect {affected} {affected === 1 ? 'note' : 'notes'}. Each keeps one stage, replacing any other flow stage. Content and other labels stay. You can undo after saving.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="automation-buttons"><button type="button" onClick={onClose}>Cancel</button><button type="button" onClick={save}>{confirm ? 'Apply changes' : 'Save flow'}</button></div>
  </div>;
}
