import { beforeAll, describe, expect, it } from 'vitest';
import { accordion, buildPlan, builtinRecipes, isAccordion, splitStrip } from '../src/engine';
import {
  activeJoin,
  layoutSheets,
  MM,
  PRINT_PRESETS,
  type PrintOptions,
} from '../src/pdf/geometry';
import { exportImposed } from '../src/pdf/pdfFiles';

const PAGE = { w: 90 * MM, h: 60 * MM };
const strip = (panels: number) => buildPlan(accordion(panels), 2 * panels);
const options = (o: Partial<PrintOptions> = {}): PrintOptions => ({
  ...PRINT_PRESETS.home.options,
  sheet: { kind: 'preset', id: 'a4' },
  orientation: 'landscape',
  scaling: 'actual',
  join: { panels: 3, tab: 8 },
  ...o,
});

describe('accordions of any length', () => {
  it('recognises a plain accordion of any panel count', () => {
    expect(isAccordion(accordion(4))).toBe(true);
    expect(isAccordion(accordion(13))).toBe(true);
    expect(isAccordion({ ...accordion(5), grid: { cols: 6, rows: 1 } })).toBe(false);
    // One built-in: its panel count is set beside it.
    expect(builtinRecipes.filter(isAccordion).map((r) => [r.id, r.name])).toEqual([
      ['accordion-4', 'Accordion'],
    ]);
  });
});

describe('splitting a strip into pieces', () => {
  it('cuts at the fold lines, the last piece shorter', () => {
    const plan = strip(7);
    const { plan: pieces, pieces: info } = splitStrip(plan, 3);
    expect(pieces.grid).toEqual({ cols: 3, rows: 1 });
    expect(info.map((p) => [p.index, p.first, p.count])).toEqual([
      [0, 0, 3],
      [1, 3, 3],
      [2, 6, 1],
    ]);
    // Every page is still printed once, on the same side.
    for (const side of ['front', 'back'] as const) {
      const before = plan.sheets.flatMap((s) => s[side].map((x) => x.page)).sort();
      const after = pieces.sheets.flatMap((s) => s[side].map((x) => x.page)).sort();
      expect(after).toEqual(before);
    }
  });

  it("keeps each panel's back behind its front", () => {
    const plan = strip(7);
    const { cols } = plan.grid;
    const { plan: pieces } = splitStrip(plan, 3);
    const sheet = plan.sheets[0]!;
    for (let c = 0; c < cols; c++) {
      // Strip front column c and the back panel behind it (back view column cols − 1 − c)...
      const front = sheet.front.find((s) => s.col === c)!;
      const back = sheet.back.find((s) => s.col === cols - 1 - c)!;
      // ...land in the same piece, the back behind the front there too.
      const p = Math.floor(c / 3);
      const lc = c % 3;
      expect(pieces.sheets[p]!.front.find((s) => s.col === lc)!.page).toBe(front.page);
      expect(pieces.sheets[p]!.back.find((s) => s.col === 3 - 1 - lc)!.page).toBe(back.page);
    }
  });

  it('leaves a strip that fits in one piece alone', () => {
    expect(activeJoin(options({ join: { panels: 7, tab: 8 } }), { cols: 7, rows: 1 })).toBeNull();
    expect(activeJoin(options(), { cols: 7, rows: 1 })).not.toBeNull();
    const l = layoutSheets(strip(3), PAGE, options());
    expect(l.pieces).toBeNull();
  });
});

describe('laying out pieces with glue tabs', () => {
  const plan = strip(7);

  it.each([
    ['turned like a book page', 'auto'],
    ['turned top to bottom', 'long'],
  ] as const)('registers every back behind its front (%s)', (_name, flip) => {
    const l = layoutSheets(plan, PAGE, options({ flip }));
    expect(l.scale).toBe(1);
    expect(l.gang.papers).toBe(3);
    expect(l.units[0]![0]!.w).toBeCloseTo(3 * PAGE.w + 8 * MM);
    expect(l.backRotated).toBe(flip === 'long');
    for (let paper = 0; paper < 3; paper++) {
      const front = l.place(paper, 'front');
      const back = l.place(paper, 'back');
      for (const f of front) {
        const b = back.find((s) => s.slot.col === 3 - 1 - f.slot.col)!;
        // The back's rectangle is the front's seen through the sheet.
        const expected = l.backRotated
          ? { x: f.rect.x, y: l.height - f.rect.y - f.rect.h }
          : { x: l.width - f.rect.x - f.rect.w, y: f.rect.y };
        expect(b.rect.x).toBeCloseTo(expected.x);
        expect(b.rect.y).toBeCloseTo(expected.y);
      }
    }
  });

  it('puts a tab after every piece but the last, and marks the last one’s empty end', () => {
    const l = layoutSheets(plan, PAGE, options({ foldMarks: true }));
    const u = l.units[0]![0]!;
    const first = l.joins(0, 'front');
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0]!.rect.x).toBeCloseTo(u.x + 3 * PAGE.w);
    expect(first.tabs[0]!.rect.w).toBeCloseTo(8 * MM);
    expect(first.tabs[0]!.label).toBe('piece 1 of 3 · glue under piece 2');
    expect(first.waste).toHaveLength(0);
    const last = l.joins(2, 'front');
    expect(last.tabs).toHaveLength(0);
    expect(last.waste).toHaveLength(1);
    expect(last.waste[0]!.x).toBeCloseTo(u.x + PAGE.w);
    expect(last.waste[0]!.w).toBeCloseTo(2 * PAGE.w + 8 * MM);
    expect(last.guides.map((g) => g.x1)).toEqual([u.x + PAGE.w, u.x + PAGE.w]);
    // On the back, the empty end is behind the front's.
    const lastBack = l.joins(2, 'back');
    expect(lastBack.waste[0]!.x).toBeCloseTo(l.width - u.x - u.w);
    // The last piece's panel has bleed on its real end; the tab's root is folded.
    expect(l.place(2, 'front')[0]!.outer.right).toBe(true);
    const foldXs = [...new Set(l.foldMarks.map((m) => Math.round(m.x1 * 100) / 100))];
    expect(foldXs).toContainEqual(Math.round((u.x + 3 * PAGE.w) * 100) / 100);
    expect(l.warnings.some((w) => w.includes('8 mm of its back'))).toBe(true);
  });

  it('leaves room for the tabs when scaling to fit', () => {
    // Four panels and a tab are wider than A4: the panels shrink, the tab does not.
    const l = layoutSheets(plan, PAGE, options({ scaling: 'fit', join: { panels: 4, tab: 8 } }));
    expect(l.scale).toBeLessThan(1);
    expect(l.trim.w).toBeCloseTo(l.width - 2 * 5 * MM);
    expect(l.units[0]![0]!.w).toBeCloseTo(4 * PAGE.w * l.scale + 8 * MM);
  });

  it('fits several pieces on one sheet', () => {
    const l = layoutSheets(
      plan,
      PAGE,
      options({ gang: { across: 1, down: 3, order: 'stack' }, gutter: 2 }),
    );
    expect(l.scale).toBe(1);
    expect(l.gang.papers).toBe(1);
    expect(l.place(0, 'front')).toHaveLength(7);
    expect(l.joins(0, 'front').tabs).toHaveLength(2);
  });
});

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfJs;
beforeAll(async () => {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
});

/** The dummy's big page numbers on each output page, with the centre of each (PDF points, y up). */
async function numbersAt(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: { n: number; x: number; y: number; upright: boolean }[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    const found: (typeof pages)[number] = [];
    for (const it of items) {
      if (!('str' in it) || !/^\d+$/.test(it.str)) continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      const size = Math.hypot(c!, d!);
      if (size < 10) continue;
      found.push({
        n: Number(it.str),
        x: e! + (a! * it.width) / 2 / size + c! * 0.3,
        y: f! + (b! * it.width) / 2 / size + d! * 0.3,
        upright: a! > 0 && Math.abs(b!) < 1e-6,
      });
    }
    pages.push(found);
  }
  return pages;
}

describe('exporting a strip in pieces', () => {
  it.each([
    ['turned like a book page', 'auto'],
    ['turned top to bottom', 'long'],
  ] as const)('prints every page in its panel (%s)', async (_name, flip) => {
    const r = accordion(7);
    const plan = buildPlan(r, 14);
    const o = options({ flip, gang: { across: 1, down: 3, order: 'stack' }, gutter: 2 });
    const { files, layout } = await exportImposed({
      plan,
      recipe: r,
      source: null,
      dummyPageSize: PAGE,
      options: o,
      baseName: 'test',
    });
    const pages = await numbersAt(files[0]!.bytes);
    expect(pages).toHaveLength(2);
    const seen: number[] = [];
    (['front', 'back'] as const).forEach((side, i) => {
      for (const placed of layout.place(0, side)) {
        const { rect } = placed;
        const inside = pages[i]!.filter(
          (p) => p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h,
        );
        expect(inside.map((p) => p.n)).toEqual([placed.slot.page]);
        expect(inside[0]!.upright).toBe(placed.rotation === 0);
        seen.push(placed.slot.page!);
      }
    });
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });
});
