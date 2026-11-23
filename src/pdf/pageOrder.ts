/**
 * Reordering the pages of a reading-order PDF before imposition, and inserting blank pages. Pure
 * index juggling: `pageOrder[i]` is what book page i + 1 is — the PDF page (0-based) read there,
 * or `null` for a blank page the user inserted (no page is added to the PDF). Every lookup goes
 * through `pageSource`, so the 2D sheets, the 3D model, the export and bug reports agree.
 */

/** A book page: the PDF page (0-based) it shows, or `null` for an inserted blank. */
export type PageEntry = number | null;

/**
 * `order` normalised for a PDF of `n` pages: blanks (`null`) kept where they are, valid PDF pages
 * in their order (repeats and invalid entries dropped), then the missing pages ascending (the same
 * rule as the proofed sheet order). Every PDF page appears exactly once.
 */
export function pageEntries(order: readonly PageEntry[] | undefined, n: number): PageEntry[] {
  const seen = new Set<number>();
  const out: PageEntry[] = [];
  for (const v of order ?? []) {
    if (v === null) out.push(null);
    else if (Number.isInteger(v) && v >= 0 && v < n && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
  return out;
}

/** Pages in the book: the PDF's pages plus the inserted blanks. */
export const bookLength = (order: readonly PageEntry[] | undefined, n: number) =>
  pageEntries(order, n).length;

/** Whether `order` is the PDF's own order (nothing moved, no blanks). */
export function inPageOrder(order: readonly PageEntry[] | undefined, n: number): boolean {
  const e = pageEntries(order, n);
  return e.length === n && e.every((v, i) => v === i);
}

/** `order` stored as the app keeps it: `undefined` when it is the PDF's own order. */
export const storedOrder = (order: readonly PageEntry[], n: number): PageEntry[] | undefined =>
  inPageOrder(order, n) ? undefined : pageEntries(order, n);

/** PDF pages read out of their own order (ignoring blanks, which only shift the numbering). */
export function movedCount(order: readonly PageEntry[] | undefined, n: number): number {
  return pageEntries(order, n)
    .filter((v): v is number => v !== null)
    .filter((v, k) => v !== k).length;
}

/**
 * Book page (1-based) → the PDF page (1-based) that supplies it, for a PDF of `n` pages; `null`
 * for an inserted blank and for pages past the book (blanks the plan adds).
 */
export function pageSource(
  order: readonly PageEntry[] | undefined,
  n: number,
): (page: number) => number | null {
  const e = pageEntries(order, n);
  return (page) => {
    if (!Number.isInteger(page) || page < 1 || page > e.length) return null;
    const v = e[page - 1]!;
    return v === null ? null : v + 1;
  };
}

/** Valid, distinct indices of `n`, ascending. */
const picked = (indices: Iterable<number>, n: number) =>
  [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < n).sort((a, b) => a - b);

export interface Moved {
  /** The new order (normalised: every PDF page once, blanks where they are). */
  order: PageEntry[];
  /** Where the affected pages are now (book indices, ascending): the selection afterwards. */
  at: number[];
}

/**
 * Move the book pages at indices `indices` (any set, not necessarily adjacent; blanks too) to the
 * gap `gap` (0 = before the first page, length = after the last, counted in the current order), as
 * one block in their relative order; the others close up around it.
 */
export function movePages(
  order: readonly PageEntry[] | undefined,
  n: number,
  indices: Iterable<number>,
  gap: number,
): Moved {
  const all = pageEntries(order, n);
  const len = all.length;
  const sel = picked(indices, len);
  if (sel.length === 0) return { order: all, at: [] };
  const g = Math.max(0, Math.min(len, Math.round(gap)));
  const chosen = new Set(sel);
  const block = sel.map((i) => all[i]!);
  const rest = all.filter((_, i) => !chosen.has(i));
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
  order: readonly PageEntry[] | undefined,
  n: number,
  indices: Iterable<number>,
  dir: -1 | 1,
): Moved {
  const all = pageEntries(order, n);
  const len = all.length;
  const sel = new Array<boolean>(len).fill(false);
  for (const i of picked(indices, len)) sel[i] = true;
  const swap = (a: number, b: number) => {
    [all[a], all[b]] = [all[b]!, all[a]!];
    [sel[a], sel[b]] = [sel[b]!, sel[a]!];
  };
  if (dir < 0) {
    for (let i = 1; i < len; i++) if (sel[i] && !sel[i - 1]) swap(i, i - 1);
  } else {
    for (let i = len - 2; i >= 0; i--) if (sel[i] && !sel[i + 1]) swap(i, i + 1);
  }
  return { order: all, at: sel.flatMap((s, i) => (s ? [i] : [])) };
}

/**
 * Insert `count` blank pages before (`'before'`) the first selected page or after the last one;
 * with nothing selected, at the start or the end of the book. The new blanks are the selection.
 */
export function insertBlanks(
  order: readonly PageEntry[] | undefined,
  n: number,
  indices: Iterable<number>,
  where: 'before' | 'after',
  count = 1,
): Moved {
  const all = pageEntries(order, n);
  const sel = picked(indices, all.length);
  const k = Math.max(0, Math.floor(count));
  const at =
    where === 'before' ? (sel.length ? sel[0]! : 0) : sel.length ? sel.at(-1)! + 1 : all.length;
  all.splice(at, 0, ...new Array<PageEntry>(k).fill(null));
  return { order: all, at: Array.from({ length: k }, (_, i) => at + i) };
}

/**
 * Remove the blanks among the book pages at `indices` (PDF pages there stay: they cannot be
 * removed). The PDF pages that were selected stay selected.
 */
export function removeBlanks(
  order: readonly PageEntry[] | undefined,
  n: number,
  indices: Iterable<number>,
): Moved {
  const all = pageEntries(order, n);
  const sel = new Set(picked(indices, all.length));
  const out: PageEntry[] = [];
  const at: number[] = [];
  all.forEach((v, i) => {
    if (sel.has(i) && v === null) return;
    if (sel.has(i)) at.push(out.length);
    out.push(v);
  });
  return { order: out, at };
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
