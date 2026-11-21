import { buildPlan, builtinRecipes, type Recipe } from '../src/engine';
import {
  fitInPanel,
  layoutSheets,
  MM,
  placedPoint,
  placePage,
  PRINT_PRESETS,
  type PrintOptions,
} from '../src/pdf/geometry';

const recipe = (id: string): Recipe => builtinRecipes.find((r) => r.id === id)!;
const A5 = { w: 148 * MM, h: 210 * MM };
const opts = (preset: keyof typeof PRINT_PRESETS, o: Partial<PrintOptions> = {}): PrintOptions => ({
  ...PRINT_PRESETS[preset].options,
  ...o,
});

describe('sheet layout', () => {
  const r = recipe('saddle-stitch');
  const plan = buildPlan(r, 8);

  it('fits an A5 booklet on landscape A4 for a home printer, backs unrotated', () => {
    const l = layoutSheets(plan, A5, opts('home'));
    expect(l.orientation).toBe('landscape');
    expect(l.width).toBeCloseTo(297 * MM, 6);
    expect(l.scale).toBeLessThan(1); // 5 mm printer margins
    expect(l.scale).toBeCloseTo(200 / 210, 6);
    expect(l.printerFlip).toBe('short');
    expect(l.backRotated).toBe(false);
    // Centred on the sheet.
    expect(l.trim.x * 2 + l.trim.w).toBeCloseTo(l.width, 6);
    expect(l.trim.y * 2 + l.trim.h).toBeCloseTo(l.height, 6);
  });

  it('places panels left to right, top row first, in the side view', () => {
    const l = layoutSheets(plan, A5, opts('home'));
    const front = l.place(0, 'front');
    const p8 = front.find((p) => p.slot.page === 8)!;
    const p1 = front.find((p) => p.slot.page === 1)!;
    expect(p8.rect.x).toBeCloseTo(l.trim.x, 6);
    expect(p1.rect.x).toBeCloseTo(l.trim.x + l.trim.w / 2, 6);
    expect(p8.outer).toEqual({ top: true, bottom: true, left: true, right: false });
  });

  it('builds an exact-size print-shop sheet with bleed, crop and fold marks', () => {
    const l = layoutSheets(plan, A5, opts('shop'));
    expect(l.scale).toBe(1);
    // 3 mm offset + 5 mm marks on each side.
    expect(l.width / MM).toBeCloseTo(296 + 16, 6);
    expect(l.height / MM).toBeCloseTo(210 + 16, 6);
    expect(l.bleed.w / MM).toBeCloseTo(296 + 6, 6);
    expect(l.cropMarks).toHaveLength(8);
    // One vertical fold: a mark above and below the trim, on the fold line.
    expect(l.foldMarks).toHaveLength(2);
    expect(l.foldMarks[0]!.x1).toBeCloseTo(l.trim.x + 148 * MM, 6);
    for (const m of [...l.cropMarks, ...l.foldMarks]) {
      for (const [x, y] of [
        [m.x1, m.y1],
        [m.x2, m.y2],
      ] as const) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(l.width + 1e-9);
        expect(y).toBeLessThanOrEqual(l.height + 1e-9);
        // Marks stay out of the bleed.
        const inside =
          x > l.bleed.x + 1e-9 &&
          x < l.bleed.x + l.bleed.w - 1e-9 &&
          y > l.bleed.y + 1e-9 &&
          y < l.bleed.y + l.bleed.h - 1e-9;
        expect(inside).toBe(false);
      }
    }
  });

  it('rotates backs by 180° when the printer flips the other way', () => {
    const l = layoutSheets(plan, A5, opts('home', { flip: 'long' }));
    expect(l.backRotated).toBe(true);
    const natural = layoutSheets(plan, A5, opts('home')).place(0, 'back');
    const turned = l.place(0, 'back');
    for (const p of turned) {
      const q = natural.find((n) => n.slot === p.slot)!;
      expect(p.rotation).toBe((q.rotation + 180) % 360);
      // Mirrored through the sheet centre.
      expect(p.rect.x + p.rect.w / 2 + (q.rect.x + q.rect.w / 2)).toBeCloseTo(l.width, 6);
    }
  });

  it.each([
    ['labels without marks', { slug: true, cropMarks: false, foldMarks: false }],
    ['marks and labels', { slug: true, cropMarks: true, foldMarks: true }],
  ] as const)('registers turned backs behind their fronts with %s', (_n, extra) => {
    for (const sheet of [{ kind: 'fit' } as const, { kind: 'preset', id: 'a4' } as const]) {
      const l = layoutSheets(plan, A5, opts('shop', { ...extra, sheet, flip: 'long' }));
      expect(l.backRotated).toBe(true);
      // Centred, so turning the sheet top ↔ bottom maps the trim onto itself.
      expect(l.trim.x * 2 + l.trim.w).toBeCloseTo(l.width, 6);
      expect(l.trim.y * 2 + l.trim.h).toBeCloseTo(l.height, 6);
      // Each back panel sits exactly behind the front panel it shares paper with. Turning the sheet
      // top ↔ bottom sends front point (x, y) to back-page point (x, H − y).
      const front = l.place(0, 'front');
      for (const b of l.place(0, 'back')) {
        const frontCol = r.grid.cols - 1 - b.slot.col; // back-view column → front column
        const f = front.find((x) => x.slot.col === frontCol && x.slot.row === b.slot.row)!;
        expect(b.rect.x).toBeCloseTo(f.rect.x, 6);
        expect(b.rect.y).toBeCloseTo(l.height - (f.rect.y + f.rect.h), 6);
      }
      if (l.slugAt) expect(l.slugAt.y).toBeGreaterThan(0);
    }
  });

  it('keeps bleed, marks and labels inside the printer margin', () => {
    for (const extra of [
      { cropMarks: true },
      { cropMarks: true, foldMarks: true, slug: true, bleed: 3 },
      { slug: true },
    ]) {
      const l = layoutSheets(plan, A5, opts('home', extra));
      const margin = 5 * MM;
      const inside = (x: number, y: number) =>
        x >= margin - 1e-9 &&
        y >= margin - 1e-9 &&
        x <= l.width - margin + 1e-9 &&
        y <= l.height - margin + 1e-9;
      for (const m of [...l.cropMarks, ...l.foldMarks]) {
        expect(inside(m.x1, m.y1) && inside(m.x2, m.y2)).toBe(true);
      }
      expect(inside(l.bleed.x, l.bleed.y)).toBe(true);
      expect(inside(l.bleed.x + l.bleed.w, l.bleed.y + l.bleed.h)).toBe(true);
      if (l.slugAt) expect(inside(l.slugAt.x, l.slugAt.y)).toBe(true);
    }
  });

  it('warns when 100 % does not fit', () => {
    const l = layoutSheets(plan, A5, opts('shop', { sheet: { kind: 'preset', id: 'a4' } }));
    expect(l.warnings.join(' ')).toMatch(/does not fit/);
  });
});

describe('placing a source page into a panel', () => {
  const trim = { x: 10, y: 20, w: 100, h: 200 };
  const outer = { top: false, right: false, bottom: false, left: false };
  const corners = (p: ReturnType<typeof placePage>) => {
    const tl = placedPoint(p, trim.x, trim.y + trim.h);
    const br = placedPoint(p, trim.x + trim.w, trim.y);
    return { tl, br };
  };

  it('fills the panel, upright, with no rotation', () => {
    const rect = { x: 0, y: 0, w: 50, h: 100 };
    const p = placePage({ rotate: 0, trim }, rect, 0, outer, 0);
    const { tl, br } = corners(p);
    expect(tl[0]).toBeCloseTo(0, 9);
    expect(tl[1]).toBeCloseTo(100, 9);
    expect(br[0]).toBeCloseTo(50, 9);
    expect(br[1]).toBeCloseTo(0, 9);
  });

  it('prints head-down slots rotated 180°', () => {
    const rect = { x: 0, y: 0, w: 50, h: 100 };
    const { tl, br } = corners(placePage({ rotate: 0, trim }, rect, 180, outer, 0));
    expect(tl).toEqual([expect.closeTo(50, 9), expect.closeTo(0, 9)]);
    expect(br).toEqual([expect.closeTo(0, 9), expect.closeTo(100, 9)]);
  });

  it('honours the page /Rotate (shown turned clockwise)', () => {
    // A 100×200 page with /Rotate 90 shows as 200 wide × 100 high; its unrotated top-left corner is
    // then at the top-right.
    const rect = { x: 0, y: 0, w: 200, h: 100 };
    const { tl, br } = corners(placePage({ rotate: 90, trim }, rect, 0, outer, 0));
    expect(tl).toEqual([expect.closeTo(200, 9), expect.closeTo(100, 9)]);
    expect(br).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    const r270 = corners(placePage({ rotate: 270, trim }, rect, 0, outer, 0));
    expect(r270.tl).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    // /Rotate 90 plus a head-down slot = 270.
    const both = corners(placePage({ rotate: 90, trim }, rect, 180, outer, 0));
    expect(both.tl).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
  });

  it('centres a page of a different shape', () => {
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    const { tl, br } = corners(placePage({ rotate: 0, trim }, rect, 0, outer, 0));
    expect(tl).toEqual([expect.closeTo(25, 9), expect.closeTo(100, 9)]);
    expect(br).toEqual([expect.closeTo(75, 9), expect.closeTo(0, 9)]);
  });

  it('adds bleed only on outer edges, mapped through the rotation', () => {
    const rect = { x: 0, y: 0, w: 50, h: 100 };
    const left = { ...outer, left: true };
    const up = placePage({ rotate: 0, trim }, rect, 0, left, 5);
    expect(up.box.left).toBeCloseTo(trim.x - 10, 9); // 5 pt on the sheet at scale 0.5
    expect(up.box.right).toBeCloseTo(trim.x + trim.w, 9);
    // Head-down: the panel's left edge is the page's right edge.
    const down = placePage({ rotate: 0, trim }, rect, 180, left, 5);
    expect(down.box.right).toBeCloseTo(trim.x + trim.w + 10, 9);
    expect(down.box.left).toBeCloseTo(trim.x, 9);
    // The trim still lands exactly on the panel; the bleed hangs off the left.
    const { tl } = corners(down);
    expect(tl).toEqual([expect.closeTo(50, 9), expect.closeTo(0, 9)]);
    expect(placedPoint(down, trim.x + trim.w + 10, trim.y)[0]).toBeCloseTo(-5, 9);
  });
});

describe('fitting a page of another shape into a panel', () => {
  it('matches the exporter: uniform scale, centred', () => {
    // A landscape A5 page in a portrait A5 panel: full width, centred vertically.
    const f = fitInPanel(210, 148, 210 / 148);
    expect(f.W).toBeCloseTo(210, 9);
    expect(f.H).toBeCloseTo(210 * (210 / 148), 9);
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.y).toBeCloseTo((f.H - 148) / 2, 9);
    // Same answer as placePage, scaled to the panel.
    const rect = { x: 0, y: 0, w: f.W, h: f.H };
    const p = placePage(
      { rotate: 0, trim: { x: 0, y: 0, w: 210, h: 148 } },
      rect,
      0,
      {
        top: false,
        right: false,
        bottom: false,
        left: false,
      },
      0,
    );
    const [, top] = placedPoint(p, 0, 148);
    expect(f.H - top).toBeCloseTo(f.y, 9); // distance from the panel's top edge
  });
});
