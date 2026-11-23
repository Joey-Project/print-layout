/**
 * The fold editor's model: the packet after each fold of a program, the lines it can fold along
 * next, how many layers lie on each panel, and whether it is finished (one panel). Pure, so the editor only draws what this computes.
 */
import { applyFold, foldedRect, initialStack, packetBounds, type Facet, type Rect } from './fold';
import { ImpositionError, type Axis, type FoldStep, type Grid } from './types';

export interface FoldStage {
  /** One sheet's pieces after this many folds, in folded coordinates. */
  facets: Facet[];
  bounds: Rect;
}

export interface FoldProgress {
  /** The flat sheet, then the packet after each fold that fits. */
  stages: FoldStage[];
  /** The first fold that does not fit the packet (later ones are not tried), or null. */
  broken: { index: number; message: string } | null;
  /** Folded down to one panel: a finished program. */
  done: boolean;
}

const EPS = 1e-9;

export function foldProgress(grid: Grid, folds: readonly FoldStep[]): FoldProgress {
  let facets = initialStack(1, grid);
  const stages: FoldStage[] = [{ facets, bounds: packetBounds(facets) }];
  let broken: FoldProgress['broken'] = null;
  for (let i = 0; i < folds.length; i++) {
    try {
      facets = applyFold(facets, folds[i]!);
    } catch (e) {
      broken = { index: i, message: e instanceof ImpositionError ? e.message : String(e) };
      break;
    }
    stages.push({ facets, bounds: packetBounds(facets) });
  }
  const last = stages[stages.length - 1]!;
  const b = last.bounds;
  // Folds run along whole grid lines, so a one-panel packet has every layer on that panel.
  const done = !broken && Math.abs(b.x1 - b.x0 - 1) < EPS && Math.abs(b.y1 - b.y0 - 1) < EPS;
  return { stages, broken, done };
}

export interface FoldLine {
  axis: Axis;
  at: number;
}

/** Grid lines strictly inside the packet: where it can fold next. */
export function foldLines(bounds: Rect): FoldLine[] {
  const out: FoldLine[] = [];
  // (+ 0 turns a −0 from Math.ceil into 0.)
  for (let x = Math.ceil(bounds.x0 + EPS); x < bounds.x1 - EPS; x++) {
    out.push({ axis: 'x', at: x + 0 });
  }
  for (let y = Math.ceil(bounds.y0 + EPS); y < bounds.y1 - EPS; y++) {
    out.push({ axis: 'y', at: y + 0 });
  }
  return out;
}

/** Layers of paper on each panel of the packet, indexed [row][col] from its top-left. */
export function stackDepths(stage: FoldStage): number[][] {
  const { x0, y0, x1, y1 } = stage.bounds;
  const cols = Math.round(x1 - x0);
  const rows = Math.round(y1 - y0);
  const rects = stage.facets.map(foldedRect);
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const cx = x0 + c + 0.5;
      const cy = y0 + r + 0.5;
      return rects.filter((q) => cx > q.x0 && cx < q.x1 && cy > q.y0 && cy < q.y1).length;
    }),
  );
}

/** The part of the packet a fold moves, in words: left/right for vertical lines, top/bottom. */
export const movingPart = (axis: Axis, move: FoldStep['move']) =>
  axis === 'x' ? (move === 'low' ? 'left' : 'right') : move === 'low' ? 'top' : 'bottom';

/** E.g. "Fold at x = 1: left part over the rest". */
export function foldLabel(f: FoldStep): string {
  const where = f.axis === 'x' ? `x = ${f.at} (vertical)` : `y = ${f.at} (horizontal)`;
  return `Fold at ${where}: ${movingPart(f.axis, f.move)} part ${f.to === 'over' ? 'over' : 'under'} the rest`;
}
