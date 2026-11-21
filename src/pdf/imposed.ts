/**
 * Reading an already-imposed (print-ready) PDF back: which PDF page is which sheet side, and where
 * each panel sits on it. Pure geometry; rendering and PDF writing build on it.
 *
 * Regions are in *displayed* page coordinates as fractions (0..1, y down) — the page as a viewer
 * shows it, after its /Rotate — so they apply equally to a rendered canvas and, converted back
 * with `displayedToUser`, to the PDF's own user space.
 */
import type { Grid, Plan, Rotation, Slot } from '../engine';
import { MM, type Rect } from './geometry';

export interface ImposedOptions {
  /** How sheet sides follow each other in the PDF. */
  order: 'duplex' | 'fronts-then-backs' | 'simplex';
  /** Backs are rotated 180° relative to a left ↔ right turn (printed for a top ↔ bottom flip). */
  backRotated: boolean;
  /** Use the PDF's TrimBox as the imposed area when it has one (else the whole page). */
  useTrimBox: boolean;
  /** Extra inset from that area, mm (to skip a margin with marks). */
  inset: { top: number; right: number; bottom: number; left: number };
}

export const DEFAULT_IMPOSED: ImposedOptions = {
  order: 'duplex',
  backRotated: false,
  useTrimBox: true,
  inset: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** Page info read from the PDF: /Rotate and boxes in unrotated user space (points, y up). */
export interface PdfPageInfo {
  rotate: number;
  crop: Rect;
  trim: Rect;
  /** True when the PDF really defines a TrimBox (not just the fallback to the crop box). */
  hasTrim: boolean;
  /** The page's /UserUnit: size of one user-space unit in points (usually 1). */
  unit: number;
}

export interface SideMap {
  sheetCount: number;
  /** PDF page index (0-based) for a sheet side, or null if the PDF has none. */
  pageOf(sheet: number, side: 'front' | 'back'): number | null;
}

export function sideMap(pdfPages: number, order: ImposedOptions['order']): SideMap {
  if (order === 'simplex') {
    return { sheetCount: pdfPages, pageOf: (s, side) => (side === 'front' ? s : null) };
  }
  const sheetCount = Math.ceil(pdfPages / 2);
  const pageOf =
    order === 'duplex'
      ? (s: number, side: 'front' | 'back') => s * 2 + (side === 'front' ? 0 : 1)
      : (s: number, side: 'front' | 'back') => (side === 'front' ? s : sheetCount + s);
  return {
    sheetCount,
    pageOf: (s, side) => {
      const i = pageOf(s, side);
      return i < pdfPages ? i : null;
    },
  };
}

/** Normalised clockwise quarter turns of a /Rotate value. */
const quarters = (rotate: number) => ((Math.round(rotate / 90) % 4) + 4) % 4;

/** Physical size in points of a user-space box as shown on its page (/Rotate and /UserUnit). */
export function physicalSize(page: { rotate: number; unit: number }, box: Rect) {
  const s = displayedSize(box, page.rotate);
  return { w: s.w * page.unit, h: s.h * page.unit };
}

/** Displayed size of a box on a page with this /Rotate. */
export function displayedSize(box: Rect, rotate: number) {
  return quarters(rotate) % 2 ? { w: box.h, h: box.w } : { w: box.w, h: box.h };
}

/**
 * Unrotated user-space point → displayed fraction of `crop` (0..1, y down). A /Rotate turns the
 * page clockwise for display.
 */
export function userToDisplayed(
  crop: Rect,
  rotate: number,
  x: number,
  y: number,
): [number, number] {
  const u = (x - crop.x) / crop.w;
  const v = (y - crop.y) / crop.h;
  switch (quarters(rotate)) {
    case 1:
      return [v, u];
    case 2:
      return [1 - u, v];
    case 3:
      return [1 - v, 1 - u];
    default:
      return [u, 1 - v];
  }
}

/** Displayed fraction (0..1, y down) → unrotated user-space point. */
export function displayedToUser(
  crop: Rect,
  rotate: number,
  fx: number,
  fy: number,
): [number, number] {
  let u: number;
  let v: number;
  switch (quarters(rotate)) {
    case 1:
      [u, v] = [fy, fx];
      break;
    case 2:
      [u, v] = [1 - fx, fy];
      break;
    case 3:
      [u, v] = [1 - fy, 1 - fx];
      break;
    default:
      [u, v] = [fx, 1 - fy];
  }
  return [crop.x + u * crop.w, crop.y + v * crop.h];
}

/** A user-space box as a displayed-fraction rectangle (x, y = top-left, y down). */
export function boxToDisplayed(crop: Rect, rotate: number, box: Rect): Rect {
  const a = userToDisplayed(crop, rotate, box.x, box.y);
  const b = userToDisplayed(crop, rotate, box.x + box.w, box.y + box.h);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** A displayed-fraction rectangle as a user-space box. */
export function displayedToBox(crop: Rect, rotate: number, r: Rect): Rect {
  const a = displayedToUser(crop, rotate, r.x, r.y);
  const b = displayedToUser(crop, rotate, r.x + r.w, r.y + r.h);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** The imposed area of a sheet page, as a displayed fraction rectangle. */
export function imposedArea(page: PdfPageInfo, o: ImposedOptions): Rect {
  const base =
    o.useTrimBox && page.hasTrim
      ? boxToDisplayed(page.crop, page.rotate, page.trim)
      : { x: 0, y: 0, w: 1, h: 1 };
  const size = physicalSize(page, page.crop);
  const l = (o.inset.left * MM) / size.w;
  const r = (o.inset.right * MM) / size.w;
  const t = (o.inset.top * MM) / size.h;
  const b = (o.inset.bottom * MM) / size.h;
  return {
    x: base.x + l,
    y: base.y + t,
    w: Math.max(0.01, base.w - l - r),
    h: Math.max(0.01, base.h - t - b),
  };
}

export interface PanelRegion {
  /** Displayed fraction rectangle on the sheet page. */
  rect: Rect;
  /**
   * Turn (clockwise) that brings the region into the side's view (our back view is a left ↔ right
   * turn; a back printed for a top ↔ bottom flip is upside down relative to it).
   */
  turn: Rotation;
}

/** Where panel (col, row) of a side's view is on its PDF page. */
export function panelRegion(
  area: Rect,
  grid: Grid,
  col: number,
  row: number,
  side: 'front' | 'back',
  o: ImposedOptions,
): PanelRegion {
  const flip = side === 'back' && o.backRotated;
  const c = flip ? grid.cols - 1 - col : col;
  const r = flip ? grid.rows - 1 - row : row;
  const w = area.w / grid.cols;
  const h = area.h / grid.rows;
  return { rect: { x: area.x + c * w, y: area.y + r * h, w, h }, turn: flip ? 180 : 0 };
}

/** Reading position → the slot it occupies (with its sheet and side). */
export function slotsByPosition(plan: Plan) {
  const map = new Map<number, { sheet: number; side: 'front' | 'back'; slot: Slot }>();
  plan.sheets.forEach((s, sheet) => {
    for (const side of ['front', 'back'] as const) {
      for (const slot of s[side]) map.set(slot.position, { sheet, side, slot });
    }
  });
  return map;
}
