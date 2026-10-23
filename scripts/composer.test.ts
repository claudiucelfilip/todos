import assert from 'node:assert/strict';
import { parseComposerDraft } from '../src/lib/composer-parse';
import { trailingChecklist } from '../src/lib/trailing-checklist';

const labels = [{ id: 'home', name: 'Home', color: '#2E9E6B' }];
const now = new Date(2026, 9, 2, 12, 30);
const parse = (text: string, dismissed: string[] = []) => parseComposerDraft(text, labels, dismissed, now);
const source = 'Book the Sintra train tomorrow 9:00 #HOME\nCheck timetable\nBuy tickets';
const draft = parse(source);
assert.equal(draft.title, 'Book the Sintra train');
assert.deepEqual(draft.labels, ['home']);
assert.deepEqual(draft.body, ['Check timetable', 'Buy tickets']);
assert.equal(draft.remindAt, new Date(2026, 9, 3, 9).toISOString());
assert.equal(source, 'Book the Sintra train tomorrow 9:00 #HOME\nCheck timetable\nBuy tickets');

for (const title of ["Review today's plan", 'Review today’s plan', 'Review today plan', 'Write the weekly review', 'Write every day', 'Keep #unknown', 'tomorrow 25:00 Review', 'today 12:99 Call']) {
  assert.equal(parse(title).title, title, `ordinary title stays intact: ${title}`);
  assert.equal(parse(title).remindAt, null);
}
assert.equal(parse('Tomorrow review the plan').title, 'review the plan');
assert.equal(parse('Review tomorrow').remindAt, new Date(2026, 9, 3, 9).toISOString());
assert.equal(parse('Review monday').remindAt, new Date(2026, 9, 5, 9).toISOString());
assert.equal(parse('Review friday').remindAt, new Date(2026, 9, 9, 9).toISOString());
assert.equal(parse('Review tomorrow 23:59').remindAt, new Date(2026, 9, 3, 23, 59).toISOString());
assert.equal(parse('Review tomorrow 9:00 every weekday').remindEvery, 'weekday');
assert.equal(parse('Review tomorrow 9:00 weekly').remindEvery, 'week');
const time = draft.tokens.find(t => t.kind === 'time')!;
const optedOut = parse(source, [time.key]);
assert.equal(optedOut.title, 'Book the Sintra train tomorrow 9:00');
assert.equal(optedOut.remindAt, null);
assert.equal(parse('Please ' + source, [time.key]).remindAt, null, 'dismissal survives edits before the token');
const repeating = parse('Review tomorrow 9:00 weekly');
const repeatToken = repeating.tokens.find(t => t.kind === 'repeat')!;
assert.equal(parse('Review tomorrow 9:00 weekly', [repeatToken.key]).title, 'Review weekly');
assert.equal(parse('Review tomorrow 9:00 weekly', [repeatToken.key]).remindEvery, null);
const labelToken = draft.tokens.find(t => t.kind === 'label')!;
assert.deepEqual(parse(source, [labelToken.key]).labels, []);
assert.equal(parse(source, [labelToken.key]).title, 'Book the Sintra train #HOME');
assert.deepEqual(parse('Please ' + source, [labelToken.key]).labels, [], 'label dismissal survives prefix edits');
// 12-hour times (e2e journeys 2 and 3).
const vet = parse('Call the vet tomorrow 9am #home');
assert.equal(vet.title, 'Call the vet');
assert.equal(new Date(vet.remindAt!).getHours(), 9);
assert.equal(new Date(parse('Dentist Friday 3pm').remindAt!).getHours(), 15);
const gym = new Date(parse('Gym tomorrow at 7:30 pm').remindAt!);
assert.equal(`${gym.getHours()}:${gym.getMinutes()}`, '19:30');
assert.equal(new Date(parse('Late call today 12am').remindAt!).getHours(), 0);
// Audit: a leading 'Sun' / 'Wed' is a word; 'tonight' is evening and never in the past.
for (const title of ['Sun lotion', 'Wed dress fitting', 'Sat nav update']) {
  assert.equal(parse(title).title, title, `stays a word: ${title}`);
  assert.equal(parse(title).remindAt, null);
}
assert.equal(new Date(parse('Laundry sun').remindAt!).getDay(), 0);
assert.equal(new Date(parse('Call mum tonight').remindAt!).getHours(), 20);
assert.equal(new Date(parse('Call mum tonight 9:30').remindAt!).getHours(), 21);
const late = new Date(2026, 9, 2, 22, 40);
const lateTonight = new Date(parseComposerDraft('Call mum tonight', labels, [], late).remindAt!);
assert.ok(lateTonight > late, 'tonight after 20:00 is still in the future');
assert.equal(lateTonight.getHours(), 23);
assert.ok(new Date(parseComposerDraft('Water plants today', labels, [], late).remindAt!) > late, 'bare today is never past');
console.log('Composer parsing: all regressions passed.');

// Final lists can become checklist rows without flattening a document.
assert.deepEqual(trailingChecklist('Context\n\n- First\n- [x] Second\n- '), {
  notes: 'Context', items: [{text: 'First', done: false}, {text: 'Second', done: true}],
});
assert.deepEqual(trailingChecklist('1. First\n2) Second'), {
  notes: '', items: [{text: 'First', done: false}, {text: 'Second', done: false}],
});
const readme = '# Project\n\n- Overview\n- Setup\n\n## Next steps\n\n* Ship [docs](https://example.test)\n+ Test **offline**';
assert.equal(trailingChecklist(readme)?.notes, '# Project\n\n- Overview\n- Setup\n\n## Next steps');
assert.equal(trailingChecklist(readme)?.items[0].text, 'Ship [docs](https://example.test)');
for (const text of [
  '- Item\nMore text', '- Parent\n  - Child', '- Parent\n  - Child\n- Sibling', '- Parent\n  - Child\n\n- Sibling',
  '```md\n- Example\n```', '~~~md\n- Example', '    - Indented code',
  '> - Quoted list', '- ', '- \n- Not finished', '- ' + 'x'.repeat(1001),
]) assert.equal(trailingChecklist(text), null, `keep structured or unfinished text: ${text}`);
assert.deepEqual(trailingChecklist('```sh\n- example\n```\n\n• Actual task')?.items, [{text: 'Actual task', done: false}]);
console.log('Trailing-list conversion preserves structured Markdown');

assert.equal(trailingChecklist('- First\n\n- Second')?.items.length, 2);
