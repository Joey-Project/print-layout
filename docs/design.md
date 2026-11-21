# Print Layout — Design

A local, single-page web app that turns a reading-order PDF (one page per booklet page, as exported
from InDesign) into a print-ready imposed PDF, and lets the user preview — in 2D and 3D — how the
printed sheets fold, assemble, and read.

## Goals

1. **Preview / verify**: show exactly where every page lands on each printed sheet, and how the
   sheets fold and assemble into the finished piece. Optionally verify an already-imposed PDF against
   the reading-order source.
2. **Generate**: produce the imposed, print-ready PDF automatically.
3. **Extensible binding styles**: bindings are _recipes_ (data), not code. Users can create, edit,
   save, and share recipes. Built-ins are just pre-made recipes.

## Decisions so far

| Topic           | Decision                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Platform        | Local-first SPA (Vite + React + TypeScript). Nothing is uploaded. Packaging (Tauri etc.) later. |
| Engine          | Pure TypeScript library in `src/engine`, no DOM dependencies, unit-tested with Vitest.          |
| PDF in          | pdf.js for rendering thumbnails/previews.                                                       |
| PDF out         | pdf-lib, embedding source pages as vector Form XObjects (no rasterising).                       |
| 3D              | three.js (likely via react-three-fiber).                                                        |
| Recipe priority | 1 saddle stitch · 2 accordion/concertina · 3 tri-fold/Z-fold · 4 mini zine · 5 signatures, etc. |
| Print options   | All sheet sizes, home duplex and print shop; crop marks, bleed, PDF/X optional add-ons.         |
| Creep           | Not in v1.                                                                                      |
| InDesign        | Later, a thin add-on that only applies saved recipes.                                           |
| Distribution    | Should be usable by others; unsigned/extra install steps acceptable.                            |

## Core model

### Coordinates and units

- A **sheet** is divided into a grid of `cols × rows` **panels**. Coordinates are in panel units,
  origin at the top-left of the sheet's **front** side, `y` grows downward.
- The **back view** is what you see after turning the sheet over like a book page (around its
  vertical axis): back-view column = `cols − 1 − col`. The output PDF stores back sides in this view.
  Printers that flip "top-to-bottom" get back pages rotated 180° at export time.
- Physical sizes (page trim size, sheet size, margins, bleed) are applied only at PDF generation.

### Recipe

```ts
interface Recipe {
  id: string;
  name: string;
  grid: { cols: number; rows: number }; // panels per sheet side
  folds: FoldStep[]; // the folding program, in order
  reading: BoundReading | SequenceReading;
  padding?: 'end' | 'beforeLastPage'; // where blank pages go
}

interface FoldStep {
  axis: 'x' | 'y'; // 'x' = fold along a vertical line x = at
  at: number; // grid line in the *current folded* coordinates
  move: 'low' | 'high'; // which side of the line swings
  to: 'over' | 'under'; // moving part lands on top of / beneath the stack
}

// Codex-style: leaves are trimmed and bound along one edge (saddle stitch, signatures).
interface BoundReading {
  mode: 'bound';
  bindingEdge: 'left' | 'right' | 'top' | 'bottom'; // seen from the cover
  sheetsPerSignature: number | 'all'; // 'all' = everything nested (saddle stitch)
}

// Unfolded pieces (accordion, tri-fold, zine): reading order is an explicit list of panel faces.
interface SequenceReading {
  mode: 'sequence';
  order?: { side: 'front' | 'back'; col: number; row: number; rotation?: 0 | 180 }[];
  // default: front panels row-major, then back panels row-major in back view
}
```

### Fold simulation (bound mode)

The engine folds a virtual stack exactly like a paper dummy:

1. Each sheet starts as one **facet** (a rectangle in sheet coordinates) with an identity transform
   to folded space and a layer index (sheet 1 on top).
2. A fold splits every facet crossing the line, reflects the moving side across it, and re-stacks the
   moved facets (reversed) above (`over`) or below (`under`) the whole stack.
3. After all folds every facet must cover the same one-panel rectangle — that rectangle is the page.
4. Walking the stack top → bottom, each facet is one **leaf**: its top face is the next odd page, its
   bottom face the next even page. The facet's transform tells which sheet side, which panel, and
   whether the page must be printed rotated 180°.

Nested assembly (saddle stitch) = stack the flat sheets, then fold them together. Gathered assembly
(perfect binding) = fold each signature separately, then stack the signatures.

### Imposition plan (engine output)

```ts
interface Plan {
  grid: { cols: number; rows: number };
  slotCount: number; // reading positions incl. blanks
  sheets: { front: Slot[]; back: Slot[] }[];
}
interface Slot {
  col: number;
  row: number; // in that side's view
  position: number; // 1-based reading position
  page: number | null; // 1-based source page, null = blank
  rotation: 0 | 180;
}
```

The plan is the single source of truth for 2D preview, PDF generation, and (inverted) verification of
an existing imposed PDF. The fold program additionally drives the 3D animation.

## Roadmap

1. **Engine + 2D prototype** — recipe model, fold simulator, plan; built-in recipes; recipe JSON
   editor with live 2D sheet preview. _(done)_
2. **3D viewer** — one scrubbable timeline (`src/viewer/timeline.ts`) derived from the same fold
   simulation: printed sheets → stack → each fold → gather sections → turn leaves. Play forward /
   backward, pause, step, speed, explode layers, orbit camera; drag a page across the spine to
   turn it by hand. Printed sheets start in a column, slide up under the sheets above into a stack
   with visible gaps, then square up. Folds are drawn as curved paper joining the two panels, so
   nested sheets wrap round each other at the spine; head/foot folds are trimmed off when reading
   starts. Tests assert the visible page at
   every page turn matches the 2D plan and is upright. _(done; next: open-book "spreads" layout,
   paper thickness/creep, PDF page textures)_
3. **PDF in/out** — load PDF (pdf.js thumbnails on the sheets and 3D faces), physical layout (sheet
   size, margins, gutters, trim/bleed boxes), export via pdf-lib; duplex flip option.
4. **Verification** — load an imposed PDF + recipe, reconstruct reading order; optional auto-diff
   against the source PDF.
5. **Print extras** — crop/fold marks, bleed handling, PDF/X output intent, n-up copies, creep.
6. **Visual fold editor**, recipe import/export, InDesign add-on, packaging.

## Open questions

- Non-uniform panels (roll-fold inner panel slightly narrower) — needs per-column widths.
- Folds that only move part of the stack (needed to simulate the mini zine physically); for now the
  zine uses an explicit sequence.
