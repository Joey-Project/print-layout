import { useEffect, useRef, useState } from 'react';
import type { Grid, Plan, Slot } from '../engine';
import type { PdfArt } from './pdfArt';

/** Draws a rendered page image, scaled to fill the element. */
function ArtCanvas({ image, className }: { image: HTMLCanvasElement; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height);
  }, [image]);
  return <canvas ref={ref} className={className ?? 'art'} />;
}

interface SideProps {
  title: string;
  hint: string;
  grid: Grid;
  slots: Slot[];
  hovered: number | null;
  onHover: (position: number | null) => void;
  /** Panel image for (col, row) of this side, if a PDF is loaded. */
  art?: (col: number, row: number) => HTMLCanvasElement | null;
}

function SideView({ title, hint, grid, slots, hovered, onHover, art }: SideProps) {
  const cells = new Map(slots.map((s) => [`${s.col},${s.row}`, s]));
  return (
    <figure className="side">
      <figcaption>
        <strong>{title}</strong> <span className="muted">{hint}</span>
      </figcaption>
      <div
        className="sheet-grid"
        style={{ gridTemplateColumns: `repeat(${grid.cols}, var(--panel-w))` }}
      >
        {Array.from({ length: grid.rows }, (_, row) =>
          Array.from({ length: grid.cols }, (_, col) => {
            const s = cells.get(`${col},${row}`);
            if (!s) return <div key={`${col},${row}`} className="panel empty" />;
            const blank = s.page === null;
            const image = art?.(col, row) ?? null;
            return (
              <div
                key={`${col},${row}`}
                className={`panel${blank ? ' blank' : ''}${hovered === s.position ? ' hot' : ''}`}
                onMouseEnter={() => onHover(s.position)}
                onMouseLeave={() => onHover(null)}
                title={
                  blank
                    ? `Blank (reading position ${s.position})`
                    : `Page ${s.page} · reading position ${s.position}` +
                      (s.rotation ? ' · printed upside down' : '')
                }
              >
                {image && <ArtCanvas image={image} />}
                <span
                  className={`page-no${image ? ' on-art' : ''}`}
                  style={{ rotate: `${blank ? 0 : s.rotation}deg` }}
                >
                  {blank ? 'blank' : s.page}
                </span>
                <span className="pos">#{s.position}</span>
              </div>
            );
          }),
        )}
      </div>
    </figure>
  );
}

/** Reordering the sheets of an imposed PDF being proofed. */
export interface SheetOrderControls {
  /** Where sheet i's artwork comes from, e.g. "PDF sheet 3, part 2". */
  source(sheet: number): string;
  /** Whether sheet i is read from somewhere other than its own place in the PDF. */
  moved(sheet: number): boolean;
  /** Move the artwork of the sheet at `from` to `to` (the others close up). */
  move(from: number, to: number): void;
}

export function PlanView({
  plan,
  hovered,
  onHover,
  pdfArt = null,
  showReading = false,
  order = null,
}: {
  plan: Plan;
  hovered: number | null;
  onHover: (p: number | null) => void;
  /** Artwork from a loaded PDF. */
  pdfArt?: PdfArt | null;
  /** Show the imposed PDF cut back into reading order (proof mode). */
  showReading?: boolean;
  /** Let the sheets be dragged into another order (proof mode). */
  order?: SheetOrderControls | null;
}) {
  // The sheet being dragged (or whose header is pointed at), and where it would drop.
  const [dragging, setDragging] = useState<number | null>(null);
  const [pointed, setPointed] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const active = dragging ?? pointed;
  const activePositions = new Set(
    active === null
      ? []
      : [...plan.sheets[active]!.front, ...plan.sheets[active]!.back].map((s) => s.position),
  );
  const n = plan.sheets.length;
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const style = pdfArt
    ? ({
        '--panel-h': `calc(var(--panel-w) * ${pdfArt.aspect})`,
        '--page-aspect': String(pdfArt.aspect),
      } as React.CSSProperties)
    : undefined;
  const artFor = (sheet: number, side: 'front' | 'back') =>
    pdfArt ? (col: number, row: number) => pdfArt.art(sheet, side, col, row) : undefined;
  return (
    <div className="sheets" style={style}>
      {pdfArt && showReading && (
        <section className="sheet-card reading-strip">
          <h3>Reading order</h3>
          <p className="muted small">
            Each panel cut from the imposed PDF and turned upright, in the order the recipe reads
            them. Anything out of order or upside down here is wrong on the sheets.
          </p>
          <div className="reading-pages">
            {Array.from({ length: plan.slotCount }, (_, i) => {
              const image = pdfArt.reading(i + 1);
              return (
                <figure
                  key={i}
                  className={
                    [hovered === i + 1 && 'hot', activePositions.has(i + 1) && 'group']
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onMouseEnter={() => onHover(i + 1)}
                  onMouseLeave={() => onHover(null)}
                >
                  {image ? <ArtCanvas image={image} /> : <div className="art pending" />}
                  <figcaption>{i + 1}</figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}
      {plan.sheets.map((sheet, i) => (
        <section
          key={i}
          className={[
            'sheet-card',
            order && 'movable',
            dragging === i && 'dragging',
            dropAt === i && dragging !== null && dragging !== i && 'drop-here',
          ]
            .filter(Boolean)
            .join(' ')}
          draggable={order !== null}
          onDragStart={(e) => {
            if (!order) return;
            setDragging(i);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
          }}
          onDragOver={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dropAt !== i) setDropAt(i);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (order && dragging !== null) order.move(dragging, i);
            endDrag();
          }}
          onDragEnd={endDrag}
        >
          {order ? (
            <h3
              className="sheet-head"
              onMouseEnter={() => setPointed(i)}
              onMouseLeave={() => setPointed(null)}
            >
              <span className="grip" aria-hidden="true" title="Drag to reorder">
                ⠿
              </span>
              Sheet {i + 1}
              <span className={`from${order.moved(i) ? ' moved' : ''}`}>
                from {order.source(i)}
              </span>
              <span className="move">
                <button
                  type="button"
                  disabled={i === 0}
                  aria-label={`Move sheet ${i + 1} earlier`}
                  title="Earlier"
                  onClick={() => order.move(i, i - 1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={i === n - 1}
                  aria-label={`Move sheet ${i + 1} later`}
                  title="Later"
                  onClick={() => order.move(i, i + 1)}
                >
                  →
                </button>
              </span>
            </h3>
          ) : (
            <h3>Sheet {i + 1}</h3>
          )}
          <div className="sides">
            <SideView
              title="Front"
              hint=""
              grid={plan.grid}
              slots={sheet.front}
              hovered={hovered}
              onHover={onHover}
              art={artFor(i, 'front')}
            />
            {sheet.back.length > 0 ? (
              <SideView
                title="Back"
                hint="(turned over sideways, like a book page)"
                grid={plan.grid}
                slots={sheet.back}
                hovered={hovered}
                onHover={onHover}
                art={artFor(i, 'back')}
              />
            ) : (
              <p className="muted single">Single-sided — back stays blank.</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
