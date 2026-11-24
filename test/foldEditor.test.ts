import { describe, expect, it } from 'vitest';
import {
  builtinRecipes,
  foldLabel,
  foldLines,
  foldProgress,
  importRecipes,
  RECIPE_FILE_KIND,
  recipeFileText,
  stackDepths,
  type Recipe,
} from '../src/engine';

const recipe = (id: string) => builtinRecipes.find((r) => r.id === id)!;

describe('fold editor model', () => {
  it('starts from the flat sheet and offers every inner grid line', () => {
    const p = foldProgress({ cols: 3, rows: 2 }, []);
    expect(p.stages).toHaveLength(1);
    expect(p.done).toBe(false);
    expect(foldLines(p.stages[0]!.bounds)).toEqual([
      { axis: 'x', at: 1 },
      { axis: 'x', at: 2 },
      { axis: 'y', at: 1 },
    ]);
    expect(stackDepths(p.stages[0]!)).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ]);
  });

  it('follows the packet fold by fold, with the layers on each panel', () => {
    // Fold the right third under, then the left third over: a tri-fold.
    const p = foldProgress({ cols: 3, rows: 1 }, [
      { axis: 'x', at: 2, move: 'high', to: 'under' },
      { axis: 'x', at: 1, move: 'low', to: 'over' },
    ]);
    expect(p.stages.map((s) => [s.bounds.x0, s.bounds.x1])).toEqual([
      [0, 3],
      [0, 2],
      [1, 2],
    ]);
    expect(stackDepths(p.stages[1]!)).toEqual([[1, 2]]);
    expect(stackDepths(p.stages[2]!)).toEqual([[3]]);
    expect(foldLines(p.stages[2]!.bounds)).toEqual([]);
    expect(p.done).toBe(true);
    expect(p.broken).toBeNull();
  });

  it('stops at a fold that no longer fits the packet', () => {
    const p = foldProgress({ cols: 2, rows: 1 }, [
      { axis: 'x', at: 1, move: 'low', to: 'under' },
      { axis: 'x', at: 1, move: 'low', to: 'under' },
    ]);
    expect(p.stages).toHaveLength(2);
    expect(p.broken?.index).toBe(1);
    expect(p.broken?.message).toMatch(/outside the current packet/);
    expect(p.done).toBe(false);
  });

  it('is not finished while panels are still side by side', () => {
    const p = foldProgress({ cols: 2, rows: 2 }, [{ axis: 'y', at: 1, move: 'low', to: 'under' }]);
    expect(p.done).toBe(false);
    expect(stackDepths(p.stages[1]!)).toEqual([[2, 2]]);
  });

  it.each(builtinRecipes.filter((r) => r.folds.length > 0).map((r) => [r.id, r] as const))(
    '%s: every fold is one the editor offers at its step',
    (_id, r) => {
      const p = foldProgress(r.grid, r.folds);
      expect(p.broken).toBeNull();
      r.folds.forEach((f, i) => {
        expect(foldLines(p.stages[i]!.bounds)).toContainEqual({ axis: f.axis, at: f.at });
      });
      // Bound recipes fold to one panel; the others may stop at a packet (e.g. a mini zine).
      if (r.reading.mode === 'bound') expect(p.done).toBe(true);
    },
  );

  it('describes a fold in words', () => {
    expect(foldLabel({ axis: 'x', at: 1, move: 'low', to: 'under' })).toBe(
      'Fold at x = 1 (vertical): left part under the rest',
    );
    expect(foldLabel({ axis: 'y', at: 2, move: 'high', to: 'over' })).toBe(
      'Fold at y = 2 (horizontal): bottom part over the rest',
    );
  });
});

describe('recipe files', () => {
  const mine: Recipe = {
    ...recipe('saddle-stitch'),
    id: 'my-booklet',
    name: 'My booklet',
  };

  it('round-trips through a file', () => {
    const text = recipeFileText([mine]);
    const json: unknown = JSON.parse(text);
    expect((json as { kind: string }).kind).toBe(RECIPE_FILE_KIND);
    const r = importRecipes(json, builtinRecipes);
    expect(r.added).toEqual([mine]);
    expect(r.problems).toEqual([]);
  });

  it('takes a bare recipe or a list of them', () => {
    expect(importRecipes(mine, []).added).toEqual([mine]);
    expect(importRecipes([mine, { ...mine, id: 'other' }], []).added.map((x) => x.id)).toEqual([
      'my-booklet',
      'other',
    ]);
  });

  it('skips a recipe it already has, whatever the key order', () => {
    const reordered = Object.fromEntries(Object.entries(mine).reverse());
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(mine)[0]);
    const r = importRecipes(reordered, [mine]);
    expect(r.added).toEqual([]);
    expect(r.same).toEqual(['my-booklet']);
  });

  it('gives a fresh id rather than replacing a different recipe', () => {
    const changed = { ...mine, name: 'Changed' };
    const r = importRecipes([changed, changed], [mine, { ...mine, id: 'my-booklet-2' }]);
    expect(r.added.map((x) => x.id)).toEqual(['my-booklet-3', 'my-booklet-4']);
    expect(r.renamed).toEqual([
      { from: 'my-booklet', to: 'my-booklet-3' },
      { from: 'my-booklet', to: 'my-booklet-4' },
    ]);
    // A built-in's id is taken too.
    expect(importRecipes({ ...recipe('z-fold'), name: 'Mine' }, builtinRecipes).added[0]!.id).toBe(
      'z-fold-2',
    );
  });

  it('leaves out recipes that do not work, saying why', () => {
    const bad = { ...mine, id: 'bad', folds: [{ axis: 'x', at: 5, move: 'low', to: 'under' }] };
    const r = importRecipes([bad, mine], []);
    expect(r.added.map((x) => x.id)).toEqual(['my-booklet']);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^Recipe 1 \(“My booklet”\): .*outside the current packet/);
    expect(importRecipes({ kind: RECIPE_FILE_KIND, recipes: 3 }, []).problems).toEqual([
      'The file has no list of recipes.',
    ]);
  });
});
