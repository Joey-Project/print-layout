import {
  inPageOrder,
  movePages,
  pagePermutation,
  pageSource,
  selectPages,
  stepPages,
} from '../src/pdf/pageOrder';

describe('page order of a reading-order PDF', () => {
  it('normalises any order to a permutation', () => {
    expect(pagePermutation(undefined, 4)).toEqual([0, 1, 2, 3]);
    expect(pagePermutation([3], 4)).toEqual([3, 0, 1, 2]);
    expect(pagePermutation([2, 2, 9, -1, 1.5, 0], 4)).toEqual([2, 0, 1, 3]);
    expect(pagePermutation([4, 1, 0, 3, 2], 4)).toEqual([1, 0, 3, 2]); // fewer pages now
    expect(inPageOrder(undefined, 3)).toBe(true);
    expect(inPageOrder([0, 1, 2], 3)).toBe(true);
    expect(inPageOrder([1, 0], 3)).toBe(false);
  });

  it('looks up each book page in the PDF, leaving pages past it alone', () => {
    const src = pageSource([2, 0, 1], 3);
    expect([1, 2, 3].map(src)).toEqual([3, 1, 2]);
    expect(src(4)).toBe(4); // a blank the plan adds
    expect(src(0)).toBe(0);
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
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
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
});
