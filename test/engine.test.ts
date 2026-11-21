import {
  buildPlan,
  builtinRecipes,
  foldAll,
  packetBounds,
  recipeProblems,
  type Plan,
  type Recipe,
  type Slot,
} from '../src/engine';

const recipe = (id: string): Recipe => {
  const r = builtinRecipes.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
};

/** Pages per side as rows of "page" (blank = 0), with a trailing "↻" for 180° rotation. */
function layout(slots: Slot[], cols: number): string[] {
  const rows: string[] = [];
  for (const s of slots) {
    const label = `${s.page ?? 0}${s.rotation === 180 ? '↻' : ''}`;
    rows[s.row] = rows[s.row] === undefined ? label : `${rows[s.row]} ${label}`;
  }
  expect(slots.length % cols).toBe(0);
  return rows;
}

const sides = (plan: Plan) =>
  plan.sheets.map((s) => ({
    front: layout(s.front, plan.grid.cols),
    back: layout(s.back, plan.grid.cols),
  }));

describe('saddle stitch', () => {
  it('imposes 8 pages on 2 nested sheets', () => {
    expect(sides(buildPlan(recipe('saddle-stitch'), 8))).toEqual([
      { front: ['8 1'], back: ['2 7'] },
      { front: ['6 3'], back: ['4 5'] },
    ]);
  });

  it('imposes 12 pages on 3 nested sheets', () => {
    expect(sides(buildPlan(recipe('saddle-stitch'), 12))).toEqual([
      { front: ['12 1'], back: ['2 11'] },
      { front: ['10 3'], back: ['4 9'] },
      { front: ['8 5'], back: ['6 7'] },
    ]);
  });

  it('pads with blanks before the back cover', () => {
    const plan = buildPlan(recipe('saddle-stitch'), 10);
    expect(plan.slotCount).toBe(12);
    expect(sides(plan)).toEqual([
      { front: ['10 1'], back: ['2 0'] },
      { front: ['0 3'], back: ['4 9'] },
      { front: ['8 5'], back: ['6 7'] },
    ]);
  });

  it('mirrors for right-to-left binding', () => {
    expect(sides(buildPlan(recipe('saddle-stitch-rtl'), 8))).toEqual([
      { front: ['1 8'], back: ['7 2'] },
      { front: ['3 6'], back: ['5 4'] },
    ]);
  });
});

describe('signatures', () => {
  it('gathers separate 4-sheet sections', () => {
    const plan = buildPlan(recipe('sewn-signatures-4'), 20);
    expect(plan.sheets).toHaveLength(5);
    // First section holds pages 1–16; its outer sheet carries 16 and 1.
    expect(sides(plan)[0]).toEqual({ front: ['16 1'], back: ['2 15'] });
    // The last section is a single sheet with pages 17–20.
    expect(sides(plan)[4]).toEqual({ front: ['20 17'], back: ['18 19'] });
  });

  it('prints an 8-page signature head-to-head', () => {
    expect(sides(buildPlan(recipe('signature-8'), 8))).toEqual([
      { front: ['5↻ 4↻', '8 1'], back: ['3↻ 6↻', '2 7'] },
    ]);
  });
});

describe('sequence recipes', () => {
  it('reads an accordion across the front, then the back', () => {
    expect(sides(buildPlan(recipe('accordion-4'), 8))).toEqual([
      { front: ['1 2 3 4'], back: ['5 6 7 8'] },
    ]);
  });

  it('lays out the mini zine on one side with the top row upside down', () => {
    const plan = buildPlan(recipe('mini-zine-8'), 8);
    expect(plan.pagesPerSheet).toBe(8);
    expect(sides(plan)).toEqual([{ front: ['5↻ 4↻ 3↻ 2↻', '6 7 8 1'], back: [] }]);
  });

  it('every fold program collapses to a single panel', () => {
    for (const r of builtinRecipes.filter((x) => x.folds.length > 0)) {
      const b = packetBounds(foldAll(1, r.grid, r.folds));
      expect([b.x1 - b.x0, b.y1 - b.y0], r.id).toEqual([1, 1]);
    }
  });
});

describe('every built-in recipe', () => {
  it.each(builtinRecipes.map((r) => [r.id, r] as const))('%s is valid and complete', (_, r) => {
    expect(recipeProblems(r)).toEqual([]);
    for (const pages of [1, 5, 17, 40]) {
      const plan = buildPlan(r, pages);
      const all = plan.sheets.flatMap((s) => [...s.front, ...s.back]);
      // Each reading position appears exactly once and every source page is placed exactly once.
      expect(all.map((s) => s.position).sort((a, b) => a - b)).toEqual(
        Array.from({ length: plan.slotCount }, (_, i) => i + 1),
      );
      expect(
        all
          .map((s) => s.page)
          .filter((p) => p !== null)
          .sort((a, b) => a! - b!),
      ).toEqual(Array.from({ length: pages }, (_, i) => i + 1));
      // No panel is used twice on the same side.
      for (const s of plan.sheets) {
        for (const side of [s.front, s.back]) {
          expect(new Set(side.map((x) => `${x.col},${x.row}`)).size).toBe(side.length);
        }
      }
    }
  });
});

describe('recipe validation', () => {
  const base = recipe('saddle-stitch');

  it('rejects non-objects and missing fields', () => {
    expect(recipeProblems(null)).toEqual(['Recipe must be a JSON object.']);
    expect(recipeProblems({}).length).toBeGreaterThan(3);
  });

  it('rejects folds outside the packet', () => {
    const bad = { ...base, folds: [{ axis: 'x', at: 2, move: 'low', to: 'under' }] };
    expect(recipeProblems(bad).join()).toMatch(/outside the current packet/);
  });

  it('rejects bound recipes that do not fold to one page', () => {
    expect(recipeProblems({ ...base, folds: [] }).join()).toMatch(/exactly one panel/);
  });

  it('rejects duplicate sequence panels', () => {
    const bad = {
      ...recipe('accordion-4'),
      reading: {
        mode: 'sequence',
        order: [
          { side: 'front', col: 0, row: 0 },
          { side: 'front', col: 0, row: 0 },
        ],
      },
    };
    expect(recipeProblems(bad).join()).toMatch(/repeats a panel/);
  });
});
