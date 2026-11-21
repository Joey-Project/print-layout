import type { FoldStep, PanelFace, Recipe } from './types';

/** Concertina folds from the right end, alternating direction, collapsing onto panel 1. */
export function concertinaFolds(panels: number): FoldStep[] {
  return Array.from({ length: panels - 1 }, (_, i) => ({
    axis: 'x' as const,
    at: panels - 1 - i,
    move: 'high' as const,
    to: i % 2 === 0 ? ('under' as const) : ('over' as const),
  }));
}

export function accordion(panels: number): Recipe {
  return {
    id: `accordion-${panels}`,
    name: `Accordion (${panels} panels)`,
    description:
      `One strip of ${panels} panels folded back and forth. Reads across the front, ` +
      'then across the back after turning the whole strip over.',
    grid: { cols: panels, rows: 1 },
    folds: concertinaFolds(panels),
    reading: { mode: 'sequence' },
  };
}

const f = (col: number, row: number, rotation: 0 | 180 = 0): PanelFace => ({
  side: 'front',
  col,
  row,
  rotation,
});
const b = (col: number, row: number, rotation: 0 | 180 = 0): PanelFace => ({
  side: 'back',
  col,
  row,
  rotation,
});

export const builtinRecipes: Recipe[] = [
  {
    id: 'saddle-stitch',
    name: 'Saddle stitch',
    description:
      'Sheets printed 2-up on both sides, nested inside each other, folded once and stapled ' +
      'through the fold. Spine on the left.',
    grid: { cols: 2, rows: 1 },
    folds: [{ axis: 'x', at: 1, move: 'low', to: 'under' }],
    reading: { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 'all' },
    padding: 'beforeLastPage',
  },
  {
    id: 'saddle-stitch-rtl',
    name: 'Saddle stitch (right-to-left)',
    description: 'As saddle stitch, but the spine is on the right (e.g. vertical CJK text, manga).',
    grid: { cols: 2, rows: 1 },
    folds: [{ axis: 'x', at: 1, move: 'high', to: 'under' }],
    reading: { mode: 'bound', bindingEdge: 'right', sheetsPerSignature: 'all' },
    padding: 'beforeLastPage',
  },
  accordion(4),
  accordion(6),
  {
    id: 'tri-fold-roll',
    name: 'Tri-fold (roll / letter fold)',
    description:
      'Three panels; the left panel folds in first, the right panel wraps around it. ' +
      'Order: front cover, inside left/middle/right, inside flap, back cover.',
    grid: { cols: 3, rows: 1 },
    folds: [
      { axis: 'x', at: 1, move: 'low', to: 'under' },
      { axis: 'x', at: 2, move: 'high', to: 'under' },
    ],
    reading: { mode: 'sequence', order: [f(2, 0), b(0, 0), b(1, 0), b(2, 0), f(0, 0), f(1, 0)] },
  },
  {
    id: 'z-fold',
    name: 'Z-fold',
    description: 'Three panels folded in a zig-zag. Reads across the front, then across the back.',
    grid: { cols: 3, rows: 1 },
    folds: [
      { axis: 'x', at: 1, move: 'high', to: 'under' },
      { axis: 'x', at: 0, move: 'low', to: 'under' },
    ],
    reading: { mode: 'sequence' },
  },
  {
    id: 'mini-zine-8',
    name: 'Mini zine (8 pages, one sheet)',
    description:
      'Single-sided sheet of 4×2 panels, slit along the middle and folded into an 8-page booklet. ' +
      'The top row prints upside down. (Fold animation not available yet.)',
    grid: { cols: 4, rows: 2 },
    folds: [],
    reading: {
      mode: 'sequence',
      order: [
        f(3, 1),
        f(3, 0, 180),
        f(2, 0, 180),
        f(1, 0, 180),
        f(0, 0, 180),
        f(0, 1),
        f(1, 1),
        f(2, 1),
      ],
    },
  },
  {
    id: 'signature-8',
    name: '8-page signature (two right-angle folds)',
    description:
      'Four panels per side, folded in half twice at right angles; head is trimmed open. ' +
      'Top-row pages print head-to-head.',
    grid: { cols: 2, rows: 2 },
    folds: [
      { axis: 'y', at: 1, move: 'low', to: 'under' },
      { axis: 'x', at: 1, move: 'low', to: 'under' },
    ],
    reading: { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 1 },
  },
  {
    id: 'sewn-signatures-4',
    name: 'Section-sewn (4-sheet signatures)',
    description:
      'Like saddle stitch, but every 4 sheets form their own folded section; sections are stacked ' +
      'and sewn or glued (perfect binding).',
    grid: { cols: 2, rows: 1 },
    folds: [{ axis: 'x', at: 1, move: 'low', to: 'under' }],
    reading: { mode: 'bound', bindingEdge: 'left', sheetsPerSignature: 4 },
  },
];
