import { useMemo, useState } from 'react';
import {
  buildPlan,
  builtinRecipes,
  ImpositionError,
  recipeProblems,
  type Padding,
  type Plan,
  type Recipe,
} from '../engine';
import { isBuiltin, loadCustomRecipes, saveCustomRecipes } from './recipeStore';
import { PlanView } from './SheetView';

const pretty = (r: Recipe) => JSON.stringify(r, null, 2);

type Draft = { ok: true; recipe: Recipe } | { ok: false; problems: string[] };

function parseDraft(text: string): Draft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, problems: [`JSON syntax: ${(e as Error).message}`] };
  }
  const problems = recipeProblems(value);
  return problems.length ? { ok: false, problems } : { ok: true, recipe: value as Recipe };
}

export function App() {
  const [custom, setCustom] = useState<Recipe[]>(loadCustomRecipes);
  const all = useMemo(() => [...builtinRecipes, ...custom], [custom]);
  const [selectedId, setSelectedId] = useState(builtinRecipes[0]!.id);
  const selected = all.find((r) => r.id === selectedId) ?? builtinRecipes[0]!;
  const [text, setText] = useState(() => pretty(selected));
  const [pageCount, setPageCount] = useState(12);
  const [padding, setPadding] = useState<Padding | 'recipe'>('recipe');
  const [hovered, setHovered] = useState<number | null>(null);

  const draft = useMemo(() => parseDraft(text), [text]);
  const active = draft.ok ? draft.recipe : selected;
  const edited = text !== pretty(selected);

  const planResult = useMemo((): { plan: Plan } | { error: string } => {
    try {
      const recipe = padding === 'recipe' ? active : { ...active, padding };
      return { plan: buildPlan(recipe, pageCount) };
    } catch (e) {
      return { error: e instanceof ImpositionError ? e.message : String(e) };
    }
  }, [active, pageCount, padding]);

  const select = (id: string) => {
    const r = all.find((x) => x.id === id);
    if (!r) return;
    setSelectedId(id);
    setText(pretty(r));
  };

  const persist = (list: Recipe[]) => {
    setCustom(list);
    saveCustomRecipes(list);
  };

  const saveDraft = () => {
    if (!draft.ok) return;
    let recipe = draft.recipe;
    if (isBuiltin(recipe.id)) {
      // Never shadow a built-in: saving an edited built-in creates a copy.
      let n = 2;
      while (all.some((r) => r.id === `${recipe.id}-${n}`)) n++;
      recipe = { ...recipe, id: `${recipe.id}-${n}`, name: `${recipe.name} (copy)` };
    }
    persist([...custom.filter((r) => r.id !== recipe.id), recipe]);
    setSelectedId(recipe.id);
    setText(pretty(recipe));
  };

  const deleteSelected = () => {
    persist(custom.filter((r) => r.id !== selected.id));
    select(builtinRecipes[0]!.id);
  };

  const plan = 'plan' in planResult ? planResult.plan : null;
  const blanks = plan ? plan.slotCount - plan.pageCount : 0;

  return (
    <div className="app">
      <header>
        <h1>Print Layout</h1>
        <p className="muted">
          Pick a binding recipe and a page count to see where every page lands on the printed
          sheets. Hover a panel for details.
        </p>
      </header>

      <aside className="controls">
        <label>
          Binding recipe
          <select value={selectedId} onChange={(e) => select(e.target.value)}>
            <optgroup label="Built-in">
              {builtinRecipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
            {custom.length > 0 && (
              <optgroup label="My recipes">
                {custom.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {active.description && <p className="desc">{active.description}</p>}

        <div className="row">
          <label>
            Pages in source PDF
            <input
              type="number"
              min={1}
              max={999}
              value={pageCount}
              onChange={(e) => setPageCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </label>
          <label>
            Blank pages go
            <select value={padding} onChange={(e) => setPadding(e.target.value as typeof padding)}>
              <option value="recipe">Recipe default</option>
              <option value="end">At the end</option>
              <option value="beforeLastPage">Before the back cover</option>
            </select>
          </label>
        </div>

        <details open className="editor">
          <summary>Recipe JSON {edited && <span className="badge">edited</span>}</summary>
          <p className="muted small">
            Edit to design your own binding; the preview updates live. Folds use panel units on the
            current folded packet — see <code>docs/design.md</code>.
          </p>
          <textarea
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={!draft.ok}
          />
          {!draft.ok && (
            <ul className="problems">
              {draft.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="buttons">
            <button onClick={saveDraft} disabled={!draft.ok}>
              {isBuiltin(draft.ok ? draft.recipe.id : selected.id)
                ? 'Save as my recipe'
                : 'Save recipe'}
            </button>
            <button onClick={() => setText(pretty(selected))} disabled={!edited}>
              Revert
            </button>
            {!isBuiltin(selected.id) && (
              <button className="danger" onClick={deleteSelected}>
                Delete
              </button>
            )}
          </div>
        </details>
      </aside>

      <main>
        {'error' in planResult ? (
          <p className="error">{planResult.error}</p>
        ) : (
          plan && (
            <>
              <p className="summary">
                <strong>{plan.pageCount}</strong> pages → <strong>{plan.sheets.length}</strong>{' '}
                sheet{plan.sheets.length === 1 ? '' : 's'} ({plan.pagesPerSheet} pages per sheet)
                {blanks > 0 && (
                  <>
                    {' '}
                    · <strong>{blanks}</strong> blank{blanks === 1 ? '' : 's'} added
                  </>
                )}
                {!draft.ok && <span className="muted"> · showing last valid recipe</span>}
              </p>
              <PlanView plan={plan} hovered={hovered} onHover={setHovered} />
            </>
          )
        )}
      </main>
    </div>
  );
}
