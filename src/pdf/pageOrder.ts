/**
 * Reordering the pages of a reading-order PDF before imposition. Pure index juggling: `pageOrder[i]`
 * is the PDF page (0-based) read as book page i + 1. Every lookup goes through `pageSource`, so the
 * 2D sheets, the 3D model and the export agree.
 */

/**
 * `order` as a permutation of 0 … n−1: valid entries in their order (repeats dropped), then the
 * missing ones ascending.
 */
export function pagePermutation(order: readonly number[] | undefined, n: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of order ?? []) {
    if (Number.isInteger(v) && v >= 0 && v < n && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
  return out;
}

/** Whether `order` is the PDF's own order (nothing moved). */
export function inPageOrder(order: readonly number[] | undefined, n: number) {
  return pagePermutation(order, n).every((v, i) => v === i);
}

/**
 * Book page (1-based) → the PDF page (1-based) that supplies it, for a PDF of `n` pages. Pages past
 * the PDF (blanks the plan adds) map to themselves, so callers keep treating them as missing.
 */
export function pageSource(
  order: readonly number[] | undefined,
  n: number,
): (page: number) => number {
  if (!order || order.length === 0) return (page) => page;
  const perm = pagePermutation(order, n);
  return (page) => (page >= 1 && page <= n ? perm[page - 1]! + 1 : page);
}

/** Valid, distinct indices of `n`, ascending. */
const picked = (indices: Iterable<number>, n: number) =>
  [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);

export interface Moved {
  /** The new order. */
  order: number[];
  /** Where the moved pages are now (book indices, ascending): the selection after the move. */
  at: number[];
}

/**
 * Move the pages at book indices `indices` (any set, not necessarily adjacent) to the gap `gap`
 * (0 = before the first page, n = after the last, counted in the current order), as one block in
 * their relative order; the others close up around it.
 */
export function movePages(
  order: readonly number[] | undefined,
  n: number,
  indices: Iterable<number>,
  gap: number,
): Moved {
  const perm = pagePermutation(order, n);
  const sel = picked(indices, n);
  if (sel.length === 0) return { order: perm, at: [] };
  const g = Math.max(0, Math.min(n, Math.round(gap)));
  const chosen = new Set(sel);
  const block = sel.map((i) => perm[i]!);
  const rest = perm.filter((_, i) => !chosen.has(i));
  // The gap among the pages that stay: those before it that are not moving.
  const insertAt = sel.reduce((k, i) => (i < g ? k - 1 : k), g);
  rest.splice(insertAt, 0, ...block);
  return { order: rest, at: block.map((_, k) => insertAt + k) };
}

/**
 * Move each selected page one place earlier (`-1`) or later (`+1`), past the nearest page that is
 * not selected; pages already bunched at that end stay. The selection keeps its relative order.
 */
export function stepPages(
  order: readonly number[] | undefined,
  n: number,
  indices: Iterable<number>,
  dir: -1 | 1,
): Moved {
  const perm = pagePermutation(order, n);
  const sel = new Array<boolean>(n).fill(false);
  for (const i of picked(indices, n)) sel[i] = true;
  const swap = (a: number, b: number) => {
    [perm[a], perm[b]] = [perm[b]!, perm[a]!];
    [sel[a], sel[b]] = [sel[b]!, sel[a]!];
  };
  if (dir < 0) {
    for (let i = 1; i < n; i++) if (sel[i] && !sel[i - 1]) swap(i, i - 1);
  } else {
    for (let i = n - 2; i >= 0; i--) if (sel[i] && !sel[i + 1]) swap(i, i + 1);
  }
  return { order: perm, at: sel.flatMap((s, i) => (s ? [i] : [])) };
}

/**
 * A click on page `i` of a selection: plain picks it alone, `toggle` (Cmd/Ctrl) adds or removes it,
 * `range` (Shift) selects from the anchor to it (added to the rest with `toggle` too).
 */
export function selectPages(
  selected: readonly number[],
  anchor: number | null,
  i: number,
  how: { range?: boolean; toggle?: boolean },
): { selected: number[]; anchor: number } {
  if (how.range && anchor !== null) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
    const span = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    const base = how.toggle ? selected : [];
    return { selected: picked([...base, ...span], Infinity), anchor };
  }
  if (how.toggle) {
    const has = selected.includes(i);
    return {
      selected: has ? selected.filter((x) => x !== i) : picked([...selected, i], Infinity),
      anchor: i,
    };
  }
  return { selected: [i], anchor: i };
}
