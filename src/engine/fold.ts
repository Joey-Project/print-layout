import { ImpositionError, type Axis, type FoldStep, type Grid } from './types';

const EPS = 1e-9;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A piece of one sheet inside the folded stack. `rect` is in sheet (front-view) coordinates; the
 * transform maps sheet coordinates to folded space: fx = sx * x + tx, fy = sy * y + ty.
 * Axis-aligned folds only ever reflect, so the transform never rotates or swaps axes.
 */
export interface Facet {
  sheet: number;
  rect: Rect;
  sx: 1 | -1;
  tx: number;
  sy: 1 | -1;
  ty: number;
  /** Stacking order in folded space; larger is closer to the viewer (top). */
  layer: number;
}

export function foldedRect(f: Facet): Rect {
  const ax = f.sx * f.rect.x0 + f.tx;
  const bx = f.sx * f.rect.x1 + f.tx;
  const ay = f.sy * f.rect.y0 + f.ty;
  const by = f.sy * f.rect.y1 + f.ty;
  return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
}

/** Flat sheets stacked with sheet 0 on top, all front side up. */
export function initialStack(sheetCount: number, grid: Grid): Facet[] {
  return Array.from({ length: sheetCount }, (_, sheet) => ({
    sheet,
    rect: { x0: 0, y0: 0, x1: grid.cols, y1: grid.rows },
    sx: 1 as const,
    tx: 0,
    sy: 1 as const,
    ty: 0,
    layer: sheetCount - 1 - sheet,
  }));
}

function span(r: Rect, axis: Axis): [number, number] {
  return axis === 'x' ? [r.x0, r.x1] : [r.y0, r.y1];
}

/** Split a facet along a line given in folded coordinates. */
function splitFacet(f: Facet, axis: Axis, at: number): [Facet, Facet] {
  const s = axis === 'x' ? f.sx : f.sy;
  const t = axis === 'x' ? f.tx : f.ty;
  const c = (at - t) / s; // the fold line in sheet coordinates
  const a: Facet = { ...f, rect: { ...f.rect } };
  const b: Facet = { ...f, rect: { ...f.rect } };
  if (axis === 'x') {
    a.rect.x1 = c;
    b.rect.x0 = c;
  } else {
    a.rect.y1 = c;
    b.rect.y0 = c;
  }
  return [a, b];
}

function normalizeLayers(facets: Facet[]): Facet[] {
  const levels = [...new Set(facets.map((f) => f.layer))].sort((p, q) => p - q);
  const rank = new Map(levels.map((l, i) => [l, i]));
  return facets.map((f) => ({ ...f, layer: rank.get(f.layer)! }));
}

/** Fold the whole stack along one line. Returns a new facet list. */
export function applyFold(facets: Facet[], step: FoldStep): Facet[] {
  const { axis, at } = step;
  const all = facets.map((f) => span(foldedRect(f), axis));
  const lo = Math.min(...all.map(([a]) => a));
  const hi = Math.max(...all.map(([, b]) => b));
  if (!(at > lo + EPS && at < hi - EPS)) {
    throw new ImpositionError(
      `Fold along ${axis} = ${at} is outside the current packet (${axis} from ${lo} to ${hi}).`,
    );
  }

  const low: Facet[] = [];
  const high: Facet[] = [];
  for (const f of facets) {
    const [a, b] = span(foldedRect(f), axis);
    if (b <= at + EPS) low.push(f);
    else if (a >= at - EPS) high.push(f);
    else {
      for (const piece of splitFacet(f, axis, at)) {
        const [pa] = span(foldedRect(piece), axis);
        (pa < at - EPS ? low : high).push(piece);
      }
    }
  }

  const layers = facets.map((f) => f.layer);
  const maxL = Math.max(...layers);
  const minL = Math.min(...layers);
  const [staying, moving] = step.move === 'low' ? [high, low] : [low, high];
  const moved = moving.map((f): Facet => {
    const layer = step.to === 'over' ? maxL + 1 + (maxL - f.layer) : minL - 1 - (f.layer - minL);
    return axis === 'x'
      ? { ...f, sx: -f.sx as 1 | -1, tx: 2 * at - f.tx, layer }
      : { ...f, sy: -f.sy as 1 | -1, ty: 2 * at - f.ty, layer };
  });
  return normalizeLayers([...staying, ...moved]);
}

export function foldAll(sheetCount: number, grid: Grid, folds: FoldStep[]): Facet[] {
  return folds.reduce(applyFold, initialStack(sheetCount, grid));
}

/** Bounding box of the folded packet. */
export function packetBounds(facets: Facet[]): Rect {
  const rs = facets.map(foldedRect);
  return {
    x0: Math.min(...rs.map((r) => r.x0)),
    y0: Math.min(...rs.map((r) => r.y0)),
    x1: Math.max(...rs.map((r) => r.x1)),
    y1: Math.max(...rs.map((r) => r.y1)),
  };
}
