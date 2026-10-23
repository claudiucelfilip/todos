import { expect, test, K, openView, noteCard, pushActions, setFields, isPhone, openLabels } from './journeys';

test('short saved cards preserve full titles and footers without overlapping their neighbours', async ({app,account},testInfo) => {
  await pushActions(account,[setFields(K('x1'),{title:'Reparat poarta de la intrare',labels:['workflow:todo'],layout:{order:3,w:1,h:1,height:97}})]);
  await app.reload(); await openView(app,'notes');
  const card=noteCard(app,'x1');
  await card.scrollIntoViewIfNeeded();
  const verify=async () => {
    await expect.poll(() => card.evaluate(el => {
      const main=el.querySelector('.note-main')!.getBoundingClientRect(),title=el.querySelector('.note-title')!.getBoundingClientRect(),foot=el.querySelector('.note-foot')!.getBoundingClientRect(),card=el.getBoundingClientRect();
      return {titleFits:main.height>=title.height,titleAboveFooter:title.bottom<=foot.top,footerFits:foot.bottom<=card.bottom};
    })).toEqual({titleFits:true,titleAboveFooter:true,footerFits:true});
  };
  await verify();
  await app.screenshot({path:testInfo.outputPath('complete-note-title.png')});
  if(!isPhone()) {
    const handle=card.getByRole('button',{name:/Resize Reparat/});
    await handle.press('ArrowUp'); await verify();
    for (const width of [1100,1920,1440]) {await app.setViewportSize({width,height:900}); await verify();}
    const overlap=await app.locator('.pane:not([inert]) .notes-grid .note-card').evaluateAll(els => {
      const boxes=els.map(el=>el.getBoundingClientRect());
      return boxes.some((a,i)=>boxes.some((b,j)=>i<j && a.left<b.right-1 && a.right>b.left+1 && a.top<b.bottom-1 && a.bottom>b.top+1));
    });
    expect(overlap).toBe(false);
  }
  await app.reload(); await openView(app,'notes'); await verify();
});

test('completed notes strike the title while keeping the summary readable', async ({ app, account }, info) => {
  await pushActions(account, [setFields(K('x1'), {
    title: 'Finished note', notes: 'A summary that stays readable after completion. '.repeat(12),
    labels: ['workflow:done'], layout: { order: 0, w: 1, h: 2, height: 240 },
  })]);
  await app.reload();
  await openView(app, 'notes');
  const card = noteCard(app, 'x1');
  await expect(card).toHaveCount(0);
  await openLabels(app);
  await expect(app.getByTestId('labels-row-workflow:done')).toHaveAttribute('aria-checked', 'false');
  await expect(app.getByTestId('labels-row-workflow:todo')).toHaveAttribute('aria-checked', 'true');
  await app.getByTestId('labels-row-workflow:done').click();
  await app.keyboard.press('Escape');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/done/);
  await expect(card.locator('.note-title')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(card.locator('.note-preview')).toHaveCSS('text-decoration-line', 'none');
  await expect(card.locator('.note-preview')).toContainText('A summary that stays readable');
  await app.screenshot({ path: info.outputPath('completed-note-summary.png') });
});
