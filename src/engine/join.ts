/**
 * Printing a strip too long for the paper (e.g. a long accordion) in pieces that are glued end to
 * end. Each recipe sheet is cut at its fold lines into pieces of `panels` columns; only the last
 * piece may be shorter. A piece is laid out like a recipe sheet of its own, so ganging, the
 * exporter and the marks all work on pieces unchanged.
 */
import type { Plan, Slot } from './types';

export interface Piece {
  /** Recipe sheet (strip) the piece is cut from. */
  sheet: number;
  /** Position of the piece along its strip, 0-based, and how many pieces the strip has. */
  index: number;
  of: number;
  /** First column of the strip the piece holds (front view), and how many columns it holds. */
  first: number;
  count: number;
}

export interface SplitPlan {
  /** The pieces as sheets of `panels` columns; a shorter last piece leaves columns empty. */
  plan: Plan;
  pieces: Piece[];
}

/** Columns per piece actually used: at least 1, at most the strip. */
export const piecePanels = (plan: Plan, panels: number) =>
  Math.max(1, Math.min(plan.grid.cols, Math.floor(panels) || 1));

/**
 * Cut every sheet of `plan` into pieces of `panels` columns. Front columns c of the strip go to
 * piece ⌊c / panels⌋ at column c mod panels. A back slot is in the back view (column cols − 1 − c
 * is behind front column c), and stays in the back view of its piece: behind the piece's column
 * lc it is column panels − 1 − lc, so a piece's back is its front turned over, as for any sheet.
 */
export function splitStrip(plan: Plan, panels: number): SplitPlan {
  const { cols, rows } = plan.grid;
  const k = piecePanels(plan, panels);
  const of = Math.ceil(cols / k);
  const pieces: Piece[] = [];
  const sheets: Plan['sheets'] = [];
  plan.sheets.forEach((s, sheet) => {
    const base = sheets.length;
    for (let index = 0; index < of; index++) {
      const first = index * k;
      pieces.push({ sheet, index, of, first, count: Math.min(k, cols - first) });
      sheets.push({ front: [], back: [] });
    }
    const put = (slot: Slot, side: 'front' | 'back') => {
      const c = side === 'front' ? slot.col : cols - 1 - slot.col;
      const index = Math.floor(c / k);
      const lc = c - index * k;
      sheets[base + index]![side].push({ ...slot, col: side === 'front' ? lc : k - 1 - lc });
    };
    for (const slot of s.front) put(slot, 'front');
    for (const slot of s.back) put(slot, 'back');
  });
  return { plan: { ...plan, grid: { cols: k, rows }, sheets }, pieces };
}

/** Label for a piece, e.g. "piece 2 of 4" (with the strip when there are several). */
export function pieceName(p: Piece, strips: number) {
  return `${strips > 1 ? `strip ${p.sheet + 1}, ` : ''}piece ${p.index + 1} of ${p.of}`;
}
