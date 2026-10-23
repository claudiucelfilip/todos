// §4.4 search: case- and diacritic-insensitive over title, notes, items; the
// highlight helper maps a folded match back to the original text. Run: `npm run test:search`.
import { searchMatches, foldText, findMatch } from '../src/lib/search';
import type { Card } from '../src/lib/types';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const card = (title: string, notes = '', items: string[] = []): Card => ({
  id: 'c', title, notes, status: 'todo', order: 0, items: items.map((t, i) => ({ id: 'i' + i, text: t, done: false })),
  createdAt: '', updatedAt: '', completedAt: null, archivedAt: null, someday: false, repeat: false, labels: [],
});

check('matches ignore case', searchMatches(card('Groceries'), 'GROC'));
check('matches ignore diacritics in the card', searchMatches(card('Café crème'), 'cafe creme'));
check('matches ignore diacritics in the query', searchMatches(card('Cafe'), 'Café'));
check('matches items and notes', searchMatches(card('x', 'buy pâté', []), 'pate') && searchMatches(card('x', '', ['Ölçü']), 'olcu'));
check('no match', !searchMatches(card('Groceries'), 'zzz'));
check('foldText strips marks and lowercases', foldText('Élan Vitàl') === 'elan vital', foldText('Élan Vitàl'));
const m = findMatch('Café crème brûlée', 'creme');
check('findMatch returns original-text indices', !!m && 'Café crème brûlée'.slice(m.start, m.end) === 'crème', JSON.stringify(m));
check('findMatch returns null on no hit', findMatch('abc', 'zz') === null);

const L = [{ id: 'w', name: 'Wörk', color: '#111111' }, { id: 's', name: 'Sherlock', color: '#7C5CFF' }];
const tagged = { ...card('Plan'), labels: ['w'] };
check('#label matches cards with that label (folded, prefix)', searchMatches(tagged, '#work', L) && searchMatches(tagged, '#wo', L));
check('#label does not match cards without it', !searchMatches(card('Plan'), '#work', L) && !searchMatches(tagged, '#sherlock', L));
check('#text still matches literal text', searchMatches(card('Issue #42'), '#42', L));
check('#label combines with a status prefix', searchMatches(tagged, 'todo: #work', L) && !searchMatches(tagged, 'done: #work', L));

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
