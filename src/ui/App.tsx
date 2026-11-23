import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  accordion,
  buildPlan,
  builtinRecipes,
  isAccordion,
  NO_GANG,
  paperPlan,
  pagesPerSheet,
  ImpositionError,
  importRecipes,
  recipeFileText,
  recipeProblems,
  type Padding,
  type Plan,
  type Recipe,
} from '../engine';
import { isBuiltin, loadCustomRecipes, saveCustomRecipes } from './recipeStore';
import { activeJoin, sectionPageSize } from '../pdf/geometry';
import {
  DEFAULT_IMPOSED,
  moveSheet,
  proofLayout,
  proofSheetRange,
  type ImposedOptions,
} from '../pdf/imposed';
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
import { PlanView, type SheetOrderControls } from './SheetView';
import { PageOrderStrip } from './PageOrderStrip';
import { FoldEditor, newRecipe } from './FoldEditor';
import { bookLength, type PageEntry } from '../pdf/pageOrder';

const pretty = (r: Recipe) => JSON.stringify(r, null, 2);

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file-name-safe stem from a recipe id. */
const fileStem = (id: string) => id.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'recipe';

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
  /**
   * A reading-order PDF's pages in another order: book page i + 1 is PDF page `pageOrder[i]`, or a
   * blank page for `null` (see `pageSource`).
   */
  const [pageOrder, setPageOrder] = useState<PageEntry[] | undefined>(undefined);
  const [print, setPrint] = useState<PrintSettings>(DEFAULT_PRINT);
  const viewerDebug = useRef<ViewerDebug | null>(null);
  const [restore, setRestore] = useState<ViewerState | null>(null);
  const clearRestore = useCallback(() => setRestore(null), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const recipeInput = useRef<HTMLInputElement>(null);
  /** What the last recipe import did. */
  const [importNote, setImportNote] = useState<{ text: string; problems: string[] } | null>(null);

  const draft = useMemo(() => parseDraft(text), [text]);
  // The draft as plain JSON, for the fold editor (it works on unfinished programs too).
  const draftValue = useMemo((): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }, [text]);
  const active = draft.ok ? draft.recipe : (reportRecipe ?? selected);
  const edited = text !== pretty(selected);

  // Proofing: printed sheets × parts per sheet (several per sheet, or sections) = recipe sheets.
  // Fewer pages fit only while they fill the same printed sheets.
  const proofRange =
    pdf?.mode === 'imposed' ? proofSheetRange(pdf.info.length, active.grid, imposed) : null;
  const proofPagesMax = proofRange ? Math.max(1, proofRange.max) * pagesPerSheet(active) : 0;
  const proofPagesMin = proofRange
    ? Math.max(1, (proofRange.min - 1) * pagesPerSheet(active) + 1)
    : 1;
  // A loaded PDF decides the page count: its pages plus the blanks inserted in the page order, or
  // (imposed) its sheets × pages per sheet, fewer when the last printed sheets have empty positions.
  const effectivePages = useMemo(() => {
    if (!pdf) return pageCount;
    if (pdf.mode === 'reading') return bookLength(pageOrder, pdf.info.length);
    return Math.max(proofPagesMin, Math.min(proofPagesMax, imposed.pages ?? proofPagesMax));
  }, [pdf, pageCount, pageOrder, imposed.pages, proofPagesMin, proofPagesMax]);

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

  const editRecipe = (r: Recipe) => {
    setReportRecipe(null);
    setText(pretty(r));
  };

  const importFiles = async (files: FileList) => {
    let list = custom;
    const lines: string[] = [];
    const problems: string[] = [];
    let first: string | null = null;
    for (const file of Array.from(files)) {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        problems.push(`${file.name}: not a JSON file.`);
        continue;
      }
      const r = importRecipes(json, [...builtinRecipes, ...list]);
      list = [...list, ...r.added];
      first ??= r.added[0]?.id ?? null;
      if (r.added.length) {
        lines.push(`${file.name}: added ${r.added.map((x) => `“${x.name}”`).join(', ')}.`);
      }
      for (const { from, to } of r.renamed) {
        lines.push(`“${from}” was already taken by another recipe, so it is now “${to}”.`);
      }
      if (r.same.length) lines.push(`${file.name}: ${r.same.length} already here, unchanged.`);
      problems.push(...r.problems.map((p) => `${file.name}: ${p}`));
    }
    logEvent('importRecipes', { files: files.length, added: list.length - custom.length });
    if (list !== custom) persist(list);
    if (first) {
      const r = list.find((x) => x.id === first)!;
      setSelectedId(r.id);
      editRecipe(r);
    }
    setImportNote({ text: lines.join(' ') || 'Nothing to add.', problems });
  };

  const deleteSelected = () => {
    persist(custom.filter((r) => r.id !== selected.id));
    select(builtinRecipes[0]!.id);
  };

  const plan = 'plan' in planResult ? planResult.plan : null;
  const blanks = plan ? plan.slotCount - plan.pageCount : 0;
  const readingOrder = pdf?.mode === 'reading' ? pageOrder : undefined;
  const pdfArt = usePdfArt(pdf, plan, imposed, readingOrder);
  // Proofing: the sheets can be put in another order than the PDF's.
  const proof = useMemo(
    () => (pdf?.mode === 'imposed' && plan ? proofLayout(pdf.info, plan, imposed) : null),
    [pdf, plan, imposed],
  );
  const sheetOrder = useMemo((): SheetOrderControls | null => {
    if (!proof) return null;
    const n = proof.positions;
    const several = proof.paper.gang.units > 1;
    return {
      source: (i) => {
        const at = proof.sourceOf(i);
        return `PDF sheet ${at.printed + 1}${several ? `, part ${at.unit + 1}` : ''}`;
      },
      moved: (i) => proof.sourceOf(i).part !== i,
      move: (from, to) => {
        logEvent('moveSheet', { from, to });
        setImposed((o) => ({ ...o, sheetOrder: moveSheet(o.sheetOrder, n, from, to) }));
      },
    };
  }, [proof]);
  // The 3D model starts from the printed sheets as set up on the Print tab (several per sheet).
  const printGang = print.options.gang ?? NO_GANG;
  // A sheet divided into sections fixes the page shape (e.g. A4 in thirds: long, narrow pages).
  const section = plan ? sectionPageSize(print.options, plan.grid) : null;
  const sectionAspect = section ? section.h / section.w : null;
  const printSections =
    print.options.sheet.kind === 'fit' ? null : (print.options.sections ?? null);
  const proofGang = imposed.gang ?? NO_GANG;
  const proofSections = imposed.sections ?? null;
  // Printed in pieces glued end to end: the model starts from the whole strip.
  const joined = plan ? activeJoin(print.options, plan.grid) !== null : false;
  const gang = useMemo(() => {
    if (!plan) return null;
    if (joined && pdf?.mode !== 'imposed') {
      return paperPlan(plan.sheets.length, plan.grid, NO_GANG, null);
    }
    // Proofing an imposed PDF: start from its printed sheets, cut the way it says.
    if (pdf?.mode === 'imposed') {
      return paperPlan(plan.sheets.length, plan.grid, proofGang, proofSections);
    }
    return paperPlan(plan.sheets.length, plan.grid, printGang, printSections);
  }, [
    plan,
    pdf?.mode,
    joined,
    printGang.across,
    printGang.down,
    printGang.order,
    printSections?.across,
    printSections?.down,
    printSections?.blank,
    proofGang.across,
    proofGang.down,
    proofGang.order,
    proofSections?.across,
    proofSections?.down,
    proofSections?.blank,
  ]);

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
        pageOrder: readingOrder,
      },
      viewer: snap?.state ?? null,
      derived: {
        recipeProblems: draft.ok ? [] : draft.problems,
        // The PDF itself is not included; load the same file to reproduce.
        // Built from images: their names and how they were placed (not the pixels).
        pdf: pdf
          ? rounded({
              name: pdf.name,
              mode: pdf.mode,
              pages: pdf.info,
              images: pdf.images
                ? { files: pdf.images.list.map((i) => i.name), options: pdf.images.options }
                : undefined,
            })
          : null,
        bookPages: pdf?.mode === 'reading' ? effectivePages : undefined,
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
    setPageOrder(input.pageOrder);
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
        {isAccordion(active) && (
          <PanelsField
            value={active.grid.cols}
            onChange={(n) => {
              logEvent('accordionPanels', { panels: n });
              setReportRecipe(null);
              setText(pretty(accordion(n)));
            }}
          />
        )}

        <div className="row">
          <label>
            {pdf?.mode === 'imposed'
              ? 'Pages in the book'
              : pdf
                ? 'Pages in the book (with blanks)'
                : 'Pages in source PDF'}
            <input
              type="number"
              min={pdf?.mode === 'imposed' ? proofPagesMin : 1}
              max={pdf?.mode === 'imposed' ? proofPagesMax : 999}
              value={effectivePages}
              disabled={pdf?.mode === 'reading'}
              title={
                pdf?.mode === 'reading'
                  ? 'Set by the loaded pages and the blank pages inserted in the page order'
                  : pdf
                    ? `${proofPagesMin}–${proofPagesMax}: fewer when the last printed sheets have empty positions`
                    : undefined
              }
              onChange={(e) => {
                const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                logEvent('pageCount', { value: n });
                if (pdf?.mode === 'imposed')
                  setImposed({ ...imposed, pages: n >= proofPagesMax ? undefined : n });
                else setPageCount(n);
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
          sheetPositions={proof?.positions ?? 0}
          onOpen={(p) => {
            logEvent('openPdf', {
              name: p.name,
              mode: p.mode,
              pages: p.info.length,
              images: p.images?.list.length,
            });
            setPdf(p);
            // A new PDF starts in its own page order.
            setPageOrder(undefined);
            // A new imposed PDF: every position holds a sheet, in order, until told otherwise.
            if (imposed.pages !== undefined || imposed.sheetOrder !== undefined)
              setImposed({ ...imposed, pages: undefined, sheetOrder: undefined });
            setView(p.mode === 'imposed' ? '2d' : view);
          }}
          onReplace={(p) => {
            // The same images, rebuilt in another page size or fit: the page order still holds.
            logEvent('rebuildImages', { name: p.name, ...p.images?.options });
            void pdf?.js.loadingTask.destroy();
            setPdf(p);
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
          <summary>Fold editor</summary>
          <FoldEditor
            value={draftValue}
            onChange={(r) => {
              logEvent('foldEditor', { grid: r.grid, folds: r.folds.length });
              editRecipe(r);
            }}
            onNew={() => {
              logEvent('newRecipe', {});
              editRecipe(newRecipe(new Set(all.map((r) => r.id))));
            }}
          />
        </details>

        <details open className="editor">
          <summary>
            Recipe JSON {edited && <span className="badge">edited</span>}
            {!draft.ok && <span className="badge">not ready</span>}
          </summary>
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
          <div className="buttons">
            <button
              disabled={!draft.ok}
              title="Save this recipe as a file to share or keep"
              onClick={() =>
                draft.ok &&
                downloadText(
                  `${fileStem(draft.recipe.id)}.recipe.json`,
                  recipeFileText([draft.recipe]),
                )
              }
            >
              Export
            </button>
            {custom.length > 0 && (
              <button
                title="All of my recipes in one file"
                onClick={() => downloadText('print-layout-recipes.json', recipeFileText(custom))}
              >
                Export my recipes
              </button>
            )}
            <button onClick={() => recipeInput.current?.click()}>Import…</button>
            <input
              ref={recipeInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(e) => {
                const files = e.target.files;
                if (files?.length) void importFiles(files);
                e.target.value = '';
              }}
            />
          </div>
          {importNote && (
            <div className="import-note small" role="status">
              <p>{importNote.text}</p>
              {importNote.problems.length > 0 && (
                <ul className="problems">
                  {importNote.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
                <>
                  {pdf?.mode === 'reading' && pdfArt && (
                    <PageOrderStrip
                      n={pdf.info.length}
                      order={pageOrder}
                      art={pdfArt}
                      onChange={(order) => {
                        logEvent('pageOrder', { order: order ?? null });
                        setPageOrder(order);
                      }}
                    />
                  )}
                  <PlanView
                    plan={plan}
                    hovered={hovered}
                    onHover={setHovered}
                    pdfArt={pdfArt}
                    showReading={pdf?.mode === 'imposed'}
                    order={sheetOrder}
                  />
                </>
              ) : view === 'print' ? (
                <PrintView
                  plan={plan}
                  recipe={active}
                  pdf={pdf}
                  imposed={imposed}
                  pageOrder={readingOrder}
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
                  pdfAspect={pdfArt?.aspect ?? sectionAspect}
                  pdfAspectLabel={pdfArt ? 'From PDF' : 'From print sections'}
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

/** Panels of an accordion (any number: a long one prints in pieces glued end to end). */
const MAX_PANELS = 48;
function PanelsField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  // Typed text is kept while it is not a usable count yet (e.g. "1" on the way to "12").
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label>
      Panels
      <input
        type="number"
        min={2}
        max={MAX_PANELS}
        value={text}
        title={`2–${MAX_PANELS}; longer than the sheet? Print it in pieces on the Print tab`}
        onChange={(e) => {
          setText(e.target.value);
          const n = Math.floor(Number(e.target.value));
          if (n >= 2 && n <= MAX_PANELS && n !== value) onChange(n);
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}
