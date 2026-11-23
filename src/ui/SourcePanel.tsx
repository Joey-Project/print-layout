import { useRef, useState } from 'react';
import { MM } from '../pdf/geometry';
import { inPdfOrder, physicalSize, sheetPermutation, type ImposedOptions } from '../pdf/imposed';
import type { LoadedPdf, PdfArt } from './pdfArt';

/** Open a PDF from disk: page info via pdf-lib, rendering via pdf.js (both loaded on demand). */
export async function openPdfFile(file: File, mode: LoadedPdf['mode']): Promise<LoadedPdf> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [{ loadPdf, pageInfo }, { openPdfJs }] = await Promise.all([
    import('../pdf/pdfFiles'),
    import('../pdf/render'),
  ]);
  const info = pageInfo(await loadPdf(bytes));
  if (info.length === 0) throw new Error('The PDF has no pages.');
  return { name: file.name.replace(/\.pdf$/i, ''), bytes, info, js: await openPdfJs(bytes), mode };
}

const mm = (pt: number) => Math.round((pt / MM) * 10) / 10;

export function SourcePanel({
  pdf,
  art,
  imposed,
  onOpen,
  onClose,
  onImposed,
  sheetPositions,
}: {
  pdf: LoadedPdf | null;
  art: PdfArt | null;
  imposed: ImposedOptions;
  /** Recipe sheets being proofed (for the sheet order). */
  /** Positions the sheet order picks from (every part on the printed sheets, empty ones too). */
  sheetPositions: number;
  onOpen: (pdf: LoadedPdf) => void;
  onClose: () => void;
  onImposed: (o: ImposedOptions) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Which button opened the file picker (a ref: the file arrives before any re-render).
  const mode = useRef<LoadedPdf['mode']>('reading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (m: LoadedPdf['mode']) => {
    mode.current = m;
    input.current?.click();
  };
  const load = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      onOpen(await openPdfFile(file, mode.current));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const first = pdf?.info[0];
  const size = first
    ? pdf.mode === 'reading'
      ? physicalSize(first, first.trim)
      : physicalSize(first, first.crop)
    : null;
  const inset = imposed.inset;
  const gang = imposed.gang ?? { across: 1, down: 1, order: 'stack' as const };
  const sections = imposed.sections ?? { across: 3, down: 1, blank: 'end' as const };
  const holds: 'one' | 'several' | 'sections' = imposed.sections
    ? 'sections'
    : gang.across * gang.down > 1
      ? 'several'
      : 'one';
  const setGang = (patch: Partial<typeof gang>) =>
    onImposed({ ...imposed, gang: { ...gang, ...patch } });
  const setSections = (patch: Partial<typeof sections>) =>
    onImposed({ ...imposed, sections: { ...sections, ...patch } });
  const setInset = (k: keyof typeof inset, v: number) =>
    onImposed({ ...imposed, inset: { ...inset, [k]: Math.max(0, v) } });

  return (
    <section className="source">
      <h2>Artwork</h2>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void load(f);
        }}
      />
      {!pdf ? (
        <>
          <p className="muted small">
            Open a PDF to see its pages on the sheets and in 3D. It stays on your computer.
          </p>
          <div className="buttons">
            <button disabled={busy} onClick={() => pick('reading')}>
              Open pages PDF…
            </button>
            <button disabled={busy} onClick={() => pick('imposed')}>
              Proof an imposed PDF…
            </button>
          </div>
          <p className="muted small">
            <strong>Pages PDF</strong>: one page per finished page, in reading order (as exported
            from InDesign). <strong>Imposed PDF</strong>: print-ready sheets to check against the
            recipe.
          </p>
        </>
      ) : (
        <>
          <p className="file">
            <strong title={pdf.name}>{pdf.name}.pdf</strong>
            <span className="muted">
              {' '}
              · {pdf.info.length} page{pdf.info.length === 1 ? '' : 's'}
              {size && ` · ${mm(size.w)} × ${mm(size.h)} mm`}
              {pdf.mode === 'imposed' ? ' · imposed sheets' : ''}
            </span>
          </p>
          {art && art.rendered < art.total && (
            <p className="muted small">
              Rendering pages… {art.rendered} / {art.total}
            </p>
          )}
          {pdf.mode === 'imposed' && (
            <div className="imposed-options">
              <label>
                PDF page order
                <select
                  value={imposed.order}
                  onChange={(e) =>
                    onImposed({ ...imposed, order: e.target.value as ImposedOptions['order'] })
                  }
                >
                  <option value="duplex">Front, back, front, back… (duplex)</option>
                  <option value="fronts-then-backs">All fronts, then all backs</option>
                  <option value="simplex">Fronts only (single-sided)</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={imposed.backRotated}
                  onChange={(e) => onImposed({ ...imposed, backRotated: e.target.checked })}
                />
                Backs are upside down (made for flipping top ↔ bottom)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(imposed.reversed)}
                  onChange={(e) => onImposed({ ...imposed, reversed: e.target.checked })}
                />
                Printed sheets are in reverse order (last sheet first)
              </label>
              <SheetOrderField
                order={imposed.sheetOrder}
                n={sheetPositions}
                onChange={(sheetOrder) => onImposed({ ...imposed, sheetOrder })}
              />
              <label>
                Each printed sheet holds
                <select
                  value={holds}
                  onChange={(e) => {
                    const v = e.target.value as typeof holds;
                    onImposed({
                      ...imposed,
                      gang:
                        v === 'several'
                          ? { across: 2, down: 1, order: imposed.gang?.order ?? 'stack' }
                          : { across: 1, down: 1, order: imposed.gang?.order ?? 'stack' },
                      sections: v === 'sections' ? { across: 3, down: 1, blank: 'end' } : null,
                    });
                  }}
                >
                  <option value="one">One sheet</option>
                  <option value="several">Several sheets side by side, cut apart</option>
                  <option value="sections">
                    Equal sections, one page each (blank ones cut off)
                  </option>
                </select>
              </label>
              {holds !== 'one' && (
                <div className="row3">
                  <label>
                    {holds === 'sections' ? 'Sections across' : 'Across'}
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={holds === 'sections' ? sections.across : gang.across}
                      onChange={(e) => {
                        const n = Math.min(12, Math.max(1, Number(e.target.value) || 1));
                        if (holds === 'sections') setSections({ across: n });
                        else setGang({ across: n });
                      }}
                    />
                  </label>
                  <label>
                    {holds === 'sections' ? 'Sections down' : 'Down'}
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={holds === 'sections' ? sections.down : gang.down}
                      onChange={(e) => {
                        const n = Math.min(12, Math.max(1, Number(e.target.value) || 1));
                        if (holds === 'sections') setSections({ down: n });
                        else setGang({ down: n });
                      }}
                    />
                  </label>
                  {holds === 'sections' ? (
                    <label>
                      Blank sections
                      <select
                        value={sections.blank}
                        onChange={(e) => setSections({ blank: e.target.value as 'end' | 'start' })}
                      >
                        <option value="end">After the pages</option>
                        <option value="start">Before the pages</option>
                      </select>
                    </label>
                  ) : (
                    <label>
                      Cutting gap (mm)
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={imposed.gutter ?? 0}
                        onChange={(e) =>
                          onImposed({
                            ...imposed,
                            gutter: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </label>
                  )}
                </div>
              )}
              {holds === 'several' && (
                <label>
                  Bleed around each (mm)
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={imposed.bleed ?? 0}
                    onChange={(e) =>
                      onImposed({ ...imposed, bleed: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                  <span className="muted small">
                    As exported: the parts are twice the bleed plus the cutting gap apart.
                  </span>
                </label>
              )}
              {holds !== 'one' && (
                <label>
                  The parts are
                  <select
                    value={gang.order}
                    onChange={(e) => setGang({ order: e.target.value as 'stack' | 'copies' })}
                  >
                    <option value="stack">Cut and stacked (one copy)</option>
                    <option value="copies">Copies of the same sheet</option>
                  </select>
                </label>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={imposed.useTrimBox}
                  disabled={!first?.hasTrim}
                  onChange={(e) => onImposed({ ...imposed, useTrimBox: e.target.checked })}
                />
                Use the PDF trim box{first?.hasTrim ? '' : ' (none in this PDF)'}
              </label>
              <fieldset className="insets">
                <legend>Margin around the pages (mm)</legend>
                {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                  <label key={k}>
                    {k}
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={inset[k]}
                      onChange={(e) => setInset(k, Number(e.target.value) || 0)}
                    />
                  </label>
                ))}
              </fieldset>
              <p className="muted small">
                The recipe decides how each sheet is cut into panels and which page each panel
                should hold. Check the reading order on the Sheets tab and leaf through it in 3D.
              </p>
            </div>
          )}
          <div className="buttons">
            <button onClick={onClose}>Close PDF</button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/**
 * The sheet order as text: sheets numbered as they come in the PDF (each cut-apart part counts as
 * one), in the order they are read. A partial list puts those first and the rest after, in order.
 */
function SheetOrderField({
  order,
  n,
  onChange,
}: {
  order: number[] | undefined;
  n: number;
  onChange: (order: number[] | undefined) => void;
}) {
  const text = sheetPermutation(order, n)
    .map((v) => v + 1)
    .join(', ');
  const commit = (value: string) => {
    const parts = value.match(/\d+/g)?.map((v) => Number(v) - 1) ?? [];
    const next = sheetPermutation(parts, n);
    onChange(inPdfOrder(next, n) ? undefined : next);
  };
  return (
    <div className="sheet-order">
      <label>
        Sheet order
        <span className="row-inline">
          <input
            key={text}
            type="text"
            inputMode="numeric"
            defaultValue={text}
            aria-describedby="sheet-order-hint"
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button type="button" disabled={inPdfOrder(order, n)} onClick={() => onChange(undefined)}>
            Reset
          </button>
        </span>
      </label>
      <p id="sheet-order-hint" className="muted small">
        Drag the sheets on the Sheets tab, or type them numbered in the PDF&apos;s own order: “3, 1,
        2” reads its third sheet first.
      </p>
    </div>
  );
}
