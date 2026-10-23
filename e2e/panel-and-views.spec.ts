// Journey 17 (§13): selection survives the view switch; and cards moved from the panel fly under it.
import { boardCard, desktopOnly, expect, K, noteCard, openFromBoard, openView, panel, scope, test } from './journeys';

test('17. selection survives the view switch: panel, caret and scroll are untouched', async ({ app }) => {
  desktopOnly();
  await openFromBoard(app, 'd1', 'doing');
  const add = panel(app).getByTestId('detail-add-items');
  await add.click();
  await add.pressSequentially('half typed');
  await add.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(4, 4));
  const scroller = panel(app).locator('.dt-scroll');
  const scrolled = await scroller.evaluate((s) => {
    s.scrollTop = Math.min(40, s.scrollHeight - s.clientHeight);
    return s.scrollTop;
  });
  await panel(app).evaluate((n) => ((n as any).__same = true));

  await app.getByTestId('view-notes').click();
  await expect(app.locator('.pane-notes')).not.toHaveAttribute('inert', '');
  await expect(panel(app)).toBeVisible();
  await expect(noteCard(app, 'd1')).toHaveClass(/open/);
  await app.getByTestId('view-board').click();
  await expect(app.locator('.pane-board')).not.toHaveAttribute('inert', '');

  expect(await panel(app).evaluate((n) => (n as any).__same)).toBe(true); // never closed, never remounted
  await expect(panel(app).getByTestId('detail-add-items')).toHaveValue('half typed');
  expect(await panel(app).getByTestId('detail-add-items').evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(4);
  expect(await scroller.evaluate((s) => s.scrollTop)).toBe(scrolled);
  await expect(boardCard(app, 'd1')).toHaveClass(/(open|selected)/);
  expect(K('x')).toBe('v6-x');
});

test('a card moved from the panel flies under the panel, never over it', async ({ app }) => {
  desktopOnly();
  await openFromBoard(app, 't2', 'todo');
  const sampling = app.evaluate(
    () =>
      new Promise<{ overlaps: number; over: number }>((resolve) => {
        let overlaps = 0;
        let over = 0;
        const t0 = performance.now();
        const tick = () => {
          const p = document.querySelector('.dt-panel')?.getBoundingClientRect();
          for (const w of document.querySelectorAll('.move-wrap')) {
            const r = w.getBoundingClientRect();
            const l = Math.max(r.left, p!.left), rt = Math.min(r.right, p!.right);
            const t = Math.max(r.top, p!.top), b = Math.min(r.bottom, p!.bottom);
            if (rt - l < 4 || b - t < 4) continue;
            overlaps++;
            (w as HTMLElement).style.pointerEvents = 'auto'; // the flight ignores the mouse; let hit-testing see it
            if (!document.elementFromPoint((l + rt) / 2, (t + b) / 2)?.closest('.dt-panel')) over++;
            (w as HTMLElement).style.pointerEvents = '';
          }
          if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
          else resolve({ overlaps, over });
        };
        tick();
      }),
  );
  await panel(app).getByRole('radio', { name: 'Done', exact: true }).click();
  const { overlaps, over } = await sampling;
  expect(overlaps).toBeGreaterThan(0); // the flight did cross the panel
  expect(over).toBe(0);
});
