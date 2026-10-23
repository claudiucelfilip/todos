// Workflow labels are authoritative; legacy fields remain as API compatibility mirrors.
export const WORKFLOW_LABELS = [
  { id: 'workflow:todo', name: 'To do', color: '#6366F1' },
  { id: 'workflow:doing', name: 'Doing', color: '#C2410C' },
  { id: 'workflow:done', name: 'Done', color: '#0F766E' },
];
export const workflowId = (status) => `workflow:${status}`;
export const isWorkflowLabel = (id) => WORKFLOW_LABELS.some((l) => l.id === id);
export const workflowStatus = (card) => (card.labels ?? []).find(isWorkflowLabel)?.slice(9) ?? null;
export function workflowLabels(labels, status) {
  return [...new Set([...(labels ?? []).filter((id) => !isWorkflowLabel(id)), ...(status ? [workflowId(status)] : [])])];
}
export const isFlowStage = label => isWorkflowLabel(label.id) || !!(label.group?.trim() && label.flowStage);
export const flowGroup = label => isWorkflowLabel(label.id) ? 'Workflow' : label.group?.trim();
export const flowOrder = label => isWorkflowLabel(label.id) ? WORKFLOW_LABELS.findIndex(l => l.id === label.id) : label.flowStage?.order ?? 0;
export const finishedStage = label => label.id === 'workflow:done' || label.flowStage?.finished === true;
export const stageOf = (card, labels) => [...(card.labels ?? [])].reverse().map(id => labels.find(l => l.id === id)).find(l => l && isFlowStage(l));
export const stagesOf = (group, labels) => labels.filter(l => isFlowStage(l) && flowGroup(l) === group).sort((a, b) => flowOrder(a) - flowOrder(b) || a.id.localeCompare(b.id));

export function completionLabels(card, done, labels) {
  const stage = stageOf(card, labels);
  const stages = stagesOf(stage ? flowGroup(stage) : 'Workflow', labels);
  const target = done ? stages.find(finishedStage) : stages.find(l => l.id === card.reopenStage && !finishedStage(l)) ?? stages.find(l => !finishedStage(l));
  if (!target) return card.labels;
  return [...card.labels.filter(id => !labels.some(l => l.id === id && isFlowStage(l)) && !isWorkflowLabel(id)), target.id];
}
export function applyWorkflow(card, now, labels, previous) {
  const stage = labels ? stageOf(card, labels) : undefined;
  // Reducers without the board registry preserve custom-flow mirrors until commit.
  if (!labels && !workflowStatus(card) && card.kind !== 'note' && card.labels?.length) return card;
  const old = previous && labels ? stageOf(previous, labels) : undefined;
  if (old && stage && old.id !== stage.id && flowGroup(old) === flowGroup(stage) && !finishedStage(old)) card.reopenStage = old.id;
  if (old && (!stage || flowGroup(old) !== flowGroup(stage))) delete card.reopenStage;
  const status = stage ? finishedStage(stage) ? 'done' : flowOrder(stage) === 0 ? 'todo' : 'doing' : workflowStatus(card);
  if (!stage || isWorkflowLabel(stage.id)) card.labels = workflowLabels(card.labels, status);
  card.status = status ?? 'todo';
  if (status) delete card.kind;
  else card.kind = 'note';
  delete card.done;
  card.completedAt = status === 'done' ? (old && finishedStage(old) && previous.completedAt) || card.completedAt || now : null;
  return card;
}
export function migrateWorkflow(card, labels) {
  if (!Array.isArray(labels)) labels = undefined;
  const next = { ...card, labels: [...(card.labels ?? [])], workflowVersion: 1 };
  if (card.workflowVersion !== 1) {
    const status = card.kind === 'note' ? (card.done ? 'done' : null) : card.status;
    next.labels = workflowLabels(next.labels, status);
  }
  return applyWorkflow(next, card.updatedAt || card.createdAt, labels);
}

/** A linked checklist card needs a workflow stage; keep its existing progress. */
export function linkedTodo(card) {
  if (card.kind !== 'note') return card;
  const items = card.items ?? [];
  const status = card.done || (items.length > 0 && items.every(i => i.done)) ? 'done' : items.some(i => i.done) ? 'doing' : 'todo';
  const base = migrateWorkflow(card);
  return migrateWorkflow({ ...base, labels: workflowLabels(base.labels, status) });
}

export function migrateLinkedNotes(cards) {
  const refs = new Set(cards.flatMap(card => (card.items ?? []).map(item => item.ref).filter(Boolean)));
  return cards.map(card => refs.has(card.id) ? linkedTodo(card) : card);
}
