import type { Locator, Page } from '@playwright/test';
import { test, expect, isPhone, K, boardCard, noteCard, openColumn, openView, toast } from './journeys';

async function dragOnto(page: Page, source: Locator, target: Locator, cancel = false, outside = false, edge = false) {
  await source.evaluate(async el => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      await Promise.all(node.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
    }
  });
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const start = { x: from.x + Math.min(80, from.width / 2), y: from.y + 20 };
  const end = { x: to.x + to.width / 2, y: to.y + (edge ? to.height - 4 : to.height / 2) };
  if (isPhone()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
    await page.waitForTimeout(450);
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 12, y: start.y + (end.y - start.y) * i / 12, id: 1 }] });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(700);
    if (outside) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 40, y: 40, id: 1 }] });
      await page.waitForTimeout(100);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, start.y + 12, { steps: 3 });
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.waitForTimeout(700);
    if (outside) {
      await page.mouse.move(40, 40);
      await page.waitForTimeout(100);
    }
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
}

for (const view of ['board', 'notes'] as const) {
  test(`${view}: drag a todo into another checklist, undo it, and retain it after reload`, async ({ app, api }) => {
    test.skip(view === 'notes' && isPhone(), 'Notes touch arrangement is not supported');
    await openView(app, view);
    await openColumn(app, 'todo');
    const source = view === 'board' ? boardCard(app, 't1') : noteCard(app, 't1');
    const target = view === 'board' ? boardCard(app, 't2') : noteCard(app, 't2');
    const original = (await api.cards()).find(c => c.id === K('t1'));
    const targetBefore = (await api.cards()).find(c => c.id === K('t2'));
    await dragOnto(app, source, target);
    await expect.poll(async () => (await api.cards()).find(c => c.id === K('t2')).items.filter((i: any) => i.ref === K('t1')).length).toBe(1);
    await expect(toast(app)).toContainText('Renew passport');
    await app.getByTestId('toast-undo').click();
    await expect.poll(async () => (await api.cards()).find(c => c.id === K('t2')).items).toEqual(targetBefore.items);
    await dragOnto(app, source, target);
    await expect.poll(async () => (await api.cards()).find(c => c.id === K('t2')).items.some((i: any) => i.ref === K('t1'))).toBe(true);
    await app.reload();
    await openView(app, view);
    await expect(target).toContainText('Renew passport');
    expect((await api.cards()).find(c => c.id === K('t1'))).toEqual(original);
    await dragOnto(app, source, target);
    expect((await api.cards()).find(c => c.id === K('t2')).items.filter((i: any) => i.ref === K('t1'))).toHaveLength(1);
  });
}

test('notes: drag a note into a note; cyclic and cancelled drops leave checklists unchanged', async ({ app, api }) => {
  test.skip(isPhone(), 'Notes touch arrangement is not supported');
  await openView(app, 'notes');
  await dragOnto(app, noteCard(app, 'n0'), noteCard(app, 'n2'));
  await expect.poll(async () => (await api.cards()).find(c => c.id === K('n2')).items.some((i: any) => i.ref === K('n0'))).toBe(true);
  const before = (await api.cards()).map(c => ({ id: c.id, items: c.items }));
  await dragOnto(app, noteCard(app, 'n8'), noteCard(app, 'n14'));
  expect((await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
  await dragOnto(app, noteCard(app, 'n3'), noteCard(app, 'n2'), true);
  expect((await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
});


test('board: cancelled drops and dropping a card onto itself do not add checklist rows', async ({ app, api }) => {
  await openView(app, 'board');
  await openColumn(app, 'todo');
  const before = (await api.cards()).map(c => ({ id: c.id, items: c.items }));
  await dragOnto(app, boardCard(app, 't1'), boardCard(app, 't2'), true);
  await expect.poll(async () => (await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
  await dragOnto(app, boardCard(app, 't1'), boardCard(app, 't2'), false, true);
  expect((await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
  await dragOnto(app, boardCard(app, 't1'), boardCard(app, 't1'));
  expect((await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
});


for (const [child, parent] of [['n0', 't2'], ['t1', 'n2']] as const) {
  test(`notes: mixed card types ${child} into ${parent} retain their content`, async ({ app, api }) => {
    test.skip(isPhone(), 'Notes touch arrangement is not supported');
    await openView(app, 'notes');
    const sourceBefore = (await api.cards()).find(c => c.id === K(child));
    await dragOnto(app, noteCard(app, child), noteCard(app, parent));
    await expect.poll(async () => (await api.cards()).find(c => c.id === K(parent)).items.some((i: any) => i.ref === K(child))).toBe(true);
    expect((await api.cards()).find(c => c.id === K(child))).toMatchObject({
      title: sourceBefore.title,
      notes: sourceBefore.notes,
      items: sourceBefore.items,
    });
  });
}


test('board: dropping at a card edge still reorders without nesting', async ({ app, api }) => {
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await dragOnto(app, boardCard(app, 't1'), boardCard(app, 't2'), false, false, true);
  await expect.poll(async () => {
    const cards = await api.cards();
    return cards.find(c => c.id === K('t1')).order > cards.find(c => c.id === K('t2')).order;
  }).toBe(true);
  expect((await api.cards()).find(c => c.id === K('t2')).items.some((i: any) => i.ref === K('t1'))).toBe(false);
});

test('notes: an edge drop still arranges cards without nesting', async ({ app, api }) => {
  test.skip(isPhone(), 'Notes touch arrangement is not supported');
  await openView(app, 'notes');
  const before = (await api.cards()).map(c => ({ id: c.id, items: c.items }));
  await dragOnto(app, noteCard(app, 't1'), noteCard(app, 't2'), false, false, true);
  await expect.poll(async () => {
    const cards = await api.cards();
    return cards.find(c => c.id === K('t1')).layout?.order > cards.find(c => c.id === K('t2')).layout?.order;
  }).toBe(true);
  expect((await api.cards()).map(c => ({ id: c.id, items: c.items }))).toEqual(before);
});
