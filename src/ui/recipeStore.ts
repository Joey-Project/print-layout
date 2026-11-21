import { builtinRecipes, recipeProblems, type Recipe } from '../engine';

const KEY = 'print-layout.custom-recipes.v1';

/** Custom recipes live in this browser's localStorage for now (export/import comes later). */
export function loadCustomRecipes(): Recipe[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((r): r is Recipe => recipeProblems(r).length === 0)
      : [];
  } catch {
    return [];
  }
}

export function saveCustomRecipes(recipes: Recipe[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recipes));
  } catch {
    // Storage unavailable (private mode etc.): keep working in memory.
  }
}

export const isBuiltin = (id: string) => builtinRecipes.some((r) => r.id === id);
