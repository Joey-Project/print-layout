import { Matrix4, Vector3 } from 'three';
import { buildPlan, builtinRecipes, type Plan, type Recipe } from '../src/engine';
import { buildTimeline } from '../src/viewer/timeline';

const recipe = (id: string): Recipe => builtinRecipes.find((r) => r.id === id)!;
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
  ];

  it.each(cases)('%s with %i pages reads in order while turning leaves', (id, pages) => {
    const r = recipe(id);
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
      // sit halfway between spine and pointer.
      const c = new Vector3(1.5, -0.5 * ASPECT, 0).applyMatrix4(mats[3]!);
      expect(c.x).toBeCloseTo(spineX + 0.5 * Math.cos(Math.PI * p), 6);
    }
  });

  it('builds fold-only timelines for sequence recipes', () => {
    const r = recipe('tri-fold-roll');
    const tl = buildTimeline(r, buildPlan(r, 6), ASPECT);
    expect(tl.segments.map((s) => s.kind)).toEqual(['fold', 'fold']);
    expect(tl.leafCount).toBe(0);
  });
});
