import { useRef, useState } from 'react';
import { MM } from '../pdf/geometry';
import { displayedSize, type ImposedOptions } from '../pdf/imposed';
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
}: {
  pdf: LoadedPdf | null;
  art: PdfArt | null;
  imposed: ImposedOptions;
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
      ? displayedSize(first.trim, first.rotate)
      : displayedSize(first.crop, first.rotate)
    : null;
  const inset = imposed.inset;
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
