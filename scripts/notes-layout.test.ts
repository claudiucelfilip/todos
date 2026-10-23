import assert from 'node:assert/strict';
import { masonryLayout, fillMasonryGaps, snappedWidth } from '../src/lib/notes-layout';

const items = Array.from({ length: 24 }, (_, i) => ({ id: String(i), width: 230, height: 100 + (i % 5) * 40 }));
const original = masonryLayout(items, 980, 20);
const target = original.get('3')!;
for (const width of [230, 270, 410, 480, 620, 980]) {
  const left = Math.min(target.left, 980 - width);
  const resized = items.map(item => item.id === '3' ? { ...item, width, height: 330 } : item);
  const layout = masonryLayout(resized, 980, 20, { id: '3', left, top: target.top });
  assert.equal(layout.size, items.length);
  assert.deepEqual(layout.get('3'), { left, top: target.top, width, height: 330 });
  const rects = [...layout.values()];
  for (const [i, a] of rects.entries()) {
    assert(a.left >= 0 && a.left + a.width <= 980 && a.top >= 0);
    for (const b of rects.slice(i + 1)) {
      assert(a.left + a.width + 20 <= b.left || b.left + b.width + 20 <= a.left || a.top + a.height + 20 <= b.top || b.top + b.height + 20 <= a.top, 'notes retain their gutter without overlap');
    }
  }
  assert.deepEqual(masonryLayout(resized, 980, 20, { id: '3', left, top: target.top }), layout, 'saved dimensions produce the same layout');
  for (const pinnedId of [undefined, '3']) {
    const expanded = [...fillMasonryGaps(layout, 980, 20, pinnedId).values()];
    for (const [i, a] of expanded.entries()) {
      assert(a.left >= 0 && a.left + a.width <= 980 && a.height > 0);
      for (const b of expanded.slice(i + 1)) assert(a.left + a.width + 20 <= b.left || b.left + b.width + 20 <= a.left || a.top + a.height + 20 <= b.top || b.top + b.height + 20 <= a.top, 'gap filling preserves gutters around every note');
    }
  }
}
const larger = masonryLayout(items.map(item => item.id === '0' ? { ...item, width: 480 } : item), 980, 20, { id: '0', left: 0, top: 0 });
assert.notDeepEqual(larger.get('1'), original.get('1'), 'neighbours make room for expansion');
assert.deepEqual(masonryLayout(items, 980, 20), original, 'cancelling restores the original packing');
console.log('Masonry resize: all checks passed');

assert.deepEqual(snappedWidth(370, 980, 4), { width: 480, span: 2 });
assert.deepEqual(snappedWidth(100, 980, 4), { width: 230, span: 1 });
assert.deepEqual(snappedWidth(1500, 980, 4), { width: 980, span: 4 });
const gaps = new Map([
  ['manual', { left: 0, top: 0, width: 230, height: 100 }],
  ['other', { left: 500, top: 0, width: 230, height: 200 }],
  ['below', { left: 0, top: 220, width: 230, height: 100 }],
]);
const filled = fillMasonryGaps(gaps, 980, 20);
assert.equal(filled.get('manual')!.width, 480, 'manual preferences may expand into a gap');
assert.equal(filled.get('manual')!.height, 200, 'short notes fill vertical gaps above the next note');
assert.equal(gaps.get('manual')!.width, 230, 'preferred sizes remain unchanged');
assert.deepEqual(fillMasonryGaps(gaps, 980, 20, 'manual').get('manual'), gaps.get('manual'), 'the actively resized note retains its snapped size');
const savedResize = fillMasonryGaps(gaps, 980, 20, 'manual');
assert.equal(savedResize.get('manual')!.height, 100, 'the last resized note can stay shorter than its neighbours');
assert.equal(savedResize.get('manual')!.width, 230, 'the last resized note can stay narrower than the available space');
assert(savedResize.get('other')!.width > gaps.get('other')!.width, 'other manually sized notes still fill remaining space');
for (const [i, a] of [...filled.values()].entries()) {
  for (const b of [...filled.values()].slice(i + 1)) assert(a.left + a.width + 20 <= b.left || b.left + b.width + 20 <= a.left || a.top + a.height + 20 <= b.top || b.top + b.height + 20 <= a.top);
}
console.log('Snapping and gap filling: all checks passed');
