import { describe, expect, it } from 'vitest';
import { buildPlan, builtinRecipes, type Gang } from '../src/engine';
import {
  layoutSheets,
  MM,
  PAGE_SIZES,
  PRINT_PRESETS,
  sheetGuides,
  type PrintOptions,
  type Rect,
  type Segment,
  type SheetLayout,
} from '../src/pdf/geometry';

const recipe = (id: string) => builtinRecipes.find((r) => r.id === id)!;
const mm = (pt: number) => Math.round((pt / MM) * 100) / 100;
const size = (id: string) => {
  const s = PAGE_SIZES.find((p) => p.id === id)!;
  return { w: s.w * MM, h: s.h * MM };
};
const vertical = (s: Segment) => Math.abs(s.x1 - s.x2) < 1e-6;
const span = (s: Segment): [number, number] =>
  vertical(s)
    ? [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]
    : [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** A line in `lines` at `at` (vertical: x = at) covering `from`…`to`. */
function covered(lines: Segment[], isVertical: boolean, at: number, from: number, to: number) {
  return lines.some((l) => {
    if (vertical(l) !== isVertical || !near(isVertical ? l.x1 : l.y1, at)) return false;
    const [a, b] = span(l);
    return a <= from + 1e-6 && b >= to - 1e-6;
  });
}

describe('two TN Passport spreads on A4 at 100 %', () => {
  // Saddle stitch, 16 pages: 4 folded sheets, two per printed sheet, cut and stacked.
  const plan = buildPlan(recipe('saddle-stitch'), 16);
  const options: PrintOptions = {
    ...PRINT_PRESETS.home.options,
    orientation: 'portrait',
    scaling: 'actual',
    cropMarks: true,
    foldMarks: true,
    gang: { across: 1, down: 2, order: 'stack' },
  };

  it.each([
    ['turned like a book page', 'auto'],
    ['turned top to bottom', 'short'],
  ] as const)(
    'puts every fold on the sheet’s centre line and cuts round each spread (%s)',
    (_, flip) => {
      const l = layoutSheets(plan, size('tn-passport'), { ...options, flip });
      expect([mm(l.width), mm(l.height), l.scale]).toEqual([210, 297, 1]);
      expect(l.gang.papers).toBe(2);
      for (const side of ['front', 'back'] as const) {
        const g = sheetGuides(l, 0, side);
        // The fold is the sheet's centre line, through both spreads.
        expect(g.folds.map((f) => [mm(f.x1), mm(f.x2)])).toEqual([[105, 105]]);
        // Cuts: 89 mm either side of it, and above, between and below the two 124 mm spreads.
        const xs = g.cuts.filter(vertical).map((c) => mm(c.x1));
        const ys = g.cuts.filter((c) => !vertical(c)).map((c) => mm(c.y1));
        expect(xs.sort((a, b) => a - b)).toEqual([16, 194]);
        expect(ys.sort((a, b) => a - b)).toEqual([24.5, 148.5, 272.5]);
        // What is kept: two 178 × 124 mm spreads, the fold through the middle of each.
        expect(g.pieces.map((p) => [mm(p.rect.x), mm(p.rect.w), mm(p.rect.h)])).toEqual([
          [16, 178, 124],
          [16, 178, 124],
        ]);
      }
    },
  );
});

describe('the marks fit the parts they are for', () => {
  const pieceEdges = (r: Rect) =>
    [
      [true, r.x, r.y, r.y + r.h],
      [true, r.x + r.w, r.y, r.y + r.h],
      [false, r.y, r.x, r.x + r.w],
      [false, r.y + r.h, r.x, r.x + r.w],
    ] as const;

  /** `margin`: cut guides stop at the printer margin (sections), so cuts span the rest. */
  function check(l: SheetLayout, cols: number, rows: number, margin = 0) {
    for (let paper = 0; paper < l.gang.papers; paper++) {
      for (const side of ['front', 'back'] as const) {
        const g = sheetGuides(l, paper, side);
        for (const { rect } of g.pieces) {
          // Every edge of every part is on a cut line that runs its whole length (unless it is the
          // sheet's own edge, as a section's can be)…
          for (const [v, at, a, b] of pieceEdges(rect)) {
            if (near(at, 0) || near(at, v ? l.width : l.height)) continue;
            const end = v ? l.height : l.width;
            const [from, to] = [Math.max(a, margin), Math.min(b, end - margin)];
            expect(
              covered(g.cuts, v, at, from, to),
              `${side} edge ${v ? 'x' : 'y'} = ${mm(at)}`,
            ).toBe(true);
          }
          // …and every panel line inside it is on a fold line.
          for (let c = 1; c < cols; c++) {
            const x = rect.x + (c * rect.w) / cols;
            expect(
              covered(
                g.folds,
                true,
                x,
                Math.max(rect.y, margin),
                Math.min(rect.y + rect.h, l.height - margin),
              ),
            ).toBe(true);
          }
          for (let r = 1; r < rows; r++) {
            const y = rect.y + (r * rect.h) / rows;
            expect(
              covered(
                g.folds,
                false,
                y,
                Math.max(rect.x, margin),
                Math.min(rect.x + rect.w, l.width - margin),
              ),
            ).toBe(true);
          }
        }
        // No stray marks: each cut is on a part's edge, each fold on a panel line.
        for (const cut of g.cuts) {
          const at = vertical(cut) ? cut.x1 : cut.y1;
          const onEdge = g.pieces.some(({ rect }) =>
            pieceEdges(rect).some(([v, e]) => v === vertical(cut) && near(e, at)),
          );
          expect(onEdge, `cut at ${mm(at)} mm`).toBe(true);
        }
        for (const fold of g.folds) {
          const at = vertical(fold) ? fold.x1 : fold.y1;
          const onPanelLine = g.pieces.some(({ rect }) => {
            const [start, len, n] = vertical(fold)
              ? [rect.x, rect.w, cols]
              : [rect.y, rect.h, rows];
            return Array.from({ length: n - 1 }, (_, k) => start + ((k + 1) * len) / n).some((p) =>
              near(p, at),
            );
          });
          expect(onPanelLine, `fold at ${mm(at)} mm`).toBe(true);
        }
      }
    }
  }

  const gangs: Gang[] = [
    { across: 1, down: 1, order: 'stack' },
    { across: 1, down: 2, order: 'stack' },
    { across: 2, down: 2, order: 'stack' },
    { across: 2, down: 1, order: 'copies' },
  ];
  it.each(
    (['saddle-stitch', 'signature-8', 'z-fold'] as const).flatMap((id) =>
      gangs.flatMap((gang) =>
        (['auto', 'short', 'long'] as const).flatMap((flip) =>
          [
            { bleed: 0, gutter: 0 },
            { bleed: 3, gutter: 4 },
          ].map((b) => [id, gang, flip, b] as const),
        ),
      ),
    ),
  )('%s, %o, flip %s, %o', (id, gang, flip, b) => {
    const r = recipe(id);
    const plan = buildPlan(r, 24);
    const l = layoutSheets(plan, size('a6'), {
      ...PRINT_PRESETS.shop.options,
      sheet: { kind: 'preset', id: 'a3' },
      scaling: 'fit',
      gang,
      flip,
      ...b,
    });
    check(l, r.grid.cols, r.grid.rows);
  });

  it('works for a sheet divided into sections', () => {
    const r = recipe('saddle-stitch');
    const l = layoutSheets(buildPlan(r, 12), size('a6'), {
      ...PRINT_PRESETS.home.options,
      cropMarks: true,
      foldMarks: true,
      sections: { across: 3, down: 1, blank: 'end' },
    });
    expect(l.paper.sectioned).toBe(true);
    check(l, r.grid.cols, r.grid.rows, PRINT_PRESETS.home.options.margin * MM);
  });
});
