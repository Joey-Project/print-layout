/**
 * Recipe files, for sharing recipes between browsers and people: a small JSON wrapper around a
 * list of recipes. Importing takes a file of ours, a bare recipe or a list of them; every recipe
 * is validated, and an id that is already taken by a different recipe gets a fresh one, so an
 * import never replaces anything.
 */
import type { Recipe } from './types';
import { recipeProblems } from './validate';

export const RECIPE_FILE_KIND = 'print-layout-recipes';

export interface RecipeFile {
  kind: typeof RECIPE_FILE_KIND;
  version: 1;
  recipes: Recipe[];
}

/** The file's text for these recipes. */
export function recipeFileText(recipes: readonly Recipe[]): string {
  const file: RecipeFile = { kind: RECIPE_FILE_KIND, version: 1, recipes: [...recipes] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export interface ImportResult {
  /** New recipes to add (ids already made unique). */
  added: Recipe[];
  /** Recipes whose id was taken by a different recipe, and the id they were given. */
  renamed: { from: string; to: string }[];
  /** Ids of recipes identical to one already there (nothing to do). */
  same: string[];
  /** Why entries were left out. */
  problems: string[];
}

/** JSON with object keys sorted: equal recipes compare equal whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The recipes in an imported file's JSON, checked against the recipes already there. */
export function importRecipes(json: unknown, existing: readonly Recipe[]): ImportResult {
  const out: ImportResult = { added: [], renamed: [], same: [], problems: [] };
  let items: unknown[];
  if (Array.isArray(json)) items = json;
  else if (json && typeof json === 'object' && (json as RecipeFile).kind === RECIPE_FILE_KIND) {
    const list = (json as RecipeFile).recipes;
    if (!Array.isArray(list)) {
      out.problems.push('The file has no list of recipes.');
      return out;
    }
    items = list;
  } else items = [json];

  const byId = new Map(existing.map((r) => [r.id, r]));
  items.forEach((item, i) => {
    const problems = recipeProblems(item);
    if (problems.length) {
      const name =
        item && typeof item === 'object' && typeof (item as Recipe).name === 'string'
          ? ` (“${(item as Recipe).name}”)`
          : '';
      out.problems.push(`Recipe ${i + 1}${name}: ${problems.join(' ')}`);
      return;
    }
    const recipe = item as Recipe;
    const taken = byId.get(recipe.id);
    if (taken && canonical(taken) === canonical(recipe)) {
      out.same.push(recipe.id);
      return;
    }
    let id = recipe.id;
    if (taken) {
      let n = 2;
      while (byId.has(`${recipe.id}-${n}`)) n++;
      id = `${recipe.id}-${n}`;
      out.renamed.push({ from: recipe.id, to: id });
    }
    const added = { ...recipe, id };
    byId.set(id, added);
    out.added.push(added);
  });
  return out;
}
