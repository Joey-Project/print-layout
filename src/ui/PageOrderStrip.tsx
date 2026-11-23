import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import {
  inPageOrder,
  movePages,
  pagePermutation,
  selectPages,
  stepPages,
  type Moved,
} from '../pdf/pageOrder';
import type { PdfArt } from './pdfArt';
import { ArtCanvas } from './SheetView';

/**
 * A reading-order PDF's pages in book order, to put in another order before imposing: select
 * pages (click, Shift-click for a range, Cmd/Ctrl-click to add or remove one), then drag them as a
 * block to a new place or move them with the earlier/later buttons.
 */
export function PageOrderStrip({
  n,
  order,
  art,
  onChange,
}: {
  /** Pages in the PDF. */
  n: number;
  /** `order[i]`: the PDF page (0-based) read as book page i + 1; unset = the PDF's order. */
  order: number[] | undefined;
  art: PdfArt;
  onChange: (order: number[] | undefined) => void;
}) {
  const perm = pagePermutation(order, n);
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
    onChange(inPageOrder(m.order, n) ? undefined : m.order);
    setSelected(m.at);
    setAnchor(m.at[0] ?? null);
    const where = m.at.length === 1 ? `now page ${m.at[0]! + 1}` : `now pages ${ranges(m.at)}`;
    setStatus(`${what}: ${where}.`);
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
  const moved = perm.filter((v, i) => v !== i).length;

  return (
    <section
      className="sheet-card page-order"
      style={{ '--page-aspect': String(art.aspect) } as React.CSSProperties}
    >
      <h3>Page order</h3>
      <p className="muted small">
        The PDF&apos;s pages as the book reads them. Select pages (Shift-click for a range,
        {isMac() ? ' ⌘' : ' Ctrl'}-click to add or remove one) and drag them to a new place, or move
        them with the buttons.
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
        <button
          type="button"
          disabled={moved === 0}
          onClick={() => {
            onChange(undefined);
            setSelected([]);
            setAnchor(null);
            setStatus('Pages back in the PDF’s order.');
          }}
        >
          Reset
        </button>
        <span className="muted small" aria-live="polite">
          {selected.length > 0
            ? `${selected.length} selected (${ranges(selected)})`
            : moved > 0
              ? `${moved} page${moved === 1 ? '' : 's'} moved`
              : 'In the PDF’s order'}
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
          const image = art.sourcePage(src + 1);
          const cls = [
            sel.has(i) && 'selected',
            dragging?.includes(i) && 'dragging',
            gap === i && 'drop-before',
            gap === n && i === n - 1 && 'drop-after',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <figure
              key={src}
              className={cls || undefined}
              role="option"
              aria-selected={sel.has(i)}
              aria-label={`Page ${i + 1}${src !== i ? `, from PDF page ${src + 1}` : ''}`}
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
              {image ? <ArtCanvas image={image} /> : <div className="art pending" />}
              <figcaption>
                {i + 1}
                {src !== i && <span className="from">from PDF page {src + 1}</span>}
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
