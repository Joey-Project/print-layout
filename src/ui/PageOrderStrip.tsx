import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import {
  insertBlanks,
  movedCount,
  movePages,
  pageEntries,
  removeBlanks,
  selectPages,
  stepPages,
  storedOrder,
  type Moved,
  type PageEntry,
} from '../pdf/pageOrder';
import type { PdfArt } from './pdfArt';
import { ArtCanvas } from './SheetView';

/**
 * A reading-order PDF's pages in book order, to put in another order before imposing: select
 * pages (click, Shift-click for a range, Cmd/Ctrl-click to add or remove one), then drag them as a
 * block to a new place or move them with the earlier/later buttons. Blank pages can be inserted
 * before or after the selection, moved like pages, and removed again (Delete, or the button).
 */
export function PageOrderStrip({
  n,
  order,
  art,
  onChange,
}: {
  /** Pages in the PDF. */
  n: number;
  /**
   * `order[i]`: the PDF page (0-based) read as book page i + 1, or `null` for a blank page; unset =
   * the PDF's order.
   */
  order: PageEntry[] | undefined;
  art: PdfArt;
  onChange: (order: PageEntry[] | undefined) => void;
}) {
  const perm = pageEntries(order, n);
  const len = perm.length;
  // React keys: a PDF page by its number, a blank by how many blanks come before it.
  let blankNo = 0;
  const keys = perm.map((v) => (v === null ? `blank-${blankNo++}` : `page-${v}`));
  // A page is out of place when it is not the PDF page it would be without the blanks.
  let pageNo = 0;
  const outOfPlace = perm.map((v) => v !== null && v !== pageNo++);
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  // The pages being dragged (a ref too: drop can come before a re-render) and where they'd go.
  const dragged = useRef<number[] | null>(null);
  const [dragging, setDragging] = useState<number[] | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  // Another PDF (or page count): the old selection means nothing.
  useEffect(() => {
    setSelected([]);
    setAnchor(null);
  }, [n]);

  // What the last action did, for screen readers.
  const [status, setStatus] = useState('');
  const sel = new Set(selected);
  const apply = (m: Moved, what: string) => {
    onChange(storedOrder(m.order, n));
    setSelected(m.at);
    setAnchor(m.at[0] ?? null);
    const where =
      m.at.length === 0
        ? ''
        : m.at.length === 1
          ? `: now page ${m.at[0]! + 1}`
          : `: now pages ${ranges(m.at)}`;
    setStatus(`${what}${where}.`);
  };

  const pick = (i: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const s = selectPages(selected, anchor, i, {
      range: e.shiftKey,
      toggle: e.metaKey || e.ctrlKey,
    });
    setSelected(s.selected);
    setAnchor(s.anchor);
  };

  const endDrag = () => {
    dragged.current = null;
    setDragging(null);
    setGap(null);
  };
  const gapAt = (e: DragEvent<HTMLElement>, i: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  const drop = (e: DragEvent<HTMLElement>, at: number | null) => {
    e.preventDefault();
    const pages = dragged.current;
    if (pages && at !== null) {
      const m = movePages(order, n, pages, at);
      if (m.order.some((v, k) => v !== perm[k])) apply(m, 'Moved');
      else {
        setSelected(m.at);
        setAnchor(m.at[0] ?? null);
      }
    }
    endDrag();
  };

  const earlier = stepPages(order, n, selected, -1);
  const later = stepPages(order, n, selected, 1);
  const changes = (m: Moved) => m.order.some((v, k) => v !== perm[k]);
  const moved = movedCount(order, n);
  const blanks = len - n;
  const selectedBlanks = selected.filter((i) => perm[i] === null).length;
  const removeSelectedBlanks = () => {
    if (selectedBlanks === 0) return;
    apply(
      removeBlanks(order, n, selected),
      `Removed ${selectedBlanks} blank page${selectedBlanks === 1 ? '' : 's'}`,
    );
  };

  return (
    <section
      className="sheet-card page-order"
      style={{ '--page-aspect': String(art.aspect) } as React.CSSProperties}
    >
      <h3>Page order</h3>
      <p className="muted small">
        The PDF&apos;s pages as the book reads them. Select pages (Shift-click for a range,
        {isMac() ? ' ⌘' : ' Ctrl'}-click to add or remove one) and drag them to a new place, or move
        them with the buttons. Insert blank pages next to the selection.
      </p>
      <div className="page-order-tools">
        <button
          type="button"
          disabled={!changes(earlier)}
          onClick={() => apply(earlier, 'Moved earlier')}
          aria-label="Move the selected pages earlier"
        >
          ← Earlier
        </button>
        <button
          type="button"
          disabled={!changes(later)}
          onClick={() => apply(later, 'Moved later')}
          aria-label="Move the selected pages later"
        >
          Later →
        </button>
        <span className="sep" aria-hidden="true" />
        <button
          type="button"
          onClick={() => apply(insertBlanks(order, n, selected, 'before'), 'Blank page inserted')}
          title={
            selected.length
              ? 'Insert a blank page before the selection'
              : 'At the start of the book'
          }
        >
          + Blank before
        </button>
        <button
          type="button"
          onClick={() => apply(insertBlanks(order, n, selected, 'after'), 'Blank page inserted')}
          title={
            selected.length ? 'Insert a blank page after the selection' : 'At the end of the book'
          }
        >
          + Blank after
        </button>
        <button
          type="button"
          disabled={selectedBlanks === 0}
          onClick={removeSelectedBlanks}
          title="Remove the selected blank pages (Delete)"
        >
          Remove blank{selectedBlanks > 1 ? 's' : ''}
        </button>
        <span className="sep" aria-hidden="true" />
        <button
          type="button"
          disabled={moved === 0 && blanks === 0}
          onClick={() => {
            onChange(undefined);
            setSelected([]);
            setAnchor(null);
            setStatus('Pages back in the PDF’s order, without blanks.');
          }}
          title="Put the pages back in the PDF’s order and remove every blank page"
        >
          Reset
        </button>
        <span className="muted small" aria-live="polite">
          {selected.length > 0
            ? `${selected.length} selected (${ranges(selected)})`
            : [
                moved > 0 && `${moved} page${moved === 1 ? '' : 's'} moved`,
                blanks > 0 && `${blanks} blank page${blanks === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(' · ') || 'In the PDF’s order'}
          {status && <span className="sr-only"> · {status}</span>}
        </span>
      </div>
      <div
        className="reading-pages page-order-pages"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Pages in book order"
        onDragOver={(e) => {
          if (!dragged.current) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => drop(e, gap)}
      >
        {perm.map((src, i) => {
          const image = src === null ? null : art.sourcePage(src + 1);
          const cls = [
            sel.has(i) && 'selected',
            dragging?.includes(i) && 'dragging',
            gap === i && 'drop-before',
            gap === len && i === len - 1 && 'drop-after',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <figure
              key={keys[i]}
              className={cls || undefined}
              role="option"
              aria-selected={sel.has(i)}
              aria-label={
                src === null
                  ? `Page ${i + 1}, blank`
                  : `Page ${i + 1}${outOfPlace[i] ? `, from PDF page ${src + 1}` : ''}`
              }
              tabIndex={0}
              draggable
              onClick={(e: MouseEvent) => pick(i, e)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  pick(i, e);
                } else if (e.key === 'Escape') {
                  setSelected([]);
                  setAnchor(null);
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  removeSelectedBlanks();
                }
              }}
              onDragStart={(e) => {
                // Dragging a page outside the selection drags just that page.
                const pages = sel.has(i) ? selected : [i];
                if (!sel.has(i)) {
                  setSelected([i]);
                  setAnchor(i);
                }
                dragged.current = pages;
                setDragging(pages);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', pages.map((p) => p + 1).join(','));
              }}
              onDragOver={(e) => {
                if (!dragged.current) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const g = gapAt(e, i);
                if (g !== gap) setGap(g);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                drop(e, gapAt(e, i));
              }}
              onDragEnd={endDrag}
            >
              {src === null ? (
                <div className="art blank-page">blank</div>
              ) : image ? (
                <ArtCanvas image={image} />
              ) : (
                <div className="art pending" />
              )}
              <figcaption>
                {i + 1}
                {src !== null && outOfPlace[i] && (
                  <span className="from">from PDF page {src + 1}</span>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

/** "1–3, 7" for 0-based indices, numbered from 1. */
function ranges(indices: number[]) {
  const out: string[] = [];
  for (let k = 0; k < indices.length;) {
    let j = k;
    while (j + 1 < indices.length && indices[j + 1] === indices[j]! + 1) j++;
    out.push(k === j ? `${indices[k]! + 1}` : `${indices[k]! + 1}–${indices[j]! + 1}`);
    k = j + 1;
  }
  return out.join(', ');
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
