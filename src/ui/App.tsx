import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPlan,
  builtinRecipes,
  gangPlan,
  NO_GANG,
  pagesPerSheet,
  ImpositionError,
  recipeProblems,
  type Padding,
  type Plan,
  type Recipe,
} from '../engine';
import { isBuiltin, loadCustomRecipes, saveCustomRecipes } from './recipeStore';
import { DEFAULT_IMPOSED, sideMap, type ImposedOptions } from '../pdf/imposed';
import { usePdfArt, type LoadedPdf } from './pdfArt';
import { DEFAULT_PRINT, PrintView, type PrintSettings } from './PrintView';
import { SourcePanel } from './SourcePanel';
import { BookView3D } from './BookView3D';
import {
  isDebugReport,
  logEvent,
  recentEvents,
  REPORT_KIND,
  rounded,
  saveReport,
  type DebugReport,
  type ViewerDebug,
  type ViewerState,
} from './debugReport';
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
  /**
   * The recipe a loaded bug report was actually using. It stands in for the selected recipe while
   * the editor text is invalid, so a report taken mid-edit rebuilds the same plan in any browser.
   */
  const [reportRecipe, setReportRecipe] = useState<Recipe | null>(null);
  const [pageCount, setPageCount] = useState(12);
  const [padding, setPadding] = useState<Padding | 'recipe'>('recipe');
  const [hovered, setHovered] = useState<number | null>(null);
  const [view, setView] = useState<'2d' | '3d' | 'print'>('2d');
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [imposed, setImposed] = useState<ImposedOptions>(DEFAULT_IMPOSED);
  const [print, setPrint] = useState<PrintSettings>(DEFAULT_PRINT);
  const viewerDebug = useRef<ViewerDebug | null>(null);
  const [restore, setRestore] = useState<ViewerState | null>(null);
  const clearRestore = useCallback(() => setRestore(null), []);
  const fileInput = useRef<HTMLInputElement>(null);

  const draft = useMemo(() => parseDraft(text), [text]);
  const active = draft.ok ? draft.recipe : (reportRecipe ?? selected);
  const edited = text !== pretty(selected);

  // A loaded PDF decides the page count: its pages, or (imposed) its sheets × pages per sheet.
  const effectivePages = useMemo(() => {
    if (!pdf) return pageCount;
    if (pdf.mode === 'reading') return pdf.info.length;
    return Math.max(1, sideMap(pdf.info.length, imposed.order).sheetCount) * pagesPerSheet(active);
  }, [pdf, pageCount, imposed.order, active]);

  const planResult = useMemo((): { plan: Plan } | { error: string } => {
    try {
      const recipe = padding === 'recipe' ? active : { ...active, padding };
      return { plan: buildPlan(recipe, effectivePages) };
    } catch (e) {
      return { error: e instanceof ImpositionError ? e.message : String(e) };
    }
  }, [active, effectivePages, padding]);

  const select = (id: string) => {
    const r = all.find((x) => x.id === id);
    if (!r) return;
    setReportRecipe(null);
    logEvent('recipe', { id });
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
    setReportRecipe(null);
    setText(pretty(recipe));
  };

  const deleteSelected = () => {
    persist(custom.filter((r) => r.id !== selected.id));
    select(builtinRecipes[0]!.id);
  };

  const plan = 'plan' in planResult ? planResult.plan : null;
  const blanks = plan ? plan.slotCount - plan.pageCount : 0;
  const pdfArt = usePdfArt(pdf, plan, imposed);
  // The 3D model starts from the printed sheets as set up on the Print tab (several per sheet).
  const printGang = print.options.gang ?? NO_GANG;
  const gang = useMemo(
    () => (plan ? gangPlan(plan.sheets.length, printGang) : null),
    [plan, printGang.across, printGang.down, printGang.order],
  );

  // ---- Bug reports. ----
  const buildReport = (note: string): { report: DebugReport; screenshot: string | null } => {
    const snap = view === '3d' ? (viewerDebug.current?.snapshot() ?? null) : null;
    const report: DebugReport = {
      kind: REPORT_KIND,
      version: 1,
      createdAt: new Date().toISOString(),
      note,
      app: { commit: __APP_COMMIT__, mode: import.meta.env.MODE },
      env: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        devicePixelRatio: window.devicePixelRatio,
        window: [window.innerWidth, window.innerHeight],
      },
      input: {
        selectedId,
        recipeText: text,
        recipe: active,
        pageCount,
        padding,
        view,
        print,
        imposed,
      },
      viewer: snap?.state ?? null,
      derived: {
        recipeProblems: draft.ok ? [] : draft.problems,
        // The PDF itself is not included; load the same file to reproduce.
        pdf: pdf ? rounded({ name: pdf.name, mode: pdf.mode, pages: pdf.info }) : null,
        plan: plan
          ? rounded({
              pageCount: plan.pageCount,
              slotCount: plan.slotCount,
              pagesPerSheet: plan.pagesPerSheet,
              // Per sheet side: "page@col,row" (↻ = printed rotated 180°, – = blank).
              sheets: plan.sheets.map((sh) => ({
                front: sh.front.map(
                  (x) => `${x.page ?? '–'}${x.rotation ? '↻' : ''}@${x.col},${x.row}`,
                ),
                back: sh.back.map(
                  (x) => `${x.page ?? '–'}${x.rotation ? '↻' : ''}@${x.col},${x.row}`,
                ),
              })),
            })
          : { error: 'error' in planResult ? planResult.error : 'no plan' },
        viewer: snap?.derived ?? null,
      },
      events: recentEvents(),
    };
    return { report, screenshot: snap?.screenshot ?? null };
  };

  const reportBug = () => {
    const note = window.prompt(
      'What went wrong? (optional — saved in the report)\n\nThis saves a JSON file with the current state, plus a PNG of the 3D view.',
      '',
    );
    if (note === null) return;
    const { report, screenshot } = buildReport(note);
    saveReport(report, screenshot);
  };

  const applyReport = (report: DebugReport) => {
    const { input } = report;
    logEvent('loadReport', { createdAt: report.createdAt });
    if (all.some((r) => r.id === input.selectedId)) setSelectedId(input.selectedId);
    setText(input.recipeText);
    setReportRecipe(input.recipe);
    setPageCount(input.pageCount);
    setPadding(input.padding);
    setView(input.view);
    if (input.print) setPrint(input.print);
    if (input.imposed) setImposed(input.imposed);
    setRestore(input.view === '3d' ? report.viewer : null);
  };

  const loadReportFile = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!isDebugReport(data)) throw new Error('This is not a Print Layout bug report.');
      applyReport(data);
    } catch (e) {
      window.alert(`Could not load the report: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Lets a developer (or an automated browser) load or take a report from the console.
  const debugApi = useRef({ load: applyReport, take: () => buildReport('') });
  debugApi.current = { load: applyReport, take: () => buildReport('') };
  useEffect(() => {
    const api = {
      load: (r: unknown) => {
        if (!isDebugReport(r)) throw new Error('not a Print Layout bug report');
        debugApi.current.load(r);
      },
      take: () => debugApi.current.take(),
    };
    (window as unknown as { printLayoutDebug?: typeof api }).printLayoutDebug = api;
  }, []);

  return (
    <div className="app">
      <header>
        <div className="header-actions">
          <button
            onClick={reportBug}
            title="Save a JSON report and a screenshot to send with a bug"
          >
            Report a bug
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            title="Restore the exact state saved in a bug report"
          >
            Load report…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void loadReportFile(f);
            }}
          />
        </div>
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
              value={effectivePages}
              disabled={pdf !== null}
              title={pdf ? 'Set by the loaded PDF' : undefined}
              onChange={(e) => {
                const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                logEvent('pageCount', { value: n });
                setPageCount(n);
              }}
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

        <SourcePanel
          pdf={pdf}
          art={pdfArt}
          imposed={imposed}
          onOpen={(p) => {
            logEvent('openPdf', { name: p.name, mode: p.mode, pages: p.info.length });
            setPdf(p);
            setView(p.mode === 'imposed' ? '2d' : view);
          }}
          onClose={() => {
            logEvent('closePdf');
            void pdf?.js.loadingTask.destroy();
            setPdf(null);
          }}
          onImposed={(o) => {
            logEvent('imposedOptions', { ...o });
            setImposed(o);
          }}
        />

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
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={view === '2d'} onClick={() => setView('2d')}>
                  Sheets (2D)
                </button>
                <button role="tab" aria-selected={view === '3d'} onClick={() => setView('3d')}>
                  Fold &amp; read (3D)
                </button>
                <button
                  role="tab"
                  aria-selected={view === 'print'}
                  onClick={() => setView('print')}
                >
                  {pdf?.mode === 'imposed' ? 'Reading-order PDF' : 'Print PDF'}
                </button>
              </div>
              {view === '2d' ? (
                <PlanView
                  plan={plan}
                  hovered={hovered}
                  onHover={setHovered}
                  pdfArt={pdfArt}
                  showReading={pdf?.mode === 'imposed'}
                />
              ) : view === 'print' ? (
                <PrintView
                  plan={plan}
                  recipe={active}
                  pdf={pdf}
                  imposed={imposed}
                  settings={print}
                  onSettings={(s) => {
                    logEvent('printSettings', { ...s.options });
                    setPrint(s);
                  }}
                />
              ) : (
                <BookView3D
                  recipe={active}
                  plan={plan}
                  debug={viewerDebug}
                  restore={restore}
                  onRestored={clearRestore}
                  art={pdfArt?.art ?? null}
                  artVersion={pdfArt?.version ?? 0}
                  pdfAspect={pdfArt?.aspect ?? null}
                  gang={gang}
                />
              )}
            </>
          )
        )}
      </main>
    </div>
  );
}
