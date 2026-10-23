// §4.5 first-launch seed. The seven demo cards live in fixtures/board.json (§16).

import type { Card, CardItem } from './types';

export function welcomeCard(order: number, nowIso?: string, id = 'welcome'): Card {
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const iso = new Date(now).toISOString();
  return {
    id,
    title: 'Welcome. Tap me.',
    notes: 'This is your board. Type below to add anything. Checklists move themselves as you check things off.',
    status: 'todo',
    items: [
         { id: id + '-1', text: 'Check this item (it moves to Doing)', done: false },
         { id: id + '-2', text: 'Check this one too (all done \u2192 Done)', done: false },
         { id: id + '-3', text: 'Delete this card whenever you like', done: false },
       ] as CardItem[],
    order,
    createdAt: iso,
    updatedAt: iso,
    completedAt: null,
    archivedAt: null,
    someday: false, repeat: false, labels: [],
     };
}
