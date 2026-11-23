import {
  bookLength,
  inPageOrder,
  insertBlanks,
  movedCount,
  movePages,
  pageEntries,
  pageSource,
  removeBlanks,
  selectPages,
  stepPages,
  storedOrder,
} from '../src/pdf/pageOrder';

describe('page order of a reading-order PDF', () => {
  it('normalises any order to a permutation', () => {
    expect(pageEntries(undefined, 4)).toEqual([0, 1, 2, 3]);
    expect(pageEntries([3], 4)).toEqual([3, 0, 1, 2]);
    expect(pageEntries([2, 2, 9, -1, 1.5, 0], 4)).toEqual([2, 0, 1, 3]);
    expect(pageEntries([4, 1, 0, 3, 2], 4)).toEqual([1, 0, 3, 2]); // fewer pages now
    expect(inPageOrder(undefined, 3)).toBe(true);
    expect(inPageOrder([0, 1, 2], 3)).toBe(true);
    expect(inPageOrder([1, 0], 3)).toBe(false);
  });

  it('looks up each book page in the PDF, leaving pages past it alone', () => {
    const src = pageSource([2, 0, 1], 3);
    expect([1, 2, 3].map(src)).toEqual([3, 1, 2]);
    expect(src(4)).toBeNull(); // a blank the plan adds
    expect(src(0)).toBeNull();
    expect([1, 2, 3].map(pageSource(undefined, 3))).toEqual([1, 2, 3]);
    // Partial: the listed pages first, the rest in order.
    expect([1, 2, 3, 4].map(pageSource([3], 4))).toEqual([4, 1, 2, 3]);
  });

  it('moves a selection as one block, keeping its relative order', () => {
    // Pages 2 and 4 (indices 1, 3) to the very start.
    expect(movePages(undefined, 6, [3, 1], 0)).toEqual({ order: [1, 3, 0, 2, 4, 5], at: [0, 1] });
    // …to the very end.
    expect(movePages(undefined, 6, [1, 3], 6)).toEqual({ order: [0, 2, 4, 5, 1, 3], at: [4, 5] });
    // …into the gap before index 5 (between pages 5 and 6).
    expect(movePages(undefined, 6, [1, 3], 5)).toEqual({ order: [0, 2, 4, 1, 3, 5], at: [3, 4] });
    // …into a gap inside the selection: the block closes up there.
    expect(movePages(undefined, 6, [1, 3], 2)).toEqual({ order: [0, 1, 3, 2, 4, 5], at: [1, 2] });
    // A single page moved later, from an order already shuffled.
    expect(movePages([5, 4, 3, 2, 1, 0], 6, [0], 3)).toEqual({
      order: [4, 3, 5, 2, 1, 0],
      at: [2],
    });
    // Nothing (or nothing valid) selected; out-of-range gaps are clamped.
    expect(movePages(undefined, 3, [], 1)).toEqual({ order: [0, 1, 2], at: [] });
    expect(movePages(undefined, 3, [7], 1)).toEqual({ order: [0, 1, 2], at: [] });
    expect(movePages(undefined, 3, [0], 99).order).toEqual([1, 2, 0]);
  });

  it('keeps every page exactly once whatever is moved', () => {
    const n = 9;
    for (let seed = 0; seed < 200; seed++) {
      const rnd = (k: number) => (seed * 7919 + k * 104729) % 97;
      const sel = Array.from({ length: n }, (_, i) => i).filter((i) => rnd(i) % 3 === 0);
      const gap = rnd(42) % (n + 1);
      const { order, at } = movePages(undefined, n, sel, gap);
      expect([...order].sort((a, b) => a! - b!)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(at.map((i) => order[i])).toEqual(sel);
    }
  });

  it('steps a selection one place earlier or later', () => {
    expect(stepPages(undefined, 5, [2], -1)).toEqual({ order: [0, 2, 1, 3, 4], at: [1] });
    expect(stepPages(undefined, 5, [2], 1)).toEqual({ order: [0, 1, 3, 2, 4], at: [3] });
    // Scattered pages each move past their neighbour.
    expect(stepPages(undefined, 5, [1, 3], -1)).toEqual({ order: [1, 0, 3, 2, 4], at: [0, 2] });
    // Pages bunched at the start stay; the others still move.
    expect(stepPages(undefined, 5, [0, 1, 3], -1)).toEqual({
      order: [0, 1, 3, 2, 4],
      at: [0, 1, 2],
    });
    expect(stepPages(undefined, 5, [3, 4], 1)).toEqual({ order: [0, 1, 2, 3, 4], at: [3, 4] });
    expect(stepPages(undefined, 5, [0, 2], 1)).toEqual({ order: [1, 0, 3, 2, 4], at: [1, 3] });
  });

  it('selects with click, Shift-click (range) and Cmd/Ctrl-click (toggle)', () => {
    let s = selectPages([], null, 2, {});
    expect(s).toEqual({ selected: [2], anchor: 2 });
    s = selectPages(s.selected, s.anchor, 5, { range: true });
    expect(s).toEqual({ selected: [2, 3, 4, 5], anchor: 2 });
    s = selectPages(s.selected, s.anchor, 0, { range: true });
    expect(s).toEqual({ selected: [0, 1, 2], anchor: 2 });
    s = selectPages(s.selected, s.anchor, 7, { toggle: true });
    expect(s).toEqual({ selected: [0, 1, 2, 7], anchor: 7 });
    s = selectPages(s.selected, s.anchor, 1, { toggle: true });
    expect(s).toEqual({ selected: [0, 2, 7], anchor: 1 });
    s = selectPages(s.selected, s.anchor, 3, { range: true, toggle: true });
    expect(s).toEqual({ selected: [0, 1, 2, 3, 7], anchor: 1 });
    // Shift-click with nothing anchored picks just that page.
    expect(selectPages([], null, 4, { range: true })).toEqual({ selected: [4], anchor: 4 });
  });

  it('keeps inserted blanks (null) in place and every PDF page once', () => {
    expect(pageEntries([null, 1, null, 1, 0], 3)).toEqual([null, 1, null, 0, 2]);
    expect(pageEntries([null], 0)).toEqual([null]);
    expect(bookLength([null, null], 3)).toBe(5);
    expect(inPageOrder([0, 1, 2, null], 3)).toBe(false);
    expect(storedOrder([0, 1, 2], 3)).toBeUndefined();
    expect(storedOrder([null, 2], 3)).toEqual([null, 2, 0, 1]);
    // Blanks shift the numbering but move no page.
    expect(movedCount([null, 0, 1, null, 2], 3)).toBe(0);
    expect(movedCount([null, 1, 0, 2], 3)).toBe(2);
  });

  it('looks up book pages through blanks', () => {
    const src = pageSource([null, 2, null, 0], 3);
    expect([1, 2, 3, 4, 5, 6].map(src)).toEqual([null, 3, null, 1, 2, null]);
  });

  it('inserts blanks before or after the selection', () => {
    expect(insertBlanks(undefined, 4, [1, 2], 'before')).toEqual({
      order: [0, null, 1, 2, 3],
      at: [1],
    });
    expect(insertBlanks(undefined, 4, [2, 1], 'after', 2)).toEqual({
      order: [0, 1, 2, null, null, 3],
      at: [3, 4],
    });
    // Nothing selected: at the start or the end.
    expect(insertBlanks(undefined, 2, [], 'before').order).toEqual([null, 0, 1]);
    expect(insertBlanks([1, 0], 2, [], 'after')).toEqual({ order: [1, 0, null], at: [2] });
    // Next to an existing blank.
    expect(insertBlanks([null, 0], 1, [0], 'after').order).toEqual([null, null, 0]);
  });

  it('removes only the selected blanks, keeping the pages selected', () => {
    expect(removeBlanks([0, null, 1, null, 2], 3, [1, 2, 3])).toEqual({
      order: [0, 1, 2],
      at: [1],
    });
    // PDF pages cannot be removed.
    expect(removeBlanks(undefined, 3, [0, 1])).toEqual({ order: [0, 1, 2], at: [0, 1] });
    expect(removeBlanks([null, null, 0], 1, [1]).order).toEqual([null, 0]);
  });

  it('moves and steps blanks like pages', () => {
    expect(movePages([null, 0, 1, 2], 3, [0], 4)).toEqual({ order: [0, 1, 2, null], at: [3] });
    expect(movePages([0, null, 1, null, 2], 3, [1, 3], 0).order).toEqual([null, null, 0, 1, 2]);
    expect(stepPages([0, null, 1], 2, [1], 1)).toEqual({ order: [0, 1, null], at: [2] });
    expect(stepPages([0, null, 1], 2, [2], -1)).toEqual({ order: [0, 1, null], at: [1] });
  });

  it('keeps every PDF page once and every blank whatever is moved', () => {
    const order = [0, null, 1, 2, null, 3, 4, null, 5];
    const n = 6;
    for (let seed = 0; seed < 200; seed++) {
      const rnd = (k: number) => (seed * 7919 + k * 104729) % 97;
      const sel = order.map((_, i) => i).filter((i) => rnd(i) % 3 === 0);
      const { order: out, at } = movePages(order, n, sel, rnd(42) % (order.length + 1));
      expect(out).toHaveLength(order.length);
      expect(out.filter((v) => v === null)).toHaveLength(3);
      expect(out.filter((v) => v !== null).sort()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(at.map((i) => out[i])).toEqual(sel.map((i) => order[i]));
    }
  });
});
