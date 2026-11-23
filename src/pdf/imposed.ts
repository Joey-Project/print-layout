/**
 * Reading an already-imposed (print-ready) PDF back: which PDF page is which sheet side, and where
 * each panel sits on it. Pure geometry; rendering and PDF writing build on it.
 *
 * Regions are in *displayed* page coordinates as fractions (0..1, y down) — the page as a viewer
 * shows it, after its /Rotate — so they apply equally to a rendered canvas and, converted back
 * with `displayedToUser`, to the PDF's own user space.
 */
import {
  NO_GANG,
  paperPlan,
  type Gang,
  type Grid,
  type PaperPlan,
  type Plan,
  type Rotation,
  type Sections,
  type Slot,
} from '../engine';
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
  /** The printed sheets come in reverse order in the PDF (last sheet first). */
  reversed?: boolean;
  /** Several recipe sheets per printed sheet, cut apart (cut and stack, or copies). */
  gang?: Gang;
  /** Cutting gap between those parts, mm. */
  gutter?: number;
  /** Bleed around each part, mm: as exported, parts are 2 × bleed + the cutting gap apart. */
  bleed?: number;
  /**
   * Pages in the book, when the last printed sheets have empty positions (the PDF alone cannot tell
   * an empty position from a blank sheet). Unset: every position holds a sheet.
   */
  pages?: number;
  /**
   * Where each recipe sheet is in the PDF: recipe sheet i is read from part `sheetOrder[i]`, parts
   * counted in the PDF's own order (with several per sheet, each cut-apart part is one). Unset or
   * partial: the rest in order.
   */
  sheetOrder?: number[];
  /** The printed sheet is divided into equal sections, one page each (blank ones cut off). */
  sections?: Sections | null;
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

/** Where a panel of a recipe sheet is in an imposed PDF. */
export interface ProofRegion {
  /** PDF page (0-based). */
  index: number;
  /** Displayed fraction rectangle on that page. */
  rect: Rect;
  /** Turn (clockwise) bringing it into the side's view. */
  turn: Rotation;
}

/**
 * `order` as a permutation of 0 … n−1: valid entries in their order (repeats dropped), then the
 * missing ones ascending.
 */
export function sheetPermutation(order: readonly number[] | undefined, n: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of order ?? []) {
    if (Number.isInteger(v) && v >= 0 && v < n && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
  return out;
}

/** The order after moving the sheet at `from` to `to` (the others close up). */
export function moveSheet(
  order: readonly number[] | undefined,
  n: number,
  from: number,
  to: number,
): number[] {
  const out = sheetPermutation(order, n);
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved!);
  return out;
}

/** Whether `order` is the PDF's own order (nothing moved). */
export function inPdfOrder(order: readonly number[] | undefined, n: number) {
  return sheetPermutation(order, n).every((v, i) => v === i);
}

export interface ProofLayout {
  paper: PaperPlan;
  /** Printed sheets the PDF holds. */
  printed: number;
  /** Recipe sheets those make (what the plan should be built for). */
  sheets: number;
  region(sheet: number, side: 'front' | 'back', col: number, row: number): ProofRegion | null;
  /** Where recipe sheet `sheet` is read from: its part, the printed sheet and the position on it. */
  sourceOf(sheet: number): { part: number; printed: number; unit: number };
}

/** Recipe sheets an imposed PDF of `pdfPages` pages holds, for these options. */
export function proofSheetCount(pdfPages: number, grid: Grid, o: ImposedOptions) {
  return proofSheetRange(pdfPages, grid, o).max;
}

/**
 * Recipe sheets an imposed PDF can hold: every position filled (max), down to only the first
 * position of the last printed sheet (min, cut and stack). Any count in between fills the same
 * printed sheets, so the PDF maps the same way.
 */
export function proofSheetRange(pdfPages: number, grid: Grid, o: ImposedOptions) {
  const printed = sideMap(pdfPages, o.order).sheetCount;
  const units = paperPlan(1, grid, o.gang ?? NO_GANG, o.sections ?? null).gang.units;
  if ((o.gang ?? NO_GANG).order === 'copies' || printed === 0)
    return { min: printed, max: printed };
  return { min: (printed - 1) * units + 1, max: printed * units };
}

/**
 * How an imposed PDF maps back onto the plan: which printed sheet (PDF page) holds each recipe
 * sheet, where its part sits on that page (several per sheet, or sections), and where each panel
 * is in it. Mirrors the export's layout: a part's back is its front mirrored about the page's
 * centre, and a back printed for a top ↔ bottom flip is turned 180° on the page.
 */
export function proofLayout(info: PdfPageInfo[], plan: Plan, o: ImposedOptions): ProofLayout {
  const { cols, rows } = plan.grid;
  const paper = paperPlan(plan.sheets.length, plan.grid, o.gang ?? NO_GANG, o.sections ?? null);
  const sides = sideMap(info.length, o.order);
  const { across, down } = paper.gang.gang;
  const order = sheetPermutation(o.sheetOrder, plan.sheets.length);
  function sourceOf(sheet: number) {
    const part = order[sheet] ?? sheet;
    const at = paper.gang.placeOf(part);
    return {
      part,
      printed: o.reversed ? sides.sheetCount - 1 - at.paper : at.paper,
      unit: at.row * across + at.col,
    };
  }
  return {
    paper,
    printed: sides.sheetCount,
    sheets: proofSheetCount(info.length, plan.grid, o),
    sourceOf,
    region(sheet, side, col, row) {
      const at = paper.gang.placeOf(order[sheet] ?? sheet);
      const printedSheet = o.reversed ? sides.sheetCount - 1 - at.paper : at.paper;
      if (printedSheet < 0) return null;
      const index = sides.pageOf(printedSheet, side);
      if (index === null) return null;
      const page = info[index]!;
      // The imposed area on this page (sections run to the page's edges), and the part's rectangle
      // in it as seen from this side (displayed fractions).
      const area: Rect = paper.sectioned ? { x: 0, y: 0, w: 1, h: 1 } : imposedArea(page, o);
      // A back is the front turned over left ↔ right, so its parts run in mirrored columns.
      const ucol = side === 'back' ? across - 1 - at.col : at.col;
      let unit: Rect;
      if (paper.sectioned) {
        const p = paper.paper;
        const cell = p.unitCell(at.col, at.row);
        const x = cell.col / p.across;
        const w = cols / p.across;
        unit = {
          x: side === 'back' ? 1 - x - w : x,
          y: cell.row / p.down,
          w,
          h: rows / p.down,
        };
      } else {
        const size = physicalSize(page, page.crop);
        const space = (2 * Math.max(0, o.bleed ?? 0) + Math.max(0, o.gutter ?? 0)) * MM;
        const gx = space / size.w;
        const gy = space / size.h;
        const uw = (area.w - (across - 1) * gx) / across;
        const uh = (area.h - (down - 1) * gy) / down;
        unit = { x: area.x + ucol * (uw + gx), y: area.y + at.row * (uh + gy), w: uw, h: uh };
      }
      const pw = unit.w / cols;
      const ph = unit.h / rows;
      const rect = { x: unit.x + col * pw, y: unit.y + row * ph, w: pw, h: ph };
      if (side === 'back' && o.backRotated) {
        // Printed upside down: turned 180° within the imposed area.
        return {
          index,
          rect: {
            x: 2 * area.x + area.w - rect.x - rect.w,
            y: 2 * area.y + area.h - rect.y - rect.h,
            w: rect.w,
            h: rect.h,
          },
          turn: 180,
        };
      }
      return { index, rect, turn: 0 };
    },
  };
}
