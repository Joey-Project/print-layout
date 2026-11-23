import { useEffect, useMemo, useRef, useState } from 'react';
import { NO_GANG, type Gang, type Piece, type Plan, type Recipe } from '../engine';
import {
  activeJoin,
  layoutSheets,
  sectionPageSize,
  MM,
  PAGE_SIZES,
  PRINT_PRESETS,
  SHEET_SIZES,
  type PrintOptions,
  type PrintPreset,
} from '../pdf/geometry';
import { physicalSize, type ImposedOptions } from '../pdf/imposed';
import { logEvent } from './debugReport';
import type { LoadedPdf } from './pdfArt';

export interface PrintSettings {
  options: PrintOptions;
  /** Finished page size for the numbered dummy when no PDF is loaded (id in PAGE_SIZES). */
  dummyPage: string;
}

export const DEFAULT_PRINT: PrintSettings = {
  options: PRINT_PRESETS.home.options,
  dummyPage: 'a5',
};

const mm = (pt: number) => Math.round((pt / MM) * 10) / 10;

function saveFile(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function dummySize(id: string) {
  const s = PAGE_SIZES.find((p) => p.id === id) ?? PAGE_SIZES[1]!;
  return { w: s.w * MM, h: s.h * MM };
}

/** Rendered preview of one output sheet (front and back), from the real exported PDF. */
function SheetPreview({ bytes }: { bytes: Uint8Array | null }) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = holder.current;
    if (!el || !bytes) return;
    let cancelled = false;
    void (async () => {
      const { openPdfJs, renderPage } = await import('../pdf/render');
      const doc = await openPdfJs(bytes);
      const canvases: HTMLCanvasElement[] = [];
      for (let i = 0; i < doc.numPages; i++) canvases.push(await renderPage(doc, i, 900));
      void doc.loadingTask.destroy();
      if (cancelled) return;
      el.replaceChildren(
        ...canvases.map((c, i) => {
          const fig = document.createElement('figure');
          const cap = document.createElement('figcaption');
          cap.textContent = canvases.length > 1 ? (i === 0 ? 'Front' : 'Back') : 'Front';
          c.className = 'sheet-preview';
          fig.append(c, cap);
          return fig;
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return <div className="previews" ref={holder} />;
}

export function PrintView({
  plan,
  recipe,
  pdf,
  imposed,
  pageOrder,
  settings,
  onSettings,
}: {
  plan: Plan;
  recipe: Recipe;
  pdf: LoadedPdf | null;
  imposed: ImposedOptions;
  /** A reading-order PDF's pages in another order (see `pageSource`). */
  pageOrder?: number[];
  settings: PrintSettings;
  onSettings: (s: PrintSettings) => void;
}) {
  const o = settings.options;
  const set = (patch: Partial<PrintOptions>) =>
    onSettings({ ...settings, options: { ...o, ...patch } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewSheet, setPreviewSheet] = useState(0);
  const [preview, setPreview] = useState<Uint8Array | null>(null);

  const source = pdf?.mode === 'reading' ? pdf : null;
  /** Finished page size for these options: a sheet divided into sections sizes the dummy's. */
  const pageSizeFor = (opts: PrintOptions) => {
    const first = source?.info[0];
    if (first) return physicalSize(first, first.trim);
    return sectionPageSize(opts, plan.grid) ?? dummySize(settings.dummyPage);
  };
  const pageSize = useMemo(() => pageSizeFor(o), [source, settings.dummyPage, o, plan.grid]);
  const layout = useMemo(() => layoutSheets(plan, pageSize, o), [plan, pageSize, o]);
  const gang = o.gang ?? NO_GANG;
  const units = layout.gang.units;
  const sectioned = layout.paper.sectioned;
  const sections = o.sections ?? { across: 3, down: 1, blank: 'end' as const };
  const setSections = (patch: Partial<typeof sections>) =>
    set({ sections: { ...sections, ...patch } });
  const blankCount = layout.paper.paper.blanks.reduce((n, b) => n + b.w * b.h, 0);
  const setGang = (patch: Partial<Gang>) => set({ gang: { ...gang, ...patch } });
  /**
   * The most units per side that fit (ties: the roomier layout). At actual size they must fit at
   * 100 %; when fitting to the sheet, shrinking up to 10 % is fine (e.g. two A5 spreads on A4
   * inside a home printer's margins).
   */
  const minFillScale = o.scaling === 'actual' ? 1 : 0.9;
  const bestGang = (opts: PrintOptions) => {
    // The page size these options print at (turning sections off changes the dummy's).
    const size = pageSizeFor(opts);
    let best = { across: 1, down: 1, scale: -1 };
    for (let across = 1; across <= 8; across++) {
      for (let down = 1; down <= 8; down++) {
        const l = layoutSheets(plan, size, {
          ...opts,
          scaling: 'fit',
          gang: { ...gang, across, down },
        });
        if (l.scale < minFillScale - 1e-6) continue;
        const better =
          across * down > best.across * best.down ||
          (across * down === best.across * best.down && l.scale > best.scale);
        if (better) best = { across, down, scale: l.scale };
      }
    }
    return { ...gang, across: best.across, down: best.down };
  };
  const fillSheet = () => setGang(bestGang(o));
  // A strip in pieces glued end to end (a long accordion).
  const cols = plan.grid.cols;
  const join = activeJoin(o, plan.grid);
  const pieces = layout.pieces;
  const tabMm = o.join?.tab ?? 8;
  /** The longest pieces that fit the sheet, then as many of them per sheet as fit. */
  const fitPieces = (tab: number) => {
    let panels = Math.min(cols - 1, 3);
    if (o.sheet.kind !== 'fit') {
      panels = 1;
      for (let k = cols - 1; k >= 1; k--) {
        // Joining turns sections off, so the page is measured as it will print.
        const opts: PrintOptions = { ...o, sections: null, join: { panels: k, tab } };
        const l = layoutSheets(plan, pageSizeFor(opts), {
          ...opts,
          scaling: 'fit',
          gang: NO_GANG,
        });
        if (l.scale >= minFillScale - 1e-6) {
          panels = k;
          break;
        }
      }
    }
    const next = { ...o, sections: null, join: { panels, tab } };
    set({ sections: null, join: next.join, gang: o.sheet.kind !== 'fit' ? bestGang(next) : gang });
  };
  // Printed (physical) sheets: fewer than the recipe's sheets when several are ganged on one.
  const sheetCount = layout.gang.papers;
  const hasBacks = plan.sheets.some((s) => s.back.length > 0);
  const base = source?.name ?? `dummy-${recipe.id}-${plan.pageCount}p`;

  // A live preview of one sheet, built with the real exporter (debounced).
  const sheetShown = Math.min(previewSheet, sheetCount - 1);
  useEffect(() => {
    if (pdf?.mode === 'imposed') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { exportImposed } = await import('../pdf/pdfFiles');
          const { files } = await exportImposed({
            plan,
            recipe,
            source: source?.bytes ?? null,
            pageOrder: source ? pageOrder : undefined,
            dummyPageSize: dummySize(settings.dummyPage),
            options: { ...o, sides: 'duplex' },
            baseName: base,
            onlySheet: sheetShown,
          });
          if (!cancelled) {
            setPreview(files[0]!.bytes);
            setError(null);
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [plan, recipe, source, pageOrder, settings.dummyPage, o, sheetShown, base, pdf?.mode]);

  const download = async () => {
    setBusy(true);
    setError(null);
    logEvent('export', { options: o, sheets: sheetCount });
    try {
      const { exportImposed } = await import('../pdf/pdfFiles');
      const { files } = await exportImposed({
        plan,
        recipe,
        source: source?.bytes ?? null,
        pageOrder: source ? pageOrder : undefined,
        dummyPageSize: dummySize(settings.dummyPage),
        options: o,
        baseName: base,
      });
      for (const f of files) saveFile(f.name, f.bytes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pdf?.mode === 'imposed') {
    const deimpose = async () => {
      setBusy(true);
      setError(null);
      try {
        const { deimposePdf } = await import('../pdf/pdfFiles');
        const f = await deimposePdf(pdf.bytes, plan, imposed, pdf.name);
        saveFile(f.name, f.bytes);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="print">
        <p>
          This imposed PDF is being proofed against <strong>{recipe.name}</strong>. Check the
          reading order on the Sheets tab and leaf through it in 3D. You can also cut it back into
          single pages in reading order (vector, nothing rasterised) to read it in any PDF viewer.
        </p>
        <div className="buttons">
          <button className="primary" disabled={busy} onClick={() => void deimpose()}>
            Download reading-order PDF
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const sheetValue =
    o.sheet.kind === 'preset' ? o.sheet.id : o.sheet.kind === 'fit' ? 'fit' : 'custom';
  const flipText = layout.printerFlip === 'short' ? 'flip on short edge' : 'flip on long edge';

  return (
    <div className="print">
      <div className="presets" role="radiogroup" aria-label="Print setup">
        {(Object.keys(PRINT_PRESETS) as PrintPreset[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={
              JSON.stringify(PRINT_PRESETS[k].options) ===
              JSON.stringify({ ...o, gang: undefined, gutter: undefined })
            }
            className="preset"
            onClick={() =>
              // A preset sets how to print; how many go on a sheet stays as chosen.
              onSettings({
                ...settings,
                options: { ...PRINT_PRESETS[k].options, gang: o.gang, gutter: o.gutter },
              })
            }
          >
            <strong>{PRINT_PRESETS[k].label}</strong>
            <span className="muted small">{PRINT_PRESETS[k].hint}</span>
          </button>
        ))}
      </div>

      <div className="print-options">
        {!source && !sectioned && (
          <label>
            Page size (dummy)
            <select
              value={settings.dummyPage}
              onChange={(e) => onSettings({ ...settings, dummyPage: e.target.value })}
            >
              {PAGE_SIZES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.w} × {p.h} mm)
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Sheet size
          <select
            value={sheetValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'fit') set({ sheet: { kind: 'fit' } });
              else if (v === 'custom')
                set({ sheet: { kind: 'custom', w: mm(layout.width), h: mm(layout.height) } });
              else set({ sheet: { kind: 'preset', id: v } });
            }}
          >
            <option value="fit">Exact (imposition + bleed and marks)</option>
            {SHEET_SIZES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.w} × {s.h} mm)
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {o.sheet.kind === 'custom' && (
          <div className="row">
            <label>
              Width (mm)
              <input
                type="number"
                min={10}
                value={o.sheet.w}
                onChange={(e) =>
                  o.sheet.kind === 'custom' &&
                  set({ sheet: { ...o.sheet, w: Number(e.target.value) || 10 } })
                }
              />
            </label>
            <label>
              Height (mm)
              <input
                type="number"
                min={10}
                value={o.sheet.h}
                onChange={(e) =>
                  o.sheet.kind === 'custom' &&
                  set({ sheet: { ...o.sheet, h: Number(e.target.value) || 10 } })
                }
              />
            </label>
          </div>
        )}
        {o.sheet.kind !== 'fit' && (
          <>
            <label>
              Orientation
              <select
                value={o.orientation}
                onChange={(e) =>
                  set({ orientation: e.target.value as PrintOptions['orientation'] })
                }
              >
                <option value="auto">Automatic</option>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <label>
              Scaling
              <select
                value={o.scaling}
                onChange={(e) => set({ scaling: e.target.value as PrintOptions['scaling'] })}
              >
                <option value="fit">Fit to sheet</option>
                <option value="actual">Actual size (100 %)</option>
              </select>
            </label>
            <label>
              Printer margin (mm)
              <input
                type="number"
                min={0}
                step={0.5}
                value={o.margin}
                onChange={(e) => set({ margin: Math.max(0, Number(e.target.value) || 0) })}
              />
            </label>
          </>
        )}
        <label>
          Bleed (mm)
          <input
            type="number"
            min={0}
            step={0.5}
            value={o.bleed}
            onChange={(e) => set({ bleed: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={o.cropMarks}
            onChange={(e) => set({ cropMarks: e.target.checked })}
          />
          Crop marks
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={o.foldMarks}
            onChange={(e) => set({ foldMarks: e.target.checked })}
          />
          Fold marks
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={o.slug}
            onChange={(e) => set({ slug: e.target.checked })}
          />
          Sheet labels
        </label>
        {hasBacks && (
          <>
            <label>
              Two-sided output
              <select
                value={o.sides}
                onChange={(e) => set({ sides: e.target.value as PrintOptions['sides'] })}
              >
                <option value="duplex">One PDF: front, back, front, back…</option>
                <option value="split">Two PDFs: fronts, then backs</option>
              </select>
            </label>
            <label>
              Printer flips the sheet
              <select
                value={o.flip}
                onChange={(e) => set({ flip: e.target.value as PrintOptions['flip'] })}
              >
                <option value="auto">Like a book page (recommended)</option>
                <option value="short">On the short edge</option>
                <option value="long">On the long edge</option>
              </select>
            </label>
            {o.sides === 'split' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={o.reverseBacks}
                  onChange={(e) => set({ reverseBacks: e.target.checked })}
                />
                Backs in reverse order
              </label>
            )}
          </>
        )}
      </div>

      {cols > 1 && (
        <fieldset className="gang">
          <legend>Long strip</legend>
          <label className="check wide">
            <input
              type="checkbox"
              checked={Boolean(join)}
              onChange={(e) => (e.target.checked ? fitPieces(tabMm) : set({ join: null }))}
            />
            Print the strip in pieces and glue them end to end (for strips longer than the sheet)
          </label>
          {join && (
            <>
              <label>
                Panels per piece
                <input
                  type="number"
                  min={1}
                  max={cols - 1}
                  value={Math.floor(join.panels)}
                  onChange={(e) =>
                    set({
                      join: {
                        ...join,
                        panels: Math.min(
                          cols - 1,
                          Math.max(1, Math.floor(Number(e.target.value)) || 1),
                        ),
                      },
                    })
                  }
                />
              </label>
              <label>
                Glue tab (mm)
                <input
                  type="number"
                  min={0}
                  max={30}
                  step={1}
                  value={join.tab}
                  onChange={(e) =>
                    set({
                      join: {
                        ...join,
                        tab: Math.min(30, Math.max(0, Number(e.target.value) || 0)),
                      },
                    })
                  }
                />
              </label>
              <button
                onClick={() => fitPieces(join.tab)}
                title="The most panels per piece that fit the sheet, then as many pieces per sheet as fit"
              >
                Fit the sheet
              </button>
              {pieces && (
                <p className="muted small wide">
                  {pieceSummary(pieces, plan.sheets.length)}{' '}
                  {join.tab > 0
                    ? `After cutting, glue each piece's tinted tab under the next piece's first panel, its edge on the tab's fold line; the strip then folds as one.`
                    : 'After cutting, butt the pieces together and tape the joins on the back; the strip then folds as one.'}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}

      <fieldset className="gang">
        <legend>Several per sheet</legend>
        {o.sheet.kind !== 'fit' && !join && (
          <label className="check wide">
            <input
              type="checkbox"
              checked={Boolean(o.sections)}
              onChange={(e) =>
                set({ sections: e.target.checked ? { across: 3, down: 1, blank: 'end' } : null })
              }
            />
            Divide the sheet into equal sections, one page each (e.g. A4 in thirds for long, narrow
            pages)
          </label>
        )}
        {sectioned ? (
          <>
            <label>
              Sections across
              <input
                type="number"
                min={1}
                max={12}
                value={sections.across}
                onChange={(e) =>
                  setSections({ across: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>
            <label>
              Sections down
              <input
                type="number"
                min={1}
                max={12}
                value={sections.down}
                onChange={(e) =>
                  setSections({ down: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>
            <label>
              Blank sections go
              <select
                value={sections.blank}
                onChange={(e) => setSections({ blank: e.target.value as 'end' | 'start' })}
              >
                <option value="end">After the pages (right / bottom)</option>
                <option value="start">Before the pages (left / top)</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Across
              <input
                type="number"
                min={1}
                max={8}
                value={gang.across}
                onChange={(e) =>
                  setGang({ across: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>
            <label>
              Down
              <input
                type="number"
                min={1}
                max={8}
                value={gang.down}
                onChange={(e) =>
                  setGang({ down: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </label>
          </>
        )}
        {units > 1 && (
          <label>
            Then
            <select
              value={gang.order}
              onChange={(e) => setGang({ order: e.target.value as Gang['order'] })}
            >
              <option value="stack">Cut and stack (one copy)</option>
              <option value="copies">Copies ({units} per print run)</option>
            </select>
          </label>
        )}
        {units > 1 && !sectioned && (
          <label>
            Cutting gap (mm)
            <input
              type="number"
              min={0}
              step={0.5}
              value={o.gutter ?? 0}
              onChange={(e) => set({ gutter: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
        )}
        {o.sheet.kind !== 'fit' && !sectioned && (
          <button
            onClick={fillSheet}
            title={
              o.scaling === 'actual'
                ? 'As many as fit on the sheet at 100 %'
                : 'As many as fit on the sheet at 90 % or more'
            }
          >
            Fill the sheet
          </button>
        )}
        {sectioned && (
          <p className="muted small wide">
            Sections of {mm(layout.width / layout.paper.paper.across)} ×{' '}
            {mm(layout.height / layout.paper.paper.down)} mm: {units} spread
            {units === 1 ? '' : 's'} per side
            {blankCount > 0 &&
              `, ${blankCount} blank section${blankCount === 1 ? '' : 's'} to cut off`}
            . Pages run to the cut lines (no bleed); cut guides mark them at the sheet edges.
          </p>
        )}
      </fieldset>

      <div className="print-summary">
        <p>
          <strong>{sheetCount}</strong> sheet{sheetCount === 1 ? '' : 's'} of{' '}
          <strong>
            {mm(layout.width)} × {mm(layout.height)} mm
          </strong>{' '}
          ({layout.orientation}) · pages at{' '}
          <strong>{Math.round(layout.scale * 1000) / 10} %</strong> · finished page {mm(pageSize.w)}{' '}
          × {mm(pageSize.h)} mm
          {!source && ' · numbered dummy (open a pages PDF to use your artwork)'}
        </p>
        {units > 1 && (
          <p>
            {gang.order === 'stack' ? (
              <>
                The {pieces ? pieces.length : plan.sheets.length}{' '}
                {pieces ? 'pieces' : 'folded sheets'} are printed <strong>{units} per side</strong>{' '}
                on {sheetCount} sheet{sheetCount === 1 ? '' : 's'}. After printing, cut the whole
                stack {o.cropMarks ? 'along the crop marks' : 'where the parts meet'} into {units}{' '}
                piles. Put the pile from the first position (top left) on top of the next one (left
                to right, then the next row down), and so on: the {pieces ? 'pieces' : 'sheets'} are
                then in order, {pieces ? 'piece' : 'sheet'} 1 on top.
                {!o.cropMarks && ' Turning on crop marks shows exactly where to cut.'}
              </>
            ) : (
              <>
                Each printed sheet carries <strong>{units} copies</strong> of a{' '}
                {pieces ? 'piece' : 'folded sheet'}: cut the stack into {units} piles, and each pile
                makes one complete copy.
              </>
            )}
          </p>
        )}
        {hasBacks && (
          <p>
            {o.sides === 'duplex' ? (
              <>
                Print two-sided, <strong>{flipText}</strong>
                {layout.backRotated && ' (backs are rotated 180° for this)'}.
              </>
            ) : (
              <>
                Print the fronts file. Put the printed stack back in the paper tray so the backs
                print on the other side{o.reverseBacks ? ' (backs file is in reverse order)' : ''},
                turning it{' '}
                {layout.backRotated
                  ? 'top to bottom (like a wall calendar), as the backs are printed upside down for this'
                  : 'like a book page (left to right)'}
                , then print the backs file.
              </>
            )}{' '}
            Test with a few sheets first: printers differ.
          </p>
        )}
        {layout.warnings.map((w) => (
          <p key={w} className="warning">
            {w}
          </p>
        ))}
      </div>

      <div className="buttons">
        <button className="primary" disabled={busy} onClick={() => void download()}>
          {busy
            ? 'Building PDF…'
            : o.sides === 'split' && hasBacks
              ? 'Download 2 PDFs'
              : 'Download PDF'}
        </button>
        {sheetCount > 1 && (
          <label className="inline">
            Preview sheet
            <select value={sheetShown} onChange={(e) => setPreviewSheet(Number(e.target.value))}>
              {Array.from({ length: sheetCount }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <SheetPreview bytes={preview} />
    </div>
  );
}

/** E.g. "3 pieces per strip: 4 panels each, the last 2." */
function pieceSummary(pieces: Piece[], strips: number) {
  const first = pieces[0]!;
  const last = pieces[first.of - 1]!;
  const per = strips > 1 ? ` per strip (${strips} strips)` : '';
  const size =
    last.count === first.count
      ? `${first.count} panel${first.count === 1 ? '' : 's'} each`
      : `${first.count} panel${first.count === 1 ? '' : 's'} each, the last ${last.count}`;
  return `${first.of} pieces${per}: ${size}.`;
}
