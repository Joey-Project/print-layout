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

/**
 * Dividing the printed sheet into equal sections, one page each (e.g. A4 landscape in three to make
 * long, narrow pages): spreads fill whole sections and any sections left over stay blank, to be cut
 * off after printing.
 */
export interface Sections {
  across: number;
  down: number;
  /** Where the leftover blank sections go on the front: after the spreads or before them. */
  blank: 'end' | 'start';
}

/** A rectangle of sections (cells) on a printed sheet's front: column, row, width, height. */
export interface CellRect {
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * How a printed sheet is divided: its grid of page-sized cells, where each unit (recipe sheet)
 * sits, and which cells are blank. Positions are in the front view.
 */
export interface PaperLayout {
  /** Page-sized cells across and down the printed sheet. */
  across: number;
  down: number;
  /** Cells per unit (the recipe's panel grid). */
  unitCols: number;
  unitRows: number;
  /** Top-left cell of the unit at unit position (col, row). */
  unitCell(col: number, row: number): { col: number; row: number };
  /** Leftover cells, printed blank and cut off. */
  blanks: CellRect[];
}

export interface PaperPlan {
  gang: GangPlan;
  paper: PaperLayout;
  /** True when the sheet is divided into sections (pages sized by the sheet). */
  sectioned: boolean;
}

/**
 * Units per printed sheet and where they go. With `sections`, the number of units follows from how
 * many whole spreads fit in the sections; otherwise from the gang.
 */
export function paperPlan(
  sheetCount: number,
  grid: { cols: number; rows: number },
  gang: Gang,
  sections: Sections | null = null,
): PaperPlan {
  if (!sections) {
    const plan = gangPlan(sheetCount, gang);
    return {
      gang: plan,
      sectioned: false,
      paper: {
        across: plan.gang.across * grid.cols,
        down: plan.gang.down * grid.rows,
        unitCols: grid.cols,
        unitRows: grid.rows,
        unitCell: (col, row) => ({ col: col * grid.cols, row: row * grid.rows }),
        blanks: [],
      },
    };
  }
  const across = Math.max(grid.cols, Math.floor(sections.across));
  const down = Math.max(grid.rows, Math.floor(sections.down));
  const unitsAcross = Math.floor(across / grid.cols);
  const unitsDown = Math.floor(down / grid.rows);
  const usedW = unitsAcross * grid.cols;
  const usedH = unitsDown * grid.rows;
  const freeW = across - usedW;
  const freeH = down - usedH;
  const x0 = sections.blank === 'start' ? freeW : 0;
  const y0 = sections.blank === 'start' ? freeH : 0;
  const blanks: CellRect[] = [];
  if (freeW > 0)
    blanks.push({ col: sections.blank === 'start' ? 0 : usedW, row: y0, w: freeW, h: usedH });
  if (freeH > 0)
    blanks.push({ col: 0, row: sections.blank === 'start' ? 0 : usedH, w: across, h: freeH });
  return {
    gang: gangPlan(sheetCount, { ...gang, across: unitsAcross, down: unitsDown }),
    sectioned: true,
    paper: {
      across,
      down,
      unitCols: grid.cols,
      unitRows: grid.rows,
      unitCell: (col, row) => ({ col: x0 + col * grid.cols, row: y0 + row * grid.rows }),
      blanks,
    },
  };
}
