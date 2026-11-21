import { foldAll, foldedRect, packetBounds, type Facet } from './fold';
import {
  ImpositionError,
  type BindingEdge,
  type Grid,
  type Padding,
  type PanelFace,
  type Plan,
  type Recipe,
  type Rotation,
  type SheetPlan,
  type Side,
} from './types';

const EPS = 1e-9;

/** A panel face located on a specific sheet, in reading order. */
export interface PlacedFace extends Required<PanelFace> {
  sheet: number;
}

const other = (s: Side): Side => (s === 'front' ? 'back' : 'front');
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

/**
 * Reading order of a folded, trimmed and bound stack: top leaf first, each leaf giving its top face
 * then its bottom face (the bottom face is seen after turning the leaf around the binding edge).
 */
export function readBound(facets: Facet[], grid: Grid, bindingEdge: BindingEdge): PlacedFace[] {
  const page = packetBounds(facets);
  if (!near(page.x1 - page.x0, 1) || !near(page.y1 - page.y0, 1)) {
    throw new ImpositionError(
      `After folding, the packet is ${page.x1 - page.x0}×${page.y1 - page.y0} panels; ` +
        'a bound recipe must fold down to exactly one panel.',
    );
  }
  for (const f of facets) {
    const r = foldedRect(f);
    if (
      !near(r.x0, page.x0) ||
      !near(r.y0, page.y0) ||
      !near(r.x1, page.x1) ||
      !near(r.y1, page.y1)
    ) {
      throw new ImpositionError('After folding, some layers do not cover the whole page.');
    }
  }
  const sorted = [...facets].sort((a, b) => b.layer - a.layer);
  sorted.forEach((f, i) => {
    if (i > 0 && sorted[i - 1]!.layer === f.layer) {
      throw new ImpositionError('Two layers ended up at the same depth in the folded stack.');
    }
  });

  const mirror = bindingEdge === 'left' || bindingEdge === 'right' ? 'x' : 'y';
  const out: PlacedFace[] = [];
  for (const f of sorted) {
    const topSide: Side = f.sx * f.sy > 0 ? 'front' : 'back';
    for (const view of ['top', 'bottom'] as const) {
      const side = view === 'top' ? topSide : other(topSide);
      // Map from the side's own view coordinates to the reader's view of this face.
      const ax = f.sx * (view === 'bottom' && mirror === 'x' ? -1 : 1) * (side === 'back' ? -1 : 1);
      const ay = f.sy * (view === 'bottom' && mirror === 'y' ? -1 : 1);
      if (ax * ay !== 1) throw new ImpositionError('Internal error: page would be mirrored.');
      const rotation: Rotation = ax === 1 ? 0 : 180;
      const col = Math.round(side === 'front' ? f.rect.x0 : grid.cols - 1 - f.rect.x0);
      const row = Math.round(f.rect.y0);
      out.push({ sheet: f.sheet, side, col, row, rotation });
    }
  }
  return out;
}

export function defaultSequence(grid: Grid): Required<PanelFace>[] {
  const faces: Required<PanelFace>[] = [];
  for (const side of ['front', 'back'] as const) {
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) faces.push({ side, col, row, rotation: 0 });
    }
  }
  return faces;
}

export function pagesPerSheet(recipe: Recipe): number {
  if (recipe.reading.mode === 'bound') return 2 * recipe.grid.cols * recipe.grid.rows;
  return recipe.reading.order?.length ?? 2 * recipe.grid.cols * recipe.grid.rows;
}

/** Map a 1-based reading position to a 1-based source page (null = blank). */
export function positionToPage(
  position: number,
  pageCount: number,
  slotCount: number,
  padding: Padding,
): number | null {
  if (padding === 'beforeLastPage' && pageCount >= 2) {
    if (position < pageCount) return position;
    if (position === slotCount) return pageCount;
    return null;
  }
  return position <= pageCount ? position : null;
}

/** All reading positions for `sheetCount` sheets, as placed faces. */
export function readingFaces(recipe: Recipe, sheetCount: number): PlacedFace[] {
  const { grid, reading } = recipe;
  if (reading.mode === 'bound') {
    const perSig = reading.sheetsPerSignature === 'all' ? sheetCount : reading.sheetsPerSignature;
    const faces: PlacedFace[] = [];
    for (let first = 0; first < sheetCount; first += perSig) {
      const n = Math.min(perSig, sheetCount - first);
      const stack = foldAll(n, grid, recipe.folds);
      for (const f of readBound(stack, grid, reading.bindingEdge)) {
        faces.push({ ...f, sheet: f.sheet + first });
      }
    }
    return faces;
  }
  const order = (reading.order ?? defaultSequence(grid)).map((f) => ({
    ...f,
    rotation: f.rotation ?? 0,
  }));
  return Array.from({ length: sheetCount }, (_, sheet) =>
    order.map((f) => ({ ...f, sheet })),
  ).flat();
}

export function buildPlan(recipe: Recipe, pageCount: number): Plan {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new ImpositionError('Page count must be a positive whole number.');
  }
  const perSheet = pagesPerSheet(recipe);
  const sheetCount = Math.ceil(pageCount / perSheet);
  const slotCount = sheetCount * perSheet;
  const padding = recipe.padding ?? 'end';
  const sheets: SheetPlan[] = Array.from({ length: sheetCount }, () => ({ front: [], back: [] }));

  readingFaces(recipe, sheetCount).forEach((f, i) => {
    const position = i + 1;
    sheets[f.sheet]![f.side].push({
      col: f.col,
      row: f.row,
      position,
      page: positionToPage(position, pageCount, slotCount, padding),
      rotation: f.rotation,
    });
  });
  for (const s of sheets) {
    for (const side of ['front', 'back'] as const) {
      s[side].sort((a, b) => a.row - b.row || a.col - b.col);
    }
  }
  return {
    recipeId: recipe.id,
    grid: recipe.grid,
    pageCount,
    slotCount,
    pagesPerSheet: perSheet,
    sheets,
  };
}
