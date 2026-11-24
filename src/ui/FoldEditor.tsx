/**
 * Visual fold editor: build a recipe's fold program by picking fold lines on the packet as it
 * folds, then which part swings and whether it lands over or under. It edits the recipe draft (the
 * JSON below it stays the source of truth), so the 2D sheets and the 3D model follow as soon as
 * the program is complete.
 */
import { useState } from 'react';
import {
  foldLabel,
  foldLines,
  foldProgress,
  movingPart,
  stackDepths,
  type BindingEdge,
  type FoldLine,
  type FoldStep,
  type Grid,
  type Reading,
  type Recipe,
} from '../engine';

const MAX_GRID = 8;

/** The parts of a draft the editor needs, if the JSON has them in a usable shape. */
export function editable(value: unknown): Recipe | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<Recipe>;
  const g = r.grid;
  const int = (n: unknown, max: number) =>
    Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  if (!g || !int(g.cols, MAX_GRID) || !int(g.rows, MAX_GRID)) return null;
  if (!Array.isArray(r.folds)) return null;
  const okFold = (f: FoldStep) =>
    f &&
    (f.axis === 'x' || f.axis === 'y') &&
    Number.isInteger(f.at) &&
    (f.move === 'low' || f.move === 'high') &&
    (f.to === 'over' || f.to === 'under');
  if (!r.folds.every(okFold)) return null;
  const mode = r.reading?.mode;
  if (mode !== 'bound' && mode !== 'sequence') return null;
  if (typeof r.name !== 'string' || typeof r.id !== 'string') return null;
  return value as Recipe;
}

/** A recipe to start from: one sheet of two panels, no folds yet, bound on the left. */
export function newRecipe(takenIds: ReadonlySet<string>): Recipe {
  let n = 1;
  while (takenIds.has(n === 1 ? 'my-recipe' : `my-recipe-${n}`)) n++;
  return {
    id: n === 1 ? 'my-recipe' : `my-recipe-${n}`,
    name: n === 1 ? 'My recipe' : `My recipe ${n}`,
    grid: { cols: 2, rows: 1 },
    folds: [],
    reading: { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 'all' },
  };
}

const CELL = 44;
const PAD = 0.5;

export function FoldEditor({
  value,
  onChange,
  onNew,
}: {
  /** The draft as parsed JSON (anything; the editor works when it has a usable shape). */
  value: unknown;
  onChange: (recipe: Recipe) => void;
  onNew: () => void;
}) {
  const recipe = editable(value);
  const [picked, setPicked] = useState<FoldLine | null>(null);
  // The part a fold choice would swing, while the choice is pointed at or focused.
  const [swing, setSwing] = useState<FoldStep['move'] | null>(null);
  if (!recipe) {
    return (
      <div className="fold-editor">
        <p className="muted small">
          The recipe JSON below needs a grid (up to {MAX_GRID} × {MAX_GRID}), a list of folds, a
          name and a reading mode before it can be edited here.
        </p>
        <button onClick={onNew}>New recipe</button>
      </div>
    );
  }
  const { grid, folds } = recipe;
  const progress = foldProgress(grid, folds);
  const stage = progress.stages[progress.stages.length - 1]!;
  const lines = progress.broken ? [] : foldLines(stage.bounds);
  const pick =
    picked && lines.some((l) => l.axis === picked.axis && l.at === picked.at) ? picked : null;
  const depths = stackDepths(stage);
  const maxDepth = Math.max(1, ...depths.flat());
  const set = (patch: Partial<Recipe>) => onChange({ ...recipe, ...patch });
  const setFolds = (next: FoldStep[]) => {
    setPicked(null);
    setSwing(null);
    set({ folds: next });
  };
  const setGrid = (g: Partial<Grid>) => set({ grid: { ...grid, ...g } });

  // Everything the packet has covered so far, so the picture does not jump about as it folds.
  const all = progress.stages.map((s) => s.bounds);
  const view = {
    x0: Math.min(...all.map((b) => b.x0)) - PAD,
    y0: Math.min(...all.map((b) => b.y0)) - PAD,
    x1: Math.max(...all.map((b) => b.x1)) + PAD,
    y1: Math.max(...all.map((b) => b.y1)) + PAD,
  };
  const b = stage.bounds;
  const status = progress.broken
    ? `Fold ${progress.broken.index + 1} does not fit: ${progress.broken.message} Remove it or change the grid.`
    : progress.done
      ? `Folded to one panel, ${maxDepth} layer${maxDepth === 1 ? '' : 's'} thick: the program is complete.`
      : `The packet is ${Math.round(b.x1 - b.x0)} × ${Math.round(b.y1 - b.y0)} panels: pick a fold line.`;

  const reading = recipe.reading;
  const setReading = (r: Reading) => set({ reading: r });

  return (
    <div className="fold-editor">
      <label>
        Name
        <input value={recipe.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <div className="row">
        <label>
          Panels across
          <input
            type="number"
            min={1}
            max={MAX_GRID}
            value={grid.cols}
            onChange={(e) =>
              setGrid({
                cols: Math.min(MAX_GRID, Math.max(1, Math.floor(Number(e.target.value)) || 1)),
              })
            }
          />
        </label>
        <label>
          Panels down
          <input
            type="number"
            min={1}
            max={MAX_GRID}
            value={grid.rows}
            onChange={(e) =>
              setGrid({
                rows: Math.min(MAX_GRID, Math.max(1, Math.floor(Number(e.target.value)) || 1)),
              })
            }
          />
        </label>
      </div>

      <svg
        className="packet"
        viewBox={`${view.x0 * CELL} ${view.y0 * CELL} ${(view.x1 - view.x0) * CELL} ${(view.y1 - view.y0) * CELL}`}
        role="img"
        aria-label={`The packet after ${progress.stages.length - 1} fold${progress.stages.length === 2 ? '' : 's'}, front view`}
      >
        {progress.stages.length > 1 && (
          <rect
            className="ghost"
            x={progress.stages[0]!.bounds.x0 * CELL}
            y={progress.stages[0]!.bounds.y0 * CELL}
            width={grid.cols * CELL}
            height={grid.rows * CELL}
          />
        )}
        {depths.map((row, r) =>
          row.map((d, c) => (
            <g key={`${r}:${c}`}>
              <rect
                className="cell"
                x={(b.x0 + c) * CELL}
                y={(b.y0 + r) * CELL}
                width={CELL}
                height={CELL}
                style={{ fillOpacity: 0.25 + (0.6 * d) / maxDepth }}
              />
              <text x={(b.x0 + c + 0.5) * CELL} y={(b.y0 + r + 0.5) * CELL} className="depth">
                {d}
              </text>
            </g>
          )),
        )}
        {pick && swing && <rect className="moving" {...swingRect(b, pick, swing, CELL)} />}
        {lines.map((l) => {
          const on = pick?.axis === l.axis && pick.at === l.at;
          const [x1, y1, x2, y2] =
            l.axis === 'x' ? [l.at, b.y0, l.at, b.y1] : [b.x0, l.at, b.x1, l.at];
          return (
            <g
              key={`${l.axis}${l.at}`}
              className={`fold-line${on ? ' on' : ''}`}
              onClick={() => setPicked(on ? null : l)}
            >
              <line className="hit" x1={x1 * CELL} y1={y1 * CELL} x2={x2 * CELL} y2={y2 * CELL} />
              <line className="mark" x1={x1 * CELL} y1={y1 * CELL} x2={x2 * CELL} y2={y2 * CELL} />
            </g>
          );
        })}
      </svg>
      <p className="muted small">
        The folded packet, front view; numbers are layers of paper. Pick a fold line (on the picture
        or below), then which part swings over or under the rest.
      </p>

      {lines.length > 0 && (
        <div className="fold-lines" role="group" aria-label="Fold lines">
          {lines.map((l) => {
            const on = pick?.axis === l.axis && pick.at === l.at;
            return (
              <button
                key={`${l.axis}${l.at}`}
                aria-pressed={on}
                onClick={() => setPicked(on ? null : l)}
              >
                {l.axis === 'x' ? '│' : '─'} {l.axis} = {l.at}
              </button>
            );
          })}
        </div>
      )}
      {pick && (
        <div className="fold-choices" role="group" aria-label="How to fold">
          {(['low', 'high'] as const).flatMap((move) =>
            (['over', 'under'] as const).map((to) => (
              <button
                key={`${move}${to}`}
                onMouseEnter={() => setSwing(move)}
                onMouseLeave={() => setSwing(null)}
                onFocus={() => setSwing(move)}
                onBlur={() => setSwing(null)}
                onClick={() => setFolds([...folds, { axis: pick.axis, at: pick.at, move, to }])}
              >
                {movingPart(pick.axis, move)} part {to}
              </button>
            )),
          )}
        </div>
      )}
      <p
        className={`small ${progress.broken ? 'error-text' : progress.done ? 'ok-text' : 'muted'}`}
      >
        {status}
      </p>

      {folds.length > 0 && (
        <ol className="fold-steps">
          {folds.map((f, i) => {
            const fits = !progress.broken || i < progress.broken.index;
            return (
              <li key={i} className={fits ? undefined : 'broken'}>
                <span>{foldLabel(f)}</span>
                <span className="step-buttons">
                  <button
                    title="Swap over ↔ under (the packet keeps its shape)"
                    onClick={() =>
                      setFolds(
                        folds.map((g, j) =>
                          j === i ? { ...g, to: g.to === 'over' ? 'under' : 'over' } : g,
                        ),
                      )
                    }
                  >
                    {f.to === 'over' ? 'Make under' : 'Make over'}
                  </button>
                  <button
                    title="Remove this fold and the ones after it"
                    aria-label={`Remove fold ${i + 1} and later`}
                    onClick={() => setFolds(folds.slice(0, i))}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="row">
        <label>
          Reading
          <select
            value={reading.mode}
            onChange={(e) =>
              setReading(
                e.target.value === 'bound'
                  ? { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 'all' }
                  : { mode: 'sequence' },
              )
            }
          >
            <option value="bound">Bound: leaves turn at a spine</option>
            <option value="sequence">Unfolded: panels read in order</option>
          </select>
        </label>
        {reading.mode === 'bound' && (
          <label>
            Spine
            <select
              value={reading.bindingEdge}
              onChange={(e) =>
                setReading({ ...reading, bindingEdge: e.target.value as BindingEdge })
              }
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
        )}
      </div>
      {reading.mode === 'bound' && (
        <label>
          Sheets per section
          <select
            value={reading.sheetsPerSignature === 'all' ? 'all' : 'some'}
            onChange={(e) =>
              setReading({
                ...reading,
                sheetsPerSignature: e.target.value === 'all' ? 'all' : 4,
              })
            }
          >
            <option value="all">All nested in one (saddle stitch)</option>
            <option value="some">Gathered sections of…</option>
          </select>
          {reading.sheetsPerSignature !== 'all' && (
            <input
              type="number"
              min={1}
              max={32}
              aria-label="Sheets in each section"
              value={reading.sheetsPerSignature}
              onChange={(e) =>
                setReading({
                  ...reading,
                  sheetsPerSignature: Math.min(
                    32,
                    Math.max(1, Math.floor(Number(e.target.value)) || 1),
                  ),
                })
              }
            />
          )}
        </label>
      )}
      {reading.mode === 'sequence' && (
        <p className="muted small">
          {reading.order
            ? 'Reads in the order listed in the JSON below.'
            : 'Reads across the front, then across the back; list the faces in the JSON for another order.'}
        </p>
      )}
      <div className="buttons">
        <button onClick={() => setFolds(folds.slice(0, -1))} disabled={folds.length === 0}>
          Undo fold
        </button>
        <button onClick={() => setFolds([])} disabled={folds.length === 0}>
          Clear folds
        </button>
        <button onClick={onNew}>New recipe</button>
      </div>
    </div>
  );
}

/** The part of the packet `b` that swings for a fold along `line`, in SVG units. */
function swingRect(
  b: { x0: number; y0: number; x1: number; y1: number },
  line: FoldLine,
  move: FoldStep['move'],
  cell: number,
) {
  const [lo, hi] = line.axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1];
  const [from, to] = move === 'low' ? [lo, line.at] : [line.at, hi];
  return line.axis === 'x'
    ? { x: from * cell, y: b.y0 * cell, width: (to - from) * cell, height: (b.y1 - b.y0) * cell }
    : { x: b.x0 * cell, y: from * cell, width: (b.x1 - b.x0) * cell, height: (to - from) * cell };
}
