/**
 * Ganging: printing several recipe sheets ("units") side by side on one physical sheet, to be cut
 * apart after printing. Pure bookkeeping of which unit goes where; geometry lives in the PDF
 * layout and the 3D timeline.
 *
 * Unit positions are numbered row-major in the *front* view (top-left first). On the back, a unit
 * sits behind its front: our back view mirrors columns (see `backUnitColumn`).
 */
export interface Gang {
  /** Units per printed sheet across and down. */
  across: number;
  down: number;
  /**
   * 'stack' — cut and stack: one run of the job; cut the printed stack and put the piles on top of
   * each other (position 1's pile on top) to get the sheets in order.
   * 'copies' — every unit on a printed sheet is the same sheet: each print run makes
   * `across × down` copies of the piece.
   */
  order: 'stack' | 'copies';
}

export const NO_GANG: Gang = { across: 1, down: 1, order: 'stack' };

export interface UnitPlace {
  /** Printed (physical) sheet, 0-based. */
  paper: number;
  /** Unit column and row on that sheet's front. */
  col: number;
  row: number;
}

export interface GangPlan {
  gang: Gang;
  /** Units per printed sheet. */
  units: number;
  /** Printed sheets needed. */
  papers: number;
  /** Recipe sheet printed at unit (col, row) of a printed sheet, or null if that unit is empty. */
  sheetAt(paper: number, col: number, row: number): number | null;
  /** Where a recipe sheet is printed (its first copy). */
  placeOf(sheet: number): UnitPlace;
}

export function gangPlan(sheetCount: number, gang: Gang): GangPlan {
  const across = Math.max(1, Math.floor(gang.across));
  const down = Math.max(1, Math.floor(gang.down));
  const units = across * down;
  const g = { ...gang, across, down };
  if (gang.order === 'copies') {
    return {
      gang: g,
      units,
      papers: sheetCount,
      sheetAt: (paper) => (paper < sheetCount ? paper : null),
      placeOf: (sheet) => ({ paper: sheet, col: 0, row: 0 }),
    };
  }
  const papers = Math.max(1, Math.ceil(sheetCount / units));
  return {
    gang: g,
    units,
    papers,
    sheetAt(paper, col, row) {
      const s = (row * across + col) * papers + paper;
      return s < sheetCount ? s : null;
    },
    placeOf(sheet) {
      const j = Math.floor(sheet / papers);
      return { paper: sheet % papers, col: j % across, row: Math.floor(j / across) };
    },
  };
}

/** Column, in the back view, of the unit whose front is at `col` (the sheet turns left ↔ right). */
export const backUnitColumn = (gang: Gang, col: number) => gang.across - 1 - col;
