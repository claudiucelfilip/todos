import { useEffect, useRef, useState } from 'react';
import { groupOf, rulesOf, settleAutomations } from '../../shared/automations.mjs';
import { isWorkflowLabel, WORKFLOW_LABELS } from '../../shared/workflow.mjs';
import { useStore } from '../hooks/useStore';
import type { AutomationRule, Card, Label } from '../lib/types';
import { uid } from '../lib/db';
import { ColorChoice, LabelPill } from './Labels';
import { NO_AUTOFILL } from '../lib/keys';

const CONDITIONS: Record<AutomationRule['condition'], string> = {
  complete: 'All checklist items are complete',
  partial: 'Some, but not all, items are complete',
  incomplete: 'Checklist is incomplete',
  'child-doing': 'Any child item is Doing',
};
const ACTIONS: Record<AutomationRule['action'], string> = { 'set-group': 'Set group', add: 'Add label', remove: 'Remove label' };

export default function LabelSettings({ label, onBack }: { label: Label; onBack(): void }) {
  const { labels, updateLabel, deleteLabel, readOnly } = useStore();
  const rules = rulesOf(label);
  const [name, setName] = useState(label.name);
  const [group, setGroup] = useState(groupOf(label) ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setName(label.name); setGroup(groupOf(label) ?? ''); }, [label.id, label.name, label.group]);
  const saveRules = (next: AutomationRule[]) => updateLabel(label.id, { automations: next });
  const builtin = isWorkflowLabel(label.id);
  const editingRule = rules.find(r => r.id === editing);
  return <div className="label-settings" data-testid="label-settings">
    <label className="automation-field">Name<input value={name} maxLength={40} readOnly={builtin || readOnly} {...NO_AUTOFILL} onChange={e => setName(e.target.value)} onBlur={() => { if (name.trim()) updateLabel(label.id, { name }); else setName(label.name); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
    {!builtin && !readOnly && <ColorChoice value={label.color} name={label.name} onChange={color => updateLabel(label.id, { color })} />}
    <section className="automation-section">
      <div className="automation-heading"><h3>Label group</h3><input aria-label="Label group" list="label-groups" value={group} readOnly={builtin || !!label.flowStage || readOnly} maxLength={40} placeholder="None" onChange={e => setGroup(e.target.value)} onBlur={() => updateLabel(label.id, { group: group.trim() || null })} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /><datalist id="label-groups">{[...new Set(['Workflow', ...labels.map(l => groupOf(l)).filter((g): g is string => !!g)])].map(g => <option key={g} value={g} />)}</datalist></div>
      <p className="automation-hint">{label.flowStage ? 'This stage belongs to a flow. Edit its order or finished stage in Settings → Flows.' : group.trim() ? `Only one ${group.trim()} label at a time. Setting one replaces the others.` : 'Independent labels can be combined freely.'}</p>
    </section>
    <section className="automation-section">
      <div className="automation-heading"><h3>Automations</h3><span className="automation-count">{rules.length}</span></div>
      <p className="automation-hint">When an item’s progress changes…</p>
      {rules.map((rule, index) => {
        const target = labels.find(l => l.id === rule.target);
        const scopeLabel = rule.scope.startsWith('label:') ? labels.find(l => l.id === rule.scope.slice(6)) : undefined;
        const missing = !target || (rule.scope.startsWith('label:') && !scopeLabel) || (rule.action === 'set-group' && target && !groupOf(target));
        return <div className="automation-rule" key={rule.id}>
          <div className="automation-rule-head"><button type="button" className="automation-summary" aria-expanded={editing === rule.id} onClick={() => { setEditing(editing === rule.id ? null : rule.id); setCreating(false); }}>
            <span>{CONDITIONS[rule.condition]}</span><span className="automation-scope">{rule.scope === 'workflow' ? 'Any workflow item' : rule.scope === 'owner' ? `Items labeled ${label.name}` : `Items labeled ${scopeLabel?.name ?? 'deleted label'}`}</span>
            <span className="automation-result"><span aria-hidden>↳</span> {rule.action === 'set-group' ? `Set ${target ? groupOf(target) ?? 'group' : 'group'}` : ACTIONS[rule.action]} {target ? <LabelPill label={target} /> : <span>Deleted label</span>}</span>
          </button><button type="button" role="switch" aria-label={`Enable automation ${index + 1}`} aria-checked={rule.enabled} disabled={readOnly || missing} className="automation-switch" onClick={() => saveRules(rules.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))} /></div>
          {missing && <p className="automation-warning">Choose an existing label{rule.action === 'set-group' ? ' with a group' : ''} to reactivate this rule.</p>}
          {editingRule?.id === rule.id && <RuleEditor key={rule.id} owner={label} labels={labels} rule={rule} readOnly={readOnly} onCancel={() => setEditing(null)} onSave={r => { saveRules(rules.map(x => x.id === r.id ? r : x)); setEditing(null); }} onDelete={() => { saveRules(rules.filter(r => r.id !== rule.id)); setEditing(null); }} />}
        </div>;
      })}
      {!readOnly && !creating && <button type="button" className="automation-add" disabled={rules.length >= 30} onClick={() => { setCreating(true); setEditing(null); }}>＋ Add automation</button>}
      {creating && <RuleEditor owner={label} labels={labels} readOnly={readOnly} rule={{ id: uid(), condition: 'complete', scope: builtin ? 'workflow' : 'owner', action: groupOf(label) ? 'set-group' : 'add', target: label.id, enabled: true }} onCancel={() => setCreating(false)} onSave={r => { saveRules([...rules, r]); setCreating(false); }} />}
      <p className="automation-hint automation-explanation">Linked items include progress from their children. Empty checklists never count as complete. Rules run once per progress change; the first matching action for a group wins.</p>
      {builtin && !readOnly && <button type="button" className="automation-text" onClick={() => { saveRules(structuredClone(rulesOf({ ...label, automations: undefined }))); setEditing(null); }}>Restore default automations</button>}
    </section>
    <section className="automation-section">
      <div className="automation-heading"><h3>On view</h3><button type="button" role="switch" className="automation-switch" aria-label="Remove when note is opened" aria-checked={label.removeOnView === true} disabled={readOnly} onClick={() => updateLabel(label.id, { removeOnView: !label.removeOnView })} /></div>
      <p className="automation-hint">Remove this label when its note is visible in the editor.</p>
    </section>
    <AutomationPreview labels={labels} owner={label} />
    {!builtin && !label.flowStage && label.id !== 'sherlock' && !readOnly && <section className="automation-section">{confirmDelete ? <><p className="automation-hint">Delete {label.name}? Its notes stay. Rules targeting this label will stop.</p><div className="automation-buttons"><button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button><button type="button" className="danger" onClick={() => { deleteLabel(label.id); onBack(); }}>Delete label</button></div></> : <button type="button" className="automation-text danger" onClick={() => setConfirmDelete(true)}>Delete label</button>}</section>}
  </div>;
}

function RuleEditor({ rule, owner, labels, onSave, onCancel, onDelete, readOnly }: { rule: AutomationRule; owner: Label; labels: Label[]; onSave(rule: AutomationRule): void; onCancel(): void; onDelete?(): void; readOnly: boolean }) {
  const [draft, setDraft] = useState(rule);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); ref.current?.querySelector('select')?.focus({ preventScroll: true }); }, []);
  const target = labels.find(l => l.id === draft.target);
  const valid = !!target && (draft.action !== 'set-group' || !!groupOf(target)) && (!draft.scope.startsWith('label:') || labels.some(l => l.id === draft.scope.slice(6)));
  const field = (key: keyof AutomationRule, value: string) => setDraft(d => ({ ...d, [key]: value }));
  return <div className="automation-editor" ref={ref}>
    <label className="automation-field">When<select aria-label="When" disabled={readOnly} value={draft.condition} onChange={e => field('condition', e.target.value)}>{Object.entries(CONDITIONS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    <label className="automation-field">For<select aria-label="For" disabled={readOnly} value={draft.scope} onChange={e => field('scope', e.target.value)}><option value="owner">Items labeled {owner.name}</option><option value="workflow">Any workflow item</option>{labels.map(l => <option key={l.id} value={`label:${l.id}`}>Items labeled {l.name}</option>)}{draft.scope.startsWith('label:') && !labels.some(l => `label:${l.id}` === draft.scope) && <option value={draft.scope}>Deleted label</option>}</select></label>
    <div className="automation-action-fields"><label className="automation-field">Then<select aria-label="Then" disabled={readOnly} value={draft.action} onChange={e => field('action', e.target.value)}>{Object.entries(ACTIONS).map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label><label className="automation-field">Label<select aria-label="Label" disabled={readOnly} value={draft.target} onChange={e => field('target', e.target.value)}>{!target && <option value={draft.target}>Deleted label</option>}{labels.map(l => <option key={l.id} value={l.id} disabled={draft.action === 'set-group' && !groupOf(l)}>{l.name}</option>)}</select></label></div>
    <div className="automation-buttons">{onDelete && !readOnly && <button type="button" className="danger" onClick={onDelete}>Delete</button>}<span /><button type="button" onClick={onCancel}>Cancel</button>{!readOnly && <button type="button" className="automation-save" disabled={!valid} onClick={() => onSave(draft)}>Save automation</button>}</div>
  </div>;
}

function AutomationPreview({ labels, owner }: { labels: Label[]; owner: Label }) {
  const now = '2026-01-01T00:00:00.000Z';
  const card = (id: string): Card => ({ id, title: id, notes: '', workflowVersion: 1, status: 'todo', labels: [...new Set(['workflow:todo', ...(!isWorkflowLabel(owner.id) ? [owner.id] : [])])], items: [], order: 0, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, someday: false, repeat: false });
  const initial = () => [
    { ...card('Prepare dinner'), items: [{ id: 'child', text: 'Buy ingredients', done: false, ref: 'Buy ingredients' }, { id: 'table', text: 'Set the table', done: false }] },
    { ...card('Buy ingredients'), items: [{ id: 'shop', text: 'Visit shop', done: false }] },
  ];
  const [settled, setSettled] = useState<Card[]>(initial);
  const checked = [settled[1].items[0].done, settled[0].items[1].done];
  const childStarted = settled[1].labels.includes('workflow:doing');
  const change = (index: number, done: boolean) => setSettled(before => {
    const after = before.map((c, n) => n === (index === 0 ? 1 : 0) ? { ...c, items: c.items.map(i => i.id === (index === 0 ? 'shop' : 'table') ? { ...i, done } : i) } : c);
    return settleAutomations(after, labels.length ? labels : WORKFLOW_LABELS, before, now);
  });
  const startChild = (doing: boolean) => setSettled(before => settleAutomations(before.map((c, n) => n === 1 ? { ...c, status: doing ? 'doing' : 'todo', labels: [...c.labels.filter(id => !isWorkflowLabel(id)), `workflow:${doing ? 'doing' : 'todo'}`], done: undefined, completedAt: null } : c), labels, before, now));
  return <details className="automation-preview"><summary>Try with sample items</summary><p className="automation-hint">Uses your saved rules. Your notes stay untouched.</p><label><input type="checkbox" checked={checked[0]} onChange={e => change(0, e.target.checked)} />Buy ingredients <span className="automation-scope">linked note</span></label><label><input type="checkbox" checked={checked[1]} onChange={e => change(1, e.target.checked)} />Set the table</label><label><input type="checkbox" checked={childStarted} onChange={e => startChild(e.target.checked)} />Buy ingredients is Doing</label><p className="automation-preview-result" aria-live="polite">{settled.map(c => <span key={c.id}>{c.title} → <strong>{c.labels.map(id => labels.find(l => l.id === id)?.name).filter(Boolean).join(' · ') || 'No labels'}</strong></span>)}</p></details>;
}
