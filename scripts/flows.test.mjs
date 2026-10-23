import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_LABELS, applyWorkflow, completionLabels, migrateWorkflow } from '../shared/workflow.mjs';
import { groupedLabels, settleAutomations } from '../shared/automations.mjs';
import { emptyState, stateFromCards, applyAction, snapshot, diffLabels, diffCards } from '../shared/merge.mjs';
const now = '2026-10-20T12:00:00.000Z';
const later = '2026-10-21T12:00:00.000Z';
const stages = ['Draft', 'Review', 'Published'].map((name, order) => ({ id: name.toLowerCase(), name, color: '#123456', group: 'Editorial', flowStage: { order, finished: order === 2 } }));
const labels = [...WORKFLOW_LABELS, ...stages, { id: 'tag', name: 'Tag', color: '#123456' }];
const card = (stage = 'draft', extra = {}) => applyWorkflow({ id: 'article', workflowVersion: 1, title: 'Article', notes: '', labels: ['tag', stage], status: 'todo', items: [], completedAt: null, archivedAt: null, createdAt: now, updatedAt: now, ...extra }, now, labels);
const move = (c, stage) => settleAutomations([{ ...c, labels: groupedLabels([...c.labels, stage], labels) }], labels, [c], later)[0];

test('custom stages are exclusive across flows and preserve ordinary tags', () => {
  assert.deepEqual(groupedLabels(['tag', 'draft', 'workflow:doing', 'review'], labels), ['tag', 'review']);
  assert.deepEqual(groupedLabels(['tag', 'published', 'workflow:todo'], labels), ['tag', 'workflow:todo']);
});
test('finish/reopen returns to the previous open stage and leaves ticks unchanged', () => {
  const review = move(card(), 'review');
  const done = move(review, completionLabels(review, true, labels).at(-1));
  assert.equal(done.status, 'done'); assert.equal(done.reopenStage, 'review'); assert.equal(done.completedAt, later);
  const opened = move(done, completionLabels(done, false, labels).at(-1));
  assert.equal(opened.status, 'doing'); assert.equal(opened.completedAt, null); assert.deepEqual(opened.items, review.items);
});
test('missing prior stage falls back to the first stage; plain-note ring still attaches Todos', () => {
  assert.equal(completionLabels(card('published', { reopenStage: 'deleted' }), false, labels).at(-1), 'draft');
  assert.equal(completionLabels(card('', { labels: ['tag'], kind: 'note' }), true, labels).at(-1), 'workflow:done');
});
test('custom completion updates linked parents without running Todo rules on the custom note', () => {
  const child = card('review', { items: [{ id: 'tick', text: 'Step', done: true }] });
  const parent = card('workflow:todo', { id: 'parent', labels: ['workflow:todo'], items: [{ id: 'link', text: 'Article', ref: child.id, done: false }] });
  const next = settleAutomations([{ ...child, labels: ['published'] }, parent], labels, [child, parent], later);
  assert.equal(next[0].status, 'done'); assert.equal(next[1].status, 'done'); assert.equal(next[1].items[0].done, true);
  const reopened = settleAutomations([{ ...next[0], labels: ['review'] }, next[1]], labels, next, later);
  assert.equal(reopened[1].items[0].done, false); assert.equal(reopened[1].status, 'doing');
});
test('checklist completion alone does not move a custom flow; custom rules stay editable', () => {
  const before = card('draft', { items: [{ id: 'step', text: 'Step', done: false }] });
  const after = { ...before, items: [{ ...before.items[0], done: true }] };
  assert.deepEqual(settleAutomations([after], labels, [before], later)[0].labels, before.labels);
  const configured = labels.map(l => l.id === 'draft' ? { ...l, automations: [{ id: 'review-on-complete', condition: 'complete', scope: 'owner', action: 'set-group', target: 'review', enabled: true }] } : l);
  assert.equal(settleAutomations([after], configured, [before], later)[0].labels.at(-1), 'review');
});
test('reload and edits preserve a finished stage and its original completion time', () => {
  const done = card('published');
  const loaded = migrateWorkflow(done, labels);
  const edited = applyWorkflow({ ...loaded, title: 'Edited' }, later, labels, loaded);
  assert.equal(loaded.status, 'done'); assert.equal(edited.completedAt, now); assert.equal(edited.archivedAt, null);
});
test('flow metadata, stage and reopen history survive merge replay and old label clients', () => {
  const state = emptyState();
  for (const action of diffLabels([], labels, now, 'one')) applyAction(state, action);
  const review = card('review'); const done = move(review, 'published');
  for (const action of diffCards([], [done], later, 'one')) applyAction(state, action);
  assert.equal(state.cards.article.status, 'done'); assert.equal(state.cards.article.reopenStage, 'review');
  applyAction(state, { id: 'old-client', type: 'label.put', ts: '2026-10-22T00:00:00.000Z', deviceId: 'old', payload: { label: { id: 'published', name: 'Published', color: '#654321' } } });
  assert.deepEqual(snapshot(state).labels.find(l => l.id === 'published').flowStage, { order: 2, finished: true });
  assert.equal(state.labels.published.group, 'Editorial');
});

test('snapshot bootstrap loads definitions before deriving custom completion', () => {
  const done = card('published', { reopenStage: 'review' });
  const boot = stateFromCards([done], labels);
  assert.equal(boot.cards.article.status, 'done');
  assert.equal(boot.cards.article.kind, undefined);
  assert.equal(boot.cards.article.reopenStage, 'review');
});

test('custom rules win once across the single primary flow, before built-in rules', () => {
  const before = card('workflow:todo', { items: [{ id: 'step', text: 'Step', done: false }] });
  const after = { ...before, items: [{ ...before.items[0], done: true }] };
  const configured = labels.map(l => l.id === 'review' ? { ...l, automations: [{ id: 'custom-first', condition: 'complete', scope: 'workflow', action: 'set-group', target: 'review', enabled: true }] } : l);
  const result = settleAutomations([after], configured, [before], later)[0];
  assert.deepEqual(result.labels, ['tag', 'review']);
  assert.equal(result.status, 'doing');
});

test('undoing conversion explicitly clears metadata instead of preserving it as an old-client omission', () => {
  const state = stateFromCards([], labels);
  const plain = labels.map(({ flowStage, ...label }) => label);
  for (const action of diffLabels(labels, plain, later, 'undo')) applyAction(state, action);
  assert.equal(state.labels.published.flowStage, null);
  const active = card('review', { labels: ['review', 'workflow:doing'] });
  for (const action of diffCards([], [active], later, 'undo')) applyAction(state, action);
  assert.deepEqual(state.cards.article.labels, ['review', 'workflow:doing']);
});
