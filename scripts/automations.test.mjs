import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBehavior, groupedLabels, rulesOf, settleAutomations } from '../shared/automations.mjs';
import { WORKFLOW_LABELS, workflowStatus } from '../shared/workflow.mjs';
import { applyAction, diffLabels, emptyState, stateFromCards } from '../shared/merge.mjs';

const now = '2026-10-12T10:00:00.000Z';
const item = (id, done = false, ref) => ({ id, text: id, done, ...(ref ? { ref } : {}) });
const card = (id, status = 'todo', items = []) => ({ id, title: id, notes: '', workflowVersion: 1, labels: status ? [`workflow:${status}`] : [], kind: status ? undefined : 'note', status: status || 'todo', items, order: 0, createdAt: now, updatedAt: now, completedAt: status === 'done' ? now : null, archivedAt: null, someday: false, repeat: false });
const run = (before, after, labels = WORKFLOW_LABELS) => settleAutomations(after, labels, before, now);
const status = cards => cards.map(workflowStatus);
for (const previous of ['todo', 'doing', 'done', null]) {
  for (const [name, rows, expected] of [
    ['all checked', [item('a', true), item('b', true)], 'done'],
    ['part checked', [item('a', true), item('b')], 'doing'],
    ['none checked', [item('a'), item('b')], previous === 'done' ? 'doing' : previous],
    ['empty', [], previous],
  ]) test(`${previous ?? 'plain note'}: ${name}`, () => {
    const before = card('one', previous, [item('old')]);
    assert.equal(workflowStatus(run([before], [{ ...before, items: rows }])[0]), previous === null ? null : expected);
  });
}
test('manual moves, title edits, resizing and reordering do not run rules', () => {
  const before = card('a', 'todo', [item('a', true), item('b')]);
  for (const changes of [{ title: 'New' }, { layout: { width: 2 } }, { items: [...before.items].reverse() }]) assert.equal(workflowStatus(run([before], [{ ...before, ...changes }])[0]), 'todo');
  const moved = { ...before, status: 'done', labels: ['workflow:done'], completedAt: now };
  assert.equal(workflowStatus(run([before], [moved])[0]), 'done');
});
test('adding an unchecked item reopens Done; removing last unfinished item finishes it', () => {
  const done = card('a', 'done', [item('a', true)]);
  const added = { ...done, items: [...done.items, item('b')] };
  const doing = run([done], [added])[0]; assert.equal(workflowStatus(doing), 'doing'); assert.equal(doing.completedAt, null);
  const completed = run([doing], [{ ...doing, items: [item('a', true)] }])[0]; assert.equal(workflowStatus(completed), 'done'); assert.equal(completed.completedAt, now);
});
test('three-level propagation works in either array order and reopens every ancestor', () => {
  for (const reverse of [false, true]) {
    let before = [card('parent', 'todo', [item('r', false, 'child')]), card('child', 'todo', [item('r', false, 'leaf')]), card('leaf', 'todo', [item('a')])];
    if (reverse) before.reverse();
    const after = before.map(c => c.id === 'leaf' ? { ...c, items: [item('a', true)] } : c);
    const settled = run(before, after); assert.ok(status(settled).every(s => s === 'done'));
    const reopened = run(settled, settled.map(c => c.id === 'leaf' ? { ...c, items: [item('a')] } : c)); assert.ok(status(reopened).every(s => s === 'doing'));
    assert.ok(reopened.filter(c => c.id !== 'leaf').every(c => !c.items[0].done));
  }
});
test('Doing with zero ticks propagates through multiple levels and shared parents', () => {
  const before = [card('top', 'todo', [item('r', false, 'parent')]), card('other', 'todo', [item('r', false, 'leaf')]), card('parent', 'todo', [item('r', false, 'leaf')]), card('leaf')];
  const settled = run(before, before.map(c => c.id === 'leaf' ? { ...c, labels: ['workflow:doing'], status: 'doing' } : c));
  assert.ok(status(settled).every(s => s === 'doing')); assert.ok(settled.every(c => c.items.every(i => !i.done)));
});
test('manual parent completion never checks its children', () => {
  const before = [card('parent', 'todo', [item('r', false, 'child')]), card('child', 'todo', [item('a')])];
  const settled = run(before, [{ ...before[0], labels: ['workflow:done'], status: 'done', completedAt: now }, before[1]]);
  assert.equal(workflowStatus(settled[1]), 'todo'); assert.equal(settled[1].items[0].done, false);
});
test('archived notes are not moved and plain notes still mirror linked progress', () => {
  const before = [{ ...card('archived', 'todo', [item('a')]), archivedAt: now }, card('plain', null, [item('r', false, 'leaf')]), card('leaf', 'todo', [item('a')])];
  const after = before.map(c => c.id === 'leaf' || c.id === 'archived' ? { ...c, items: [item('a', true)] } : c);
  const settled = run(before, after); assert.equal(workflowStatus(settled[0]), 'todo'); assert.equal(workflowStatus(settled[1]), null); assert.equal(settled[1].items[0].done, true);
});
test('disabled and explicitly removed defaults stay disabled', () => {
  const before = card('a', 'todo', [item('a')]);
  for (const automations of [[], rulesOf(WORKFLOW_LABELS[2]).map(r => ({ ...r, enabled: false }))]) {
    const labels = WORKFLOW_LABELS.map(l => l.id === 'workflow:done' ? { ...l, automations } : l);
    assert.equal(workflowStatus(run([before], [{ ...before, items: [item('a', true)] }], labels)[0]), 'todo');
  }
});
test('custom add/remove actions use pre-change scopes and do not chain', () => {
  const rules = [{ id: 'add', condition: 'complete', scope: 'owner', action: 'add', target: 'ready', enabled: true }, { id: 'remove', condition: 'complete', scope: 'owner', action: 'remove', target: 'old', enabled: true }];
  const labels = [...WORKFLOW_LABELS, { id: 'project', name: 'Project', color: '#123456', automations: rules }, { id: 'ready', name: 'Ready', color: '#123456', automations: [{ ...rules[0], id: 'chain', target: 'chained' }] }, { id: 'old', name: 'Old', color: '#123456' }, { id: 'chained', name: 'Chained', color: '#123456' }];
  const before = { ...card('a', null, [item('a')]), labels: ['project', 'old'] };
  const after = run([before], [{ ...before, items: [item('a', true)] }], labels)[0];
  assert.deepEqual(after.labels, ['project', 'ready']);
});
test('custom groups are exclusive, other groups survive, last selection wins', () => {
  const labels = [...WORKFLOW_LABELS, { id: 'low', group: 'Priority' }, { id: 'high', group: 'Priority' }, { id: 'work' }];
  assert.deepEqual(groupedLabels(['workflow:todo', 'low', 'work', 'workflow:doing', 'high'], labels), ['work', 'workflow:doing', 'high']);
});
test('conflicting group rules are deterministic and evaluated only once', () => {
  const a = { id: 'a', name: 'A', color: '#123456', group: 'Priority', automations: [{ id: '1', scope: 'owner', condition: 'complete', action: 'set-group', target: 'b', enabled: true }, { id: '2', scope: 'owner', condition: 'complete', action: 'set-group', target: 'a', enabled: true }] };
  const b = { id: 'b', name: 'B', color: '#123456', group: 'Priority' };
  const before = { ...card('one', null, [item('i')]), labels: ['a'] };
  for (const labels of [[a, b], [b, a]]) assert.deepEqual(run([before], [{ ...before, items: [item('i', true)] }], labels)[0].labels, ['b']);
});
test('missing target or scope labels are skipped safely', () => {
  const label = { id: 'custom', name: 'Custom', color: '#123456', automations: [{ id: '1', condition: 'complete', scope: 'owner', action: 'add', target: 'missing', enabled: true }, { id: '2', condition: 'complete', scope: 'label:missing', action: 'add', target: 'custom', enabled: true }] };
  const before = { ...card('one', null, [item('i')]), labels: ['custom'] };
  assert.deepEqual(run([before], [{ ...before, items: [item('i', true)] }], [label])[0].labels, ['custom']);
});
test('legacy cycles and missing children terminate without mutation', () => {
  const cards = [card('a', 'todo', [item('r', false, 'b')]), card('b', 'todo', [item('r', false, 'a')]), card('c', 'todo', [item('r', false, 'missing')])];
  assert.doesNotThrow(() => run([], cards));
  assert.doesNotThrow(() => run([card('missing')], cards));
  const before = structuredClone(cards); run([], cards); assert.deepEqual(cards, before);
});
test('new circular links are refused by the shared merge', () => {
  const state = stateFromCards([card('a', 'todo', [item('r', false, 'b')]), card('b')]);
  applyAction(state, { id: 'loop', ts: now, deviceId: 'x', type: 'item.put', payload: { cardId: 'b', item: item('r', false, 'a') } });
  assert.equal(state.cards.b.items.length, 0);
});
test('label behavior survives sync, older clients, disabling, and restore', () => {
  const state = emptyState();
  const label = { id: 'l', name: 'L', color: '#123456', group: 'Priority', automations: [{ id: 'r', condition: 'complete', scope: 'owner', action: 'add', target: 'l', enabled: true }] };
  for (const a of diffLabels([], [label], now, 'A')) applyAction(state, a);
  assert.equal(state.labels.l.group, 'Priority'); assert.deepEqual(state.labels.l.automations, label.automations);
  applyAction(state, { id: 'old', ts: '2026-10-12T10:00:01.000Z', deviceId: 'old', type: 'label.put', payload: { label: { id: 'l', name: 'Renamed', color: '#123456' } } });
  assert.deepEqual(state.labels.l.automations, label.automations);
  for (const a of diffLabels([state.labels.l], [{ ...state.labels.l, automations: [], group: null }], '2026-10-12T10:00:02.000Z', 'A')) applyAction(state, a);
  assert.deepEqual(state.labels.l.automations, []); assert.equal(state.labels.l.group, undefined);
  assert.deepEqual(cleanBehavior({ automations: [null, { id: 'bad' }, ...label.automations, ...label.automations] }).automations, label.automations);
});
test('long dependency chains settle without repeated rule evaluation', () => {
  const before = Array.from({ length: 250 }, (_, n) => card(String(n), 'todo', [item('r', false, n < 249 ? String(n + 1) : undefined)]));
  const after = before.map((c, n) => n === 249 ? { ...c, items: [item('r', true)] } : c);
  assert.ok(status(run(before, after)).every(s => s === 'done'));
});
