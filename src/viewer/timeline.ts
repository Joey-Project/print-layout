/**
 * The assembly timeline: printed sheets → stacked → folded → gathered → read leaf by leaf.
 *
 * Every pose is derived from the same fold simulation the imposition engine uses (one facet per
 * panel), so the 3D animation cannot disagree with the 2D plan.
 *
 * World space: x right, y up, z toward the viewer (right-handed). One panel is `1 × aspect` world
 * units; panel (col, row) occupies x ∈ [col, col+1], y ∈ [-(row+1)·aspect, -row·aspect] when flat.
 * The front of the sheet faces +z.
 */
import { Matrix4 } from 'three';
import { applyFold, packetBounds, type Facet } from '../engine/fold';
import type { BindingEdge, FoldStep, Plan, Recipe } from '../engine/types';

export interface PanelRef {
  sheet: number;
  col: number;
  row: number;
}

export type SegmentKind = 'collate' | 'settle' | 'fold' | 'gather' | 'read';

export interface Segment {
  kind: SegmentKind;
  label: string;
  start: number;
  end: number;
}

/** Direct manipulation of the reading stage: turning a leaf by dragging it across the spine. */
export interface PageTurn {
  /** Time at which reading starts (book closed, nothing turned). */
  start: number;
  leafCount: number;
  /**
   * How far a leaf is turned when the point of it held `reach` of the way out from the spine (1 =
   * its outer edge) is at world point (x, y): 0 = flat on the unturned side, 1 = flat on the turned
   * side. The point is projected onto the book's plane by the caller.
   */
  progressAt(x: number, y: number, reach?: number): number;
  /** How far leaf `rank` is turned at `time` (0..1). */
  progressOf(time: number, rank: number): number;
  /**
   * How far out from the spine a world point on leaf `rank` is, as a fraction of the leaf's width
   * across the spine (0 = at the spine, 1 = outer edge).
   */
  reachAt(rank: number, time: number, x: number, y: number, z: number, explode: number): number;
  /** Timeline time showing leaf `rank` turned by `progress` (inverse of the easing). */
  timeFor(rank: number, progress: number): number;
  /** Which leaf (0 = first turned) a panel belongs to. */
  rankOf(panel: number): number | undefined;
  /**
   * Time to continue from when leaf `rank` is grabbed at `time`. Only one leaf can be mid-turn at
   * once, so any other leaf still in flight (e.g. settling after a quick release) lands on the side it
   * would rest on, and the grabbed leaf keeps its current position.
   */
  grab(time: number, rank: number): number;
}

/**
 * Where two panels of the same sheet meet. The paper is continuous there, so the viewer draws a
 * curved strip joining them whenever they are not lying flat side by side (i.e. at a fold).
 */
export interface Seam {
  /** Panel indices (same sheet). */
  a: number;
  b: number;
  /** The shared edge's endpoints in panel-local (sheet) coordinates, world units. */
  p0: [number, number];
  p1: [number, number];
  /** Unit directions in panel-local coordinates from the edge into panel a / panel b. */
  inA: [number, number];
  inB: [number, number];
  /** True for the binding fold (the spine) of a bound piece. */
  spine: boolean;
  /** From this time on the fold has been trimmed off (head/foot bolts), so it is not drawn. */
  cutAt: number;
}

export interface Timeline {
  /** Total length in steps. */
  duration: number;
  segments: Segment[];
  /** Natural pause points: every segment boundary and every page turn. */
  stops: number[];
  pageTurn: PageTurn | null;
  /** One entry per panel; poses are written in the same order. */
  panels: PanelRef[];
  seams: Seam[];
  /** Time at which the folded piece is complete (start of reading, if any). */
  foldedAt: number;
  /** Number of leaves turned in the reading segment (0 if the recipe is not bound). */
  leafCount: number;
  aspect: number;
  /** Write each panel's world matrix at time t. `explode` ≥ 1 spreads layers apart. */
  poseAt(t: number, explode: number, out: Matrix4[]): void;
  /**
   * The spine axis of the section holding `panel` (default: the first) while the book is being
   * read (from the closed book on), or null. Every leaf of a section turns about its section's
   * axis, so that section's folds at the spine are arcs around it.
   */
  spineAxisAt(t: number, explode: number, panel?: number): SpineAxis | null;
}

export interface SpineAxis {
  origin: [number, number, number];
  dir: [number, number, number];
}

interface FlatState {
  sx: 1 | -1;
  sy: 1 | -1;
  tx: number;
  ty: number;
  layer: number;
}

const BASE_GAP = 0.012;
/** Vertical gap between printed sheets in the flat layout. */
const SHEET_SPACING = 0.5;
/** Gap between sheets (or sections) while stacked, before they are squared up. */
const STACK_SPACING = 0.35;
/** Share of a stacking step spent moving to the layer height before sliding into place. */
const LIFT_SHARE = 0.35;

const smooth = (u: number) => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** Inverse of `smooth` on [0, 1]. */
const unsmooth = (y: number) => {
  const c = Math.min(1, Math.max(0, y));
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
};
/** Two-phase stacking move: first rise/sink to the layer height, then slide into place. */
const liftThenSlide = (u: number) => ({
  lift: smooth(u / LIFT_SHARE),
  slide: smooth((u - LIFT_SHARE) / (1 - LIFT_SHARE)),
});

const keyOf = (f: { sheet: number; rect: { x0: number; y0: number } }) =>
  `${f.sheet}:${Math.round(f.rect.x0)}:${Math.round(f.rect.y0)}`;

/** Rotation sign so that the moving side lifts toward +z for 'over' and drops for 'under'. */
const foldSign = (move: 'low' | 'high', to: 'over' | 'under') =>
  (move === 'high' ? -1 : 1) * (to === 'over' ? 1 : -1);

function flatMatrix(s: FlatState, aspect: number, m: Matrix4): Matrix4 {
  // fx = sx·x + tx, fy = sy·y + ty in panel units; world y = -fy·aspect.
  return m.set(
    s.sx, 0, 0, s.tx,
    0, s.sy, 0, -s.ty * aspect,
    0, 0, s.sx * s.sy, 0,
    0, 0, 0, 1,
  ); // prettier-ignore
}

const tmpA = new Matrix4();
const tmpB = new Matrix4();

/** Rotation by `angle` about a hinge line lying in the z = 0 plane. */
function hingeRotation(axis: 'x' | 'y', at: number, aspect: number, angle: number, m: Matrix4) {
  if (axis === 'x') {
    // Vertical hinge at world x = at, rotating about the y axis.
    m.makeTranslation(at, 0, 0)
      .multiply(tmpA.makeRotationY(angle))
      .multiply(tmpB.makeTranslation(-at, 0, 0));
  } else {
    const y = -at * aspect;
    m.makeTranslation(0, y, 0)
      .multiply(tmpA.makeRotationX(angle))
      .multiply(tmpB.makeTranslation(0, -y, 0));
  }
  return m;
}

function groupsFor(recipe: Recipe, sheetCount: number): number[][] {
  const per =
    recipe.reading.mode === 'bound'
      ? recipe.reading.sheetsPerSignature === 'all'
        ? sheetCount
        : recipe.reading.sheetsPerSignature
      : 1;
  const groups: number[][] = [];
  for (let first = 0; first < sheetCount; first += per) {
    groups.push(Array.from({ length: Math.min(per, sheetCount - first) }, (_, i) => first + i));
  }
  return groups;
}

function describeFold(f: FoldStep, i: number, n: number): string {
  const side =
    f.axis === 'x'
      ? f.move === 'low'
        ? 'left part'
        : 'right part'
      : f.move === 'low'
        ? 'top part'
        : 'bottom part';
  return `Fold ${i + 1} of ${n}: ${side} ${f.to === 'over' ? 'over the top' : 'underneath'}`;
}

export function buildTimeline(recipe: Recipe, plan: Plan, aspect: number): Timeline {
  const { cols, rows } = recipe.grid;
  const sheetCount = plan.sheets.length;
  const panels: PanelRef[] = [];
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) panels.push({ sheet, col, row });
    }
  }
  const panelIndex = new Map(panels.map((p, i) => [`${p.sheet}:${p.col}:${p.row}`, i]));

  // ---- Simulate folds per group, one facet per panel. ----
  const groups = groupsFor(recipe, sheetCount);
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => g.forEach((s) => groupOf.set(s, gi)));
  const folds = recipe.folds;
  // states[step][panel] — step 0 is the collated, unfolded stack.
  const states: FlatState[][] = Array.from({ length: folds.length + 1 }, () => []);
  const layerCounts: number[] = [];
  const finalFacets: Facet[][] = [];
  for (const group of groups) {
    let facets: Facet[] = group.flatMap((sheet, k) =>
      Array.from({ length: rows * cols }, (_, i) => ({
        sheet,
        rect: {
          x0: i % cols,
          y0: Math.floor(i / cols),
          x1: (i % cols) + 1,
          y1: Math.floor(i / cols) + 1,
        },
        sx: 1 as const,
        tx: 0,
        sy: 1 as const,
        ty: 0,
        layer: group.length - 1 - k,
      })),
    );
    const record = (step: number) => {
      for (const f of facets) {
        const idx = panelIndex.get(keyOf(f));
        if (idx === undefined) throw new Error('Fold split a panel; folds must lie on grid lines.');
        states[step]![idx] = { sx: f.sx, sy: f.sy, tx: f.tx, ty: f.ty, layer: f.layer };
      }
    };
    record(0);
    folds.forEach((fold, i) => {
      facets = applyFold(facets, fold);
      record(i + 1);
    });
    layerCounts.push(Math.max(...facets.map((f) => f.layer)) + 1);
    finalFacets.push(facets);
  }
  const final = states[folds.length]!;

  // ---- Layout: printed sheets in a column, sheet 1 at the top. ----
  const sheetStride = rows * aspect + SHEET_SPACING;
  const layoutY = (sheet: number) => -sheet * sheetStride;
  const groupY = groups.map((g) => layoutY(g[0]!));
  // Group 0 ends on top of the gathered pile.
  const zBase = layerCounts.map((_, gi) => layerCounts.slice(gi + 1).reduce((a, b) => a + b, 0));

  // ---- Reading: leaves in stack order (bound recipes only). ----
  const bound = recipe.reading.mode === 'bound' ? recipe.reading : null;
  const leafOrder: number[] = []; // panel indices, top leaf first
  /** First and last leaf rank of each section (signature), in reading order. */
  const sections: [number, number][] = [];
  if (bound) {
    for (const facets of finalFacets) {
      const first = leafOrder.length;
      [...facets]
        .sort((a, b) => b.layer - a.layer)
        .forEach((f) => leafOrder.push(panelIndex.get(keyOf(f))!));
      sections.push([first, leafOrder.length - 1]);
    }
  }
  const sectionOfRank: number[] = [];
  sections.forEach(([a, b], g) => {
    for (let r = a; r <= b; r++) sectionOfRank[r] = g;
  });
  const leafRank = new Map(leafOrder.map((p, i) => [p, i]));
  const leafCount = leafOrder.length;

  let spine: { axis: 'x' | 'y'; at: number; sign: number; edge: BindingEdge } | null = null;
  // Every bound piece has a spine, folded or not (loose leaves bound along one edge have none).
  if (bound) {
    // Every group folds to the same packet; take its bounds from group 0's final facets.
    const b = packetBounds(finalFacets[0]!);
    const edge: BindingEdge = bound.bindingEdge;
    spine =
      edge === 'left'
        ? { axis: 'x', at: b.x0, sign: foldSign('high', 'over'), edge }
        : edge === 'right'
          ? { axis: 'x', at: b.x1, sign: foldSign('low', 'over'), edge }
          : edge === 'top'
            ? { axis: 'y', at: b.y0, sign: foldSign('high', 'over'), edge }
            : { axis: 'y', at: b.y1, sign: foldSign('low', 'over'), edge };
  }

  // ---- Segments. ----
  const segments: Segment[] = [];
  let t = 0;
  const push = (kind: SegmentKind, label: string, len = 1): Segment => {
    const s = { kind, label, start: t, end: t + len };
    segments.push(s);
    t += len;
    return s;
  };
  let collate: Segment | undefined;
  let collateSettle: Segment | undefined;
  if (groups.some((g) => g.length > 1)) {
    collate = push(
      'collate',
      'Stack the sheets: each moves to its layer, then slides up under the ones above',
    );
    collateSettle = push('settle', 'Square up the stack', 0.5);
  }
  const foldStart = t;
  folds.forEach((f, i) => push('fold', describeFold(f, i, folds.length)));
  let gather: Segment | undefined;
  let gatherSettle: Segment | undefined;
  if (bound !== null && groups.length > 1) {
    gather = push('gather', 'Gather the sections: each slides up under the ones above');
    gatherSettle = push('settle', 'Square up the sections', 0.5);
  }
  const foldedAt = t;
  const read = bound !== null && spine !== null ? push('read', 'Turn the pages', leafCount) : null;
  const duration = t;

  const stops = new Set<number>([0, duration]);
  for (const sg of segments) {
    stops.add(sg.start);
    stops.add(sg.end);
  }
  if (read) for (let k = 0; k <= leafCount; k++) stops.add(read.start + k);

  /** A leaf's height above its section's axis in the closed book (negative: below it). */
  function heightAboveAxis(rank: number, gap: number) {
    const [a, b] = sections[sectionOfRank[rank] ?? 0] ?? [0, 0];
    return ((a + b) / 2 - rank) * gap;
  }

  /** Unit vector (world x, y) from the spine toward the unturned leaves. */
  const outward: [number, number] = !spine
    ? [1, 0]
    : spine.edge === 'left'
      ? [1, 0]
      : spine.edge === 'right'
        ? [-1, 0]
        : spine.edge === 'top'
          ? [0, -1]
          : [0, 1];

  /**
   * Where the spine axis of the section holding leaf `rank` is at `time`: its height `z`, and `dx`,
   * how far it is moved along `outward` (toward the unturned side).
   *
   * Each section turns about its own middle: closed, its leaves sit at (leafCount − 1 − r)·gap, so
   * the axis is at the middle of that range; once read, at the middle of r·gap. Sections on the two
   * piles would then overlap at the spine (their folds bulge into the gutter at the same heights),
   * so — like the width of a real spine — sections already read sit half their thickness toward the
   * turned side and sections still to read toward the unturned side, while there is a pile on the
   * other side. The section being read rises above both piles to turn its leaves, then settles.
   * Each move happens while that section's first or last leaf turns: first rise, then slide in;
   * at the end slide out, then settle. A single-section book (saddle stitch) never moves.
   */
  function sectionAxis(rank: number, time: number, gap: number) {
    const g = sectionOfRank[rank] ?? 0;
    const [a, b] = sections[g] ?? [0, 0];
    const closed = (leafCount - 1 - (a + b) / 2) * gap;
    if (!read) return { z: closed, dx: 0 };
    const turned = ((a + b) / 2) * gap;
    const high = Math.max(closed, turned);
    const half = ((b - a) / 2) * gap + gap / 2; // half the section's thickness, plus clearance
    // Phases within the first and last leaf's turn (a one-leaf section fits all four in one).
    const span = a === b ? 0.5 : 1;
    const p = (r: number) => Math.min(1, Math.max(0, time - read.start - r));
    const enter = p(a) / span;
    const exit = (p(b) - (1 - span)) / span;
    const rise = smooth(2 * enter);
    const slideIn = smooth(2 * enter - 1);
    const slideOut = smooth(2 * exit);
    const settle = smooth(2 * exit - 1);
    // Is there a pile on the left (a section already read) / on the right (one still to read)?
    const firstSection = sections[0]!;
    const lastSection = sections[sections.length - 1]!;
    const firstSpan = firstSection[0] === firstSection[1] ? 0.5 : 1;
    const lastSpan = lastSection[0] === lastSection[1] ? 0.5 : 1;
    const readPile =
      sections.length > 1 ? smooth(2 * ((p(firstSection[1]) - (1 - firstSpan)) / firstSpan)) : 0;
    const unreadPile = sections.length > 1 ? 1 - smooth(2 * (p(lastSection[0]) / lastSpan) - 1) : 0;
    return {
      z: closed + (high - closed) * rise - (high - turned) * settle,
      dx: half * (readPile * (1 - slideIn) - unreadPile * slideOut),
    };
  }

  let pageTurn: PageTurn | null = null;
  if (read && spine) {
    const sp = spine;
    const spineWorld = sp.axis === 'x' ? sp.at : -sp.at * aspect;
    pageTurn = {
      start: read.start,
      leafCount,
      progressAt(x, y, reach = 1) {
        const d =
          sp.edge === 'left'
            ? x - spineWorld
            : sp.edge === 'right'
              ? spineWorld - x
              : sp.edge === 'top'
                ? (spineWorld - y) / aspect
                : (y - spineWorld) / aspect;
        const r = Math.max(0.05, Math.min(1, reach));
        return Math.acos(Math.min(1, Math.max(-1, d / r))) / Math.PI;
      },
      progressOf: (time, rank) => smooth(time - read.start - rank),
      reachAt(rank, time, x, y, z, explode) {
        // Distance from the spine axis in the plane across it; the leaf runs past the axis at its
        // own height above it, so subtract that to get the distance along the leaf.
        const gap = BASE_GAP * Math.max(1, explode);
        const axis = sectionAxis(rank, time, gap);
        const height = heightAboveAxis(rank, gap);
        const unit = sp.axis === 'x' ? 1 : aspect;
        const shift = sp.axis === 'x' ? outward[0] * axis.dx : outward[1] * axis.dx;
        const across = ((sp.axis === 'x' ? x : y) - spineWorld - shift) / unit;
        const up = (z - axis.z) / unit;
        const along = Math.sqrt(Math.max(0, across * across + up * up - (height / unit) ** 2));
        return Math.min(1, along);
      },
      timeFor: (rank, progress) => read.start + rank + unsmooth(progress),
      rankOf: (panel) => leafRank.get(panel),
      grab: (time, rank) => Math.min(Math.max(time, read.start + rank), read.start + rank + 1),
    };
  }

  // ---- Seams: every edge shared by two panels of a sheet. In a bound piece, only the spine fold
  // survives trimming; the other folds are cut open when reading starts. ----
  const seams: Seam[] = [];
  const onSpine = (panel: number, axis: 'x' | 'y', line: number) => {
    if (!spine || spine.axis !== axis) return false;
    const f = final[panel]!;
    const folded = axis === 'x' ? f.sx * line + f.tx : f.sy * line + f.ty;
    return Math.abs(folded - spine.at) < 1e-9;
  };
  const addSeam = (a: number, b: number, axis: 'x' | 'y', line: number) => {
    const isSpine = onSpine(a, axis, line);
    const { col, row } = panels[a]!;
    const seam: Seam =
      axis === 'x'
        ? {
            a,
            b,
            p0: [line, -row * aspect],
            p1: [line, -(row + 1) * aspect],
            inA: [-1, 0],
            inB: [1, 0],
            spine: isSpine,
            cutAt: Infinity,
          }
        : {
            a,
            b,
            p0: [col, -line * aspect],
            p1: [col + 1, -line * aspect],
            inA: [0, 1],
            inB: [0, -1],
            spine: isSpine,
            cutAt: Infinity,
          };
    if (read && !isSpine) seam.cutAt = read.start;
    seams.push(seam);
  };
  panels.forEach((p, i) => {
    if (p.col + 1 < cols)
      addSeam(i, panelIndex.get(`${p.sheet}:${p.col + 1}:${p.row}`)!, 'x', p.col + 1);
    if (p.row + 1 < rows)
      addSeam(i, panelIndex.get(`${p.sheet}:${p.col}:${p.row + 1}`)!, 'y', p.row + 1);
  });

  const flat = new Matrix4();
  const hinge = new Matrix4();
  const lift = new Matrix4();
  const G = groups.length;

  function poseAt(time: number, explode: number, out: Matrix4[]) {
    const tt = Math.min(Math.max(time, 0), duration);
    const gap = BASE_GAP * Math.max(1, explode);

    panels.forEach((p, i) => {
      const m = out[i]!;
      const g = groupOf.get(p.sheet)!;
      const group = groups[g]!;

      // Stacking: from the printed column into the section's stack, then squared up.
      if (collate && collateSettle && tt < foldStart) {
        const k = group.indexOf(p.sheet);
        const spacedZ = (group.length - 1 - k) * STACK_SPACING;
        const tightZ = states[0]![i]!.layer * gap;
        if (tt <= collate.end) {
          const { lift: zu, slide: yu } = liftThenSlide(tt - collate.start);
          m.makeTranslation(0, lerp(layoutY(p.sheet), groupY[g]!, yu), lerp(0, spacedZ, zu));
        } else {
          const us = smooth((tt - collateSettle.start) / (collateSettle.end - collateSettle.start));
          m.makeTranslation(0, groupY[g]!, lerp(spacedZ, tightZ, us));
        }
        return;
      }

      // Folding.
      const k = Math.min(folds.length, Math.max(0, Math.floor(tt - foldStart)));
      if (k < folds.length && tt < foldStart + folds.length) {
        const u = smooth(tt - foldStart - k);
        const fold = folds[k]!;
        const a = states[k]![i]!;
        const b = states[k + 1]![i]!;
        const za = a.layer * gap;
        const zb = b.layer * gap;
        flatMatrix(a, aspect, flat);
        if (a.sx !== b.sx || a.sy !== b.sy) {
          const angle = foldSign(fold.move, fold.to) * Math.PI * u;
          hingeRotation(fold.axis, fold.at, aspect, angle, hinge);
          // Rotate the stack rigidly (with its thickness), then correct the height.
          m.makeTranslation(0, groupY[g]!, u * (zb + za))
            .multiply(hinge)
            .multiply(lift.makeTranslation(0, 0, za))
            .multiply(flat);
        } else {
          m.makeTranslation(0, groupY[g]!, lerp(za, zb, u)).multiply(flat);
        }
        return;
      }

      // Folded; then sections gathered (slide up under the ones above) and squared up.
      const f = final[i]!;
      flatMatrix(f, aspect, flat);
      let y = groupY[g]!;
      let zSection = 0;
      if (gather && gatherSettle && tt > gather.start) {
        const spaced = (G - 1 - g) * STACK_SPACING + zBase[g]! * gap;
        if (tt <= gather.end) {
          const { lift: zu, slide: yu } = liftThenSlide(tt - gather.start);
          y = lerp(groupY[g]!, 0, yu);
          zSection = lerp(0, spaced, zu);
        } else {
          const us = smooth((tt - gatherSettle.start) / (gatherSettle.end - gatherSettle.start));
          y = 0;
          zSection = lerp(spaced, zBase[g]! * gap, us);
        }
      }

      if (read && spine && tt > read.start) {
        const rank = leafRank.get(i)!;
        const ur = smooth(tt - read.start - rank);
        // Like a real book block, the leaves of a section turn about the middle of that section's
        // spine, not about their own heights: nested sheets stay nested and their folds are arcs
        // around one axis (see `axisHeight`).
        hingeRotation(spine.axis, spine.at, aspect, spine.sign * Math.PI * ur, hinge);
        const axis = sectionAxis(rank, tt, gap);
        m.makeTranslation(outward[0] * axis.dx, outward[1] * axis.dx, axis.z)
          .multiply(hinge)
          .multiply(lift.makeTranslation(0, 0, heightAboveAxis(rank, gap)))
          .multiply(flat);
        return;
      }
      m.makeTranslation(0, y, zSection + f.layer * gap).multiply(flat);
    });
  }

  function spineAxisAt(time: number, explode: number, panel?: number): SpineAxis | null {
    if (!read || !spine || time < read.start) return null;
    const rank = (panel === undefined ? undefined : leafRank.get(panel)) ?? 0;
    const { z, dx } = sectionAxis(rank, time, BASE_GAP * Math.max(1, explode));
    return spine.axis === 'x'
      ? { origin: [spine.at + outward[0] * dx, 0, z], dir: [0, 1, 0] }
      : { origin: [0, -spine.at * aspect + outward[1] * dx, z], dir: [1, 0, 0] };
  }

  return {
    spineAxisAt,
    duration,
    segments,
    stops: [...stops].sort((a, b) => a - b),
    pageTurn,
    panels,
    seams,
    foldedAt,
    leafCount: read ? leafCount : 0,
    aspect,
    poseAt,
  };
}
