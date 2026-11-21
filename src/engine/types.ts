/**
 * Core data model. See docs/design.md for the conventions:
 * - A sheet side is a grid of `cols × rows` panels; coordinates are in panel units with the origin at
 *   the top-left of the FRONT side and y growing downward.
 * - The back side is described in "back view": as seen after turning the sheet over like a book page
 *   (around its vertical axis), so back-view column = cols - 1 - front column.
 */

export type Axis = 'x' | 'y';
export type Side = 'front' | 'back';
export type Rotation = 0 | 180;
export type BindingEdge = 'left' | 'right' | 'top' | 'bottom';
export type Padding = 'end' | 'beforeLastPage';

export interface Grid {
  cols: number;
  rows: number;
}

/** One fold of the whole stack along a grid line of the current (already folded) packet. */
export interface FoldStep {
  /** 'x' folds along the vertical line x = at; 'y' along the horizontal line y = at. */
  axis: Axis;
  /** Grid line in current folded coordinates (panel units). */
  at: number;
  /** Which side of the line swings: 'low' = smaller coordinates (left/top), 'high' = larger. */
  move: 'low' | 'high';
  /** Whether the swinging part lands on top of ('over') or beneath ('under') the stack. */
  to: 'over' | 'under';
}

/** Codex-style reading: every leaf is trimmed free except along the binding edge. */
export interface BoundReading {
  mode: 'bound';
  /** Spine position as seen when looking at the cover (top of the folded stack). */
  bindingEdge: BindingEdge;
  /** 'all' nests every sheet into one section (saddle stitch); a number gathers sections. */
  sheetsPerSignature: number | 'all';
}

/** A printed panel face, in that side's own view coordinates. */
export interface PanelFace {
  side: Side;
  col: number;
  row: number;
  rotation?: Rotation;
}

/** Unfolded pieces (accordion, leaflets, zines): reading order is an explicit list of faces. */
export interface SequenceReading {
  mode: 'sequence';
  /** Defaults to every front panel row-major, then every back panel row-major (back view). */
  order?: PanelFace[];
}

export type Reading = BoundReading | SequenceReading;

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  grid: Grid;
  folds: FoldStep[];
  reading: Reading;
  /** Where blank padding pages go when the page count does not fill the sheets. */
  padding?: Padding;
}

export interface Slot {
  /** Column/row in this side's view coordinates. */
  col: number;
  row: number;
  /** 1-based position in the finished piece's reading order (includes blanks). */
  position: number;
  /** 1-based source PDF page, or null for a blank. */
  page: number | null;
  /** Rotation the page must be printed with so it reads upright once folded. */
  rotation: Rotation;
}

export interface SheetPlan {
  front: Slot[];
  back: Slot[];
}

export interface Plan {
  recipeId: string;
  grid: Grid;
  /** Source pages requested. */
  pageCount: number;
  /** Reading positions available on all sheets (pageCount + blanks). */
  slotCount: number;
  pagesPerSheet: number;
  sheets: SheetPlan[];
}

export class ImpositionError extends Error {
  override name = 'ImpositionError';
}
