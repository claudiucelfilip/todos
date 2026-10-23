import { applyWorkflow, isWorkflowLabel, workflowStatus, isFlowStage } from './workflow.mjs';
import { isCardDone } from './notes.mjs';

export const CONDITIONS = ['complete', 'partial', 'incomplete', 'child-doing'];
export const ACTIONS = ['set-group', 'add', 'remove'];
export const DEFAULT_RULES = {
  'workflow:todo': [],
  'workflow:doing': [
    { id: 'partial', condition: 'partial', scope: 'workflow', action: 'set-group', target: 'workflow:doing', enabled: true },
    { id: 'reopened', condition: 'incomplete', scope: 'label:workflow:done', action: 'set-group', target: 'workflow:doing', enabled: true },
    { id: 'child-started', condition: 'child-doing', scope: 'workflow', action: 'set-group', target: 'workflow:doing', enabled: true },
  ],
  'workflow:done': [
    { id: 'complete', condition: 'complete', scope: 'workflow', action: 'set-group', target: 'workflow:done', enabled: true },
  ],
};
export const groupOf = label => isWorkflowLabel(label.id) ? 'Workflow' : label.group?.trim() || null;
export const rulesOf = label => label.automations ?? DEFAULT_RULES[label.id] ?? [];

/** Omitted behavior fields from older clients preserve existing settings. */
export function cleanBehavior(src, prev = {}) {
  const out = {};
  const removeOnView = src.removeOnView === undefined ? prev.removeOnView : src.removeOnView;
  if (typeof removeOnView === 'boolean') out.removeOnView = removeOnView;
  const group = src.group === undefined ? prev.group : src.group;
  if (typeof group === 'string' && group.trim()) out.group = group.trim().slice(0, 40);
  const stage = src.flowStage === undefined ? prev.flowStage : src.flowStage;
  if (stage === null) out.flowStage = null;
  else if (stage && Number.isInteger(stage.order) && stage.order >= 0 && stage.order < 30) out.flowStage = { order: stage.order, finished: stage.finished === true };
  const rules = src.automations === undefined ? prev.automations : src.automations;
  if (Array.isArray(rules)) {
    const seen = new Set();
    out.automations = rules.slice(0, 30).filter(r => {
      if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id) || !CONDITIONS.includes(r.condition) || !ACTIONS.includes(r.action) || typeof r.target !== 'string' || !r.target || typeof r.scope !== 'string' || !(r.scope === 'workflow' || r.scope === 'owner' || r.scope.startsWith('label:'))) return false;
      seen.add(r.id);
      return true;
    }).map(r => ({ id: r.id.slice(0, 100), condition: r.condition, scope: r.scope.slice(0, 150), action: r.action, target: r.target.slice(0, 100), enabled: r.enabled !== false }));
  }
  return out;
}

/** The last explicitly selected label wins within each group. */
export function groupedLabels(ids, labels) {
  const byId = new Map(labels.map(l => [l.id, l]));
  const seen = new Set();
  const primary = Symbol('primary flow');
  return [...new Set(ids)].reverse().filter(id => {
    const label = byId.get(id);
    const group = label ? isFlowStage(label) || groupOf(label) === 'Workflow' ? primary : groupOf(label) : isWorkflowLabel(id) ? primary : null;
    if (!group) return true;
    if (seen.has(group)) return false;
    seen.add(group);
    return true;
  }).reverse();
}
const progressKey = c => JSON.stringify((c?.items ?? []).map(i => [i.id, !!i.done, i.ref ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
const statusKey = c => c ? `${isCardDone(c)}|${workflowStatus(c)}` : 'missing';

/** Evaluate affected descendants first; labels never recursively trigger other rules. */
export function settleAutomations(cards, labels, before, now) {
  const old = new Map(before.map(c => [c.id, c]));
  cards = cards.map(c => {
    if (c.workflowVersion !== 1) return c;
    const next = applyWorkflow({ ...c, labels: groupedLabels(c.labels, labels) }, now, labels, old.get(c.id));
    return next.status === c.status && next.kind === c.kind && next.completedAt === c.completedAt && next.reopenStage === c.reopenStage && c.done === undefined && next.labels.length === c.labels.length && next.labels.every((id, n) => id === c.labels[n]) ? c : next;
  });
  const byId = new Map(cards.map(c => [c.id, c]));
  const parents = new Map();
  for (const c of cards) for (const i of c.items ?? []) if (i.ref) {
    if (!parents.has(i.ref)) parents.set(i.ref, new Set());
    parents.get(i.ref).add(c.id);
  }
  const progressChanged = new Set(cards.filter(c => progressKey(c) !== progressKey(old.get(c.id))).map(c => c.id));
  const affected = new Set([...progressChanged, ...cards.filter(c => old.has(c.id) && statusKey(c) !== statusKey(old.get(c.id))).map(c => c.id), ...before.filter(c => !byId.has(c.id)).map(c => c.id)]);
  const queue = [...affected];
  for (let n = 0; n < queue.length; n++) for (const id of parents.get(queue[n]) ?? []) if (!affected.has(id)) { affected.add(id); queue.push(id); }
  const sortedLabels = [...labels].sort((a, b) => Number(isWorkflowLabel(a.id)) - Number(isWorkflowLabel(b.id)) || a.id.localeCompare(b.id));
  const visiting = new Set(), visited = new Set(), cyclic = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    if (visiting.has(id)) { for (const key of visiting) cyclic.add(key); return; }
    const card = byId.get(id);
    if (!card) return;
    visiting.add(id);
    for (const i of card.items ?? []) if (i.ref && affected.has(i.ref)) visit(i.ref);
    visiting.delete(id); visited.add(id);
    if (cyclic.has(id) || card.archivedAt || card.draft) return;
    let next = { ...card, items: card.items.map(i => {
      const child = byId.get(i.ref);
      return child ? { ...i, done: isCardDone(child) } : { ...i };
    }) };
    const childChanged = card.items.some(i => i.ref && affected.has(i.ref) && (progressKey(byId.get(i.ref)) !== progressKey(old.get(i.ref)) || statusKey(byId.get(i.ref)) !== statusKey(old.get(i.ref))));
    if (progressChanged.has(id) || childChanged || progressKey(next) !== progressKey(card)) {
      const total = next.items.length, done = next.items.filter(i => i.done).length;
      const conditions = { complete: total > 0 && done === total, partial: done > 0 && done < total, incomplete: total > 0 && done < total, 'child-doing': next.items.some(i => i.ref && workflowStatus(byId.get(i.ref) ?? {}) === 'doing') };
      const initial = new Set(next.labels ?? []), touchedGroups = new Set(), touchedLabels = new Set(), primary = Symbol('primary flow');
      for (const owner of sortedLabels) for (const rule of rulesOf(owner)) {
        if (!rule.enabled || !conditions[rule.condition]) continue;
        const scope = rule.scope === 'workflow' ? labels.some(l => initial.has(l.id) && groupOf(l) === 'Workflow') : rule.scope === 'owner' ? initial.has(owner.id) : initial.has(rule.scope.slice(6));
        const target = labels.find(l => l.id === rule.target);
        if (!scope || !target) continue;
        const group = isFlowStage(target) ? primary : groupOf(target);
        if (touchedLabels.has(target.id) || (group && touchedGroups.has(group))) continue;
        if (rule.action === 'set-group' && !group) continue;
        if (group) touchedGroups.add(group);
        touchedLabels.add(target.id);
        next.labels = rule.action === 'remove' ? next.labels.filter(id => id !== target.id) : groupedLabels([...next.labels, target.id], labels);
      }
      if (next.workflowVersion === 1) applyWorkflow(next, now, labels, card);
    }
    if (JSON.stringify(next.items) !== JSON.stringify(card.items) || JSON.stringify(next.labels) !== JSON.stringify(card.labels) || next.completedAt !== card.completedAt) {
      next.updatedAt = now;
      byId.set(id, next);
    }
  };
  // Dependency order does not depend on the cards’ display order.
  for (const id of affected) visit(id);
  return cards.map(c => byId.get(c.id));
}
