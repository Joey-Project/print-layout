import { foldAll } from './fold';
import { buildPlan, pagesPerSheet } from './plan';
import { ImpositionError, type Recipe } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const oneOf = <T extends string>(v: unknown, opts: readonly T[]): v is T =>
  typeof v === 'string' && (opts as readonly string[]).includes(v);

/**
 * Check an untrusted (e.g. user-edited JSON) recipe. Returns the list of problems; empty means the
 * recipe is structurally valid AND its fold program actually produces a consistent imposition.
 */
export function recipeProblems(input: unknown): string[] {
  const p: string[] = [];
  if (!isObj(input)) return ['Recipe must be a JSON object.'];
  if (typeof input.id !== 'string' || !input.id) p.push('"id" must be a non-empty string.');
  if (typeof input.name !== 'string' || !input.name) p.push('"name" must be a non-empty string.');
  if (input.description !== undefined && typeof input.description !== 'string') {
    p.push('"description" must be a string.');
  }

  const grid = input.grid;
  if (!isObj(grid) || !isPosInt(grid.cols) || !isPosInt(grid.rows)) {
    p.push('"grid" must be { "cols": positive integer, "rows": positive integer }.');
  }

  if (!Array.isArray(input.folds)) p.push('"folds" must be an array (it may be empty).');
  else {
    input.folds.forEach((f, i) => {
      const where = `folds[${i}]`;
      if (!isObj(f)) return p.push(`${where} must be an object.`);
      if (!oneOf(f.axis, ['x', 'y'])) p.push(`${where}.axis must be "x" or "y".`);
      if (typeof f.at !== 'number' || !Number.isFinite(f.at))
        p.push(`${where}.at must be a number.`);
      if (!oneOf(f.move, ['low', 'high'])) p.push(`${where}.move must be "low" or "high".`);
      if (!oneOf(f.to, ['over', 'under'])) p.push(`${where}.to must be "over" or "under".`);
    });
  }

  if (input.padding !== undefined && !oneOf(input.padding, ['end', 'beforeLastPage'])) {
    p.push('"padding" must be "end" or "beforeLastPage".');
  }

  const r = input.reading;
  if (!isObj(r)) p.push('"reading" must be an object.');
  else if (r.mode === 'bound') {
    if (!oneOf(r.bindingEdge, ['left', 'right', 'top', 'bottom'])) {
      p.push('"reading.bindingEdge" must be "left", "right", "top" or "bottom".');
    }
    if (r.sheetsPerSignature !== 'all' && !isPosInt(r.sheetsPerSignature)) {
      p.push('"reading.sheetsPerSignature" must be "all" or a positive integer.');
    }
  } else if (r.mode === 'sequence') {
    if (r.order !== undefined) {
      if (!Array.isArray(r.order) || r.order.length === 0) {
        p.push('"reading.order" must be a non-empty array when given.');
      } else {
        const seen = new Set<string>();
        r.order.forEach((f, i) => {
          const where = `reading.order[${i}]`;
          if (!isObj(f)) return p.push(`${where} must be an object.`);
          if (!oneOf(f.side, ['front', 'back'])) p.push(`${where}.side must be "front" or "back".`);
          if (!Number.isInteger(f.col) || !Number.isInteger(f.row)) {
            return p.push(`${where} needs integer "col" and "row".`);
          }
          if (isObj(grid) && isPosInt(grid.cols) && isPosInt(grid.rows)) {
            const c = f.col as number;
            const rw = f.row as number;
            if (c < 0 || c >= grid.cols || rw < 0 || rw >= grid.rows) {
              p.push(`${where} is outside the ${grid.cols}×${grid.rows} grid.`);
            }
          }
          if (f.rotation !== undefined && f.rotation !== 0 && f.rotation !== 180) {
            p.push(`${where}.rotation must be 0 or 180.`);
          }
          const key = `${String(f.side)}:${String(f.col)}:${String(f.row)}`;
          if (seen.has(key)) p.push(`${where} repeats a panel already used.`);
          seen.add(key);
        });
      }
    }
  } else {
    p.push('"reading.mode" must be "bound" or "sequence".');
  }

  if (p.length === 0) {
    // Structurally fine: make sure the fold program actually works (two sheets exercise nesting).
    try {
      const recipe = input as unknown as Recipe;
      buildPlan(recipe, pagesPerSheet(recipe) * 2);
      if (recipe.reading.mode === 'sequence') foldAll(1, recipe.grid, recipe.folds);
    } catch (e) {
      p.push(e instanceof ImpositionError ? e.message : String(e));
    }
  }
  return p;
}

export function parseRecipe(input: unknown): Recipe {
  const problems = recipeProblems(input);
  if (problems.length) throw new ImpositionError(problems.join('\n'));
  return input as Recipe;
}
