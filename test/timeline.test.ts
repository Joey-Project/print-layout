import { Matrix4, Vector3 } from 'three';
import { buildPlan, builtinRecipes, type Plan, type Recipe } from '../src/engine';
import { seamStrip } from '../src/viewer/seams';
import { buildTimeline } from '../src/viewer/timeline';

const recipe = (id: string): Recipe => builtinRecipes.find((r) => r.id === id)!;
/** Loose single leaves bound along the left edge (no folds), e.g. perfect-bound cut sheets. */
const looseLeaves: Recipe = {
  id: 'loose-leaves',
  name: 'Loose leaves',
  grid: { cols: 1, rows: 1 },
  folds: [],
  reading: { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 1 },
};
const recipeOf = (id: string) => (id === looseLeaves.id ? looseLeaves : recipe(id));
const ASPECT = Math.SQRT2;

/** The face of each panel that points at the camera (+z), with where it sits. */
function visibleFaces(plan: Plan, t: number, r: Recipe) {
  const tl = buildTimeline(r, plan, ASPECT);
  const mats = tl.panels.map(() => new Matrix4());
  tl.poseAt(t, 1, mats);
  return tl.panels.map((p, i) => {
    const m = mats[i]!;
    const center = new Vector3(p.col + 0.5, -(p.row + 0.5) * ASPECT, 0).applyMatrix4(m);
    const frontUp = new Vector3(0, 0, 1).transformDirection(m).z > 0;
    const side = frontUp ? 'front' : 'back';
    const col = frontUp ? p.col : r.grid.cols - 1 - p.col;
    const slot = plan.sheets[p.sheet]![side].find((s) => s.col === col && s.row === p.row)!;
    const up = new Vector3(0, slot.rotation === 180 ? -1 : 1, 0).transformDirection(m);
    return { center, position: slot.position, upright: up.y > 0.999 };
  });
}

/** Top-most visible face on each side of the spine. */
function piles(plan: Plan, t: number, r: Recipe, spineX: number) {
  const faces = visibleFaces(plan, t, r);
  const top = (fs: typeof faces) =>
    fs.length ? fs.reduce((a, b) => (b.center.z > a.center.z ? b : a)) : undefined;
  return {
    left: top(faces.filter((f) => f.center.x < spineX)),
    right: top(faces.filter((f) => f.center.x > spineX)),
  };
}

describe('3D timeline agrees with the 2D plan', () => {
  const cases: [string, number][] = [
    ['saddle-stitch', 8],
    ['saddle-stitch', 12],
    ['saddle-stitch', 10],
    ['saddle-stitch-rtl', 12],
    ['signature-8', 16],
    ['sewn-signatures-4', 20],
    ['loose-leaves', 6],
  ];

  it.each(cases)('%s with %i pages reads in order while turning leaves', (id, pages) => {
    const r = recipeOf(id);
    const plan = buildPlan(r, pages);
    const tl = buildTimeline(r, plan, ASPECT);
    const read = tl.segments.find((s) => s.kind === 'read')!;
    expect(tl.leafCount).toBe(plan.slotCount / 2);
    const rtl = r.reading.mode === 'bound' && r.reading.bindingEdge === 'right';

    // Spine x: the folded packet's binding edge. Sample it from the closed book.
    const closed = visibleFaces(plan, read.start, r);
    const spineX = Math.round(closed[0]!.center.x + (rtl ? 0.5 : -0.5));

    for (let k = 0; k <= tl.leafCount; k++) {
      const { left, right } = piles(plan, read.start + k, r, spineX);
      const [unturned, turned] = rtl ? [left, right] : [right, left];
      if (k < tl.leafCount) {
        expect(unturned?.position, `spread ${k}: next page`).toBe(2 * k + 1);
        expect(unturned?.upright, `spread ${k}: next page upright`).toBe(true);
      }
      if (k > 0) {
        expect(turned?.position, `spread ${k}: previous page`).toBe(2 * k);
        expect(turned?.upright, `spread ${k}: previous page upright`).toBe(true);
      }
    }
  });

  it('starts with the sheets laid out flat, fronts up', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 12);
    const faces = visibleFaces(plan, 0, r);
    expect(faces.every((f) => Math.abs(f.center.z) < 1e-9)).toBe(true);
    // Sheet 1's front shows [12 | 1] as in the 2D view.
    expect(faces.slice(0, 2).map((f) => f.position)).toEqual([12, 1]);
  });

  it('lays printed sheets out in a column, then stacks them with visible gaps', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 12);
    const tl = buildTimeline(r, plan, ASPECT);
    const mats = tl.panels.map(() => new Matrix4());
    const sheetPos = (t: number) => {
      tl.poseAt(t, 1, mats);
      // Panel 0 of each sheet (2 panels per sheet).
      return [0, 2, 4].map((i) => new Vector3().setFromMatrixPosition(mats[i]!));
    };
    const flat = sheetPos(0);
    expect(new Set(flat.map((v) => v.x)).size).toBe(1); // aligned vertically
    expect(flat[0]!.y).toBeGreaterThan(flat[1]!.y);
    expect(flat[1]!.y).toBeGreaterThan(flat[2]!.y);

    const collate = tl.segments.find((s) => s.kind === 'collate')!;
    const stacked = sheetPos(collate.end);
    expect(new Set(stacked.map((v) => v.y)).size).toBe(1); // slid up into one stack
    // Sheet 1 on top, with clear space between sheets.
    expect(stacked[0]!.z - stacked[1]!.z).toBeGreaterThan(0.3);
    expect(stacked[1]!.z - stacked[2]!.z).toBeGreaterThan(0.3);
    // While sliding, a lower sheet is already below the ones above it.
    const mid = sheetPos(collate.start + 0.6);
    expect(mid[2]!.z).toBeLessThan(mid[1]!.z);
    expect(mid[1]!.z).toBeLessThan(mid[0]!.z);
  });

  it('maps a drag across the spine to the matching page-turn time', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    const tl = buildTimeline(r, plan, ASPECT);
    const turn = tl.pageTurn!;
    expect(tl.stops).toEqual(expect.arrayContaining([turn.start, turn.start + 1, tl.duration]));
    const spineX = 1; // saddle stitch folds to x ∈ [1, 2], spine on the left
    const mats = tl.panels.map(() => new Matrix4());
    for (const p of [0.1, 0.3, 0.5, 0.8]) {
      // Pointer held where the leaf's outer edge would be at this turn.
      const x = spineX + Math.cos(Math.PI * p);
      expect(turn.progressAt(x, 0)).toBeCloseTo(p, 6);
      tl.poseAt(turn.timeFor(1, p), 1, mats);
      // The second leaf (pages 3/4) is the outer half of sheet 2 (panel index 3): its centre should
      // sit halfway between spine and pointer, give or take its height above the spine axis
      // (leaves turn about the middle of the 4-leaf block: it sits half a gap above that).
      const c = new Vector3(1.5, -0.5 * ASPECT, 0).applyMatrix4(mats[3]!);
      const above = 0.5 * 0.012;
      expect(c.x).toBeCloseTo(
        spineX + 0.5 * Math.cos(Math.PI * p) - above * Math.sin(Math.PI * p),
        6,
      );
    }
  });

  it('grabbing the next page while the last one settles lands the last one first', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 12);
    const tl = buildTimeline(r, plan, ASPECT);
    const turn = tl.pageTurn!;
    // Every panel is one leaf; the cover (pages 1/2) is turned first.
    const ranks = tl.panels.map((_, i) => turn.rankOf(i));
    expect(new Set(ranks).size).toBe(turn.leafCount);
    // Leaf 3 (pages 7/8) was released 60% turned and is still falling to the left.
    const settling = turn.start + 3.6;
    // Grabbing leaf 4 (page 9) from the right: leaf 3 finishes its turn, leaf 4 starts flat.
    expect(turn.grab(settling, 4)).toBe(turn.start + 4);
    const { left, right } = piles(plan, turn.grab(settling, 4), r, 1);
    expect(left?.position).toBe(8);
    expect(right?.position).toBe(9);
    // Catching leaf 3 itself keeps it where it is; grabbing leaf 2 sends leaf 3 back to the right.
    expect(turn.grab(settling, 3)).toBe(settling);
    expect(turn.grab(settling, 2)).toBe(turn.start + 3);
  });

  it('joins the two halves of each sheet round the spine, outer sheets wrapping inner ones', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 12);
    const tl = buildTimeline(r, plan, ASPECT);
    const turn = tl.pageTurn!;
    expect(tl.seams).toHaveLength(3);
    expect(tl.seams.every((s) => s.spine && s.cutAt === Infinity)).toBe(true);
    const mats = tl.panels.map(() => new Matrix4());
    const out = new Float32Array(17 * 6);
    const strip = (t: number, sheet: number) => {
      tl.poseAt(t, 10, mats);
      const seam = tl.seams.find((s) => tl.panels[s.a]!.sheet === sheet)!;
      const gap = seamStrip(seam, mats[seam.a]!, mats[seam.b]!, 16, out);
      const xs = Array.from({ length: 34 }, (_, i) => out[i * 3]!);
      const end = (panel: number) =>
        new Vector3(seam.p0[0], seam.p0[1], 0).applyMatrix4(mats[panel]!);
      return { gap, minX: Math.min(...xs), maxX: Math.max(...xs), seam, end };
    };

    // Closed: each sheet folds round the spine (x = 1), the outer sheet furthest out.
    const closed = [0, 1, 2].map((sheet) => {
      const c = strip(turn.start, sheet);
      expect(c.maxX).toBeLessThanOrEqual(1 + 1e-6);
      // The strip starts and ends exactly on its two pages' spine edges.
      const a = c.end(c.seam.a);
      const b = c.end(c.seam.b);
      expect([out[0], out[1], out[2]]).toEqual([a.x, a.y, a.z].map((v) => expect.closeTo(v, 5)));
      expect([out[96], out[97], out[98]]).toEqual([b.x, b.y, b.z].map((v) => expect.closeTo(v, 5)));
      return c;
    });
    expect(closed[0]!.minX).toBeLessThan(closed[1]!.minX);
    expect(closed[1]!.minX).toBeLessThan(closed[2]!.minX);

    // Opened at the centre spread (pages 6 | 7): the middle sheet lies flat, outer ones too.
    const centre = turn.start + 3;
    expect(strip(centre, 2).gap).toBeLessThan(1e-9);
    expect(strip(centre, 0).gap).toBeLessThan(1e-9);
  });

  it('never lets a turning page or a fold cut through another page or fold', () => {
    // Cross-section through the top edge (y = 0): each leaf is a segment from the spine outwards,
    // each fold a polyline. No two may cross, at any moment of reading, even exploded.
    type P = [number, number];
    const cross = (o: P, a: P, b: P) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const eps = 1e-9;
    // Collected and checked once: an expect() per segment pair is far too slow.
    const crossings: string[] = [];
    const properlyCross = (p1: P, p2: P, q1: P, q2: P) => {
      const d1 = cross(q1, q2, p1);
      const d2 = cross(q1, q2, p2);
      const d3 = cross(p1, p2, q1);
      const d4 = cross(p1, p2, q2);
      return d1 * d2 < -eps && d3 * d4 < -eps;
    };
    for (const [id, pages] of [
      ['saddle-stitch', 12],
      ['saddle-stitch', 20],
      ['saddle-stitch-rtl', 12],
    ] as const) {
      const r = recipe(id);
      const tl = buildTimeline(r, buildPlan(r, pages), ASPECT);
      const read = tl.segments.find((s) => s.kind === 'read')!;
      const mats = tl.panels.map(() => new Matrix4());
      const out = new Float32Array(17 * 6);
      const xz = (v: Vector3): P => [v.x, v.z];
      for (let t = read.start; t <= read.end + 1e-9; t += 0.05) {
        tl.poseAt(t, 10, mats);
        const lines: P[][] = tl.panels.map((p, i) => {
          // Spine at x = 1 (the fold line), outer edge at x = 0 or 2.
          const spine = new Vector3(1, 0, 0).applyMatrix4(mats[i]!);
          const outer = new Vector3(p.col === 0 ? 0 : 2, 0, 0).applyMatrix4(mats[i]!);
          return [xz(spine), xz(outer)];
        });
        for (const seam of tl.seams) {
          seamStrip(seam, mats[seam.a]!, mats[seam.b]!, 16, out, tl.spineAxisAt(t, 10));
          lines.push(Array.from({ length: 17 }, (_, k): P => [out[k * 6]!, out[k * 6 + 2]!]));
        }
        for (let i = 0; i < lines.length; i++) {
          for (let j = i + 1; j < lines.length; j++) {
            const A = lines[i]!;
            const B = lines[j]!;
            for (let a = 0; a + 1 < A.length; a++) {
              for (let b = 0; b + 1 < B.length; b++) {
                if (properlyCross(A[a]!, A[a + 1]!, B[b]!, B[b + 1]!)) {
                  crossings.push(`${id} ${pages}p at t=${t.toFixed(2)}: pieces ${i} and ${j}`);
                }
              }
            }
          }
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it('trims the head folds of a signature when reading starts, keeping the spine', () => {
    const r = recipe('signature-8');
    const tl = buildTimeline(r, buildPlan(r, 8), ASPECT);
    const read = tl.segments.find((s) => s.kind === 'read')!;
    const spine = tl.seams.filter((s) => s.spine);
    const bolts = tl.seams.filter((s) => !s.spine);
    expect(spine.length).toBeGreaterThan(0);
    expect(bolts.length).toBeGreaterThan(0);
    expect(spine.every((s) => s.cutAt === Infinity)).toBe(true);
    expect(bolts.every((s) => s.cutAt === read.start)).toBe(true);
  });

  it('keeps a page grabbed away from its edge attached to the pointer', () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    const tl = buildTimeline(r, plan, ASPECT);
    const turn = tl.pageTurn!;
    const mats = tl.panels.map(() => new Matrix4());
    // Leaf 1 (pages 3/4) is panel 3, spine at x = 1. Take the point halfway out (x = 1.5).
    for (const explode of [1, 10]) {
      for (const p of [0, 0.3, 0.7]) {
        tl.poseAt(turn.timeFor(1, p), explode, mats);
        const w = new Vector3(1.5, -0.5 * ASPECT, 0).applyMatrix4(mats[3]!);
        expect(turn.reachAt(1, w.x, w.y, w.z, explode)).toBeCloseTo(0.5, 6);
      }
    }
    // With that reach, moving the pointer from x = 1.5 to the spine turns the page halfway, not
    // the 1/3 the outer-edge mapping would give.
    expect(turn.progressAt(1.5, 0, 0.5)).toBeCloseTo(0, 9);
    expect(turn.progressAt(1, 0, 0.5)).toBeCloseTo(0.5, 9);
    expect(turn.progressAt(0.5, 0, 0.5)).toBeCloseTo(1, 9);
    expect(turn.progressOf(turn.timeFor(2, 0.25), 2)).toBeCloseTo(0.25, 9);
  });

  it('builds fold-only timelines for sequence recipes', () => {
    const r = recipe('tri-fold-roll');
    const tl = buildTimeline(r, buildPlan(r, 6), ASPECT);
    expect(tl.segments.map((s) => s.kind)).toEqual(['fold', 'fold']);
    expect(tl.leafCount).toBe(0);
  });
});
