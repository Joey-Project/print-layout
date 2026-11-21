/**
 * Print geometry, pure and unit-tested: where each panel of an imposed sheet goes on the output
 * sheet (PDF points, y up), crop and fold marks, and how to place a source page (with its own
 * /Rotate and trim box) into a panel. The PDF writer and the imposed-PDF reader only draw what
 * these functions compute.
 */
import {
  NO_GANG,
  paperPlan,
  type Gang,
  type GangPlan,
  type Grid,
  type PaperPlan,
  type Plan,
  type Rotation,
  type Sections,
  type Slot,
} from '../engine';

/** PDF points per millimetre. */
export const MM = 72 / 25.4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetSize {
  id: string;
  label: string;
  /** Portrait width × height in mm. */
  w: number;
  h: number;
}

export const SHEET_SIZES: SheetSize[] = [
  { id: 'a5', label: 'A5', w: 148, h: 210 },
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'a3', label: 'A3', w: 297, h: 420 },
  { id: 'sra3', label: 'SRA3', w: 320, h: 450 },
  { id: 'sra4', label: 'SRA4', w: 225, h: 320 },
  { id: 'letter', label: 'US Letter', w: 215.9, h: 279.4 },
  { id: 'legal', label: 'US Legal', w: 215.9, h: 355.6 },
  { id: 'tabloid', label: 'Tabloid (11×17 in)', w: 279.4, h: 431.8 },
];

/** Page sizes for the placeholder dummy (no PDF loaded). */
export const PAGE_SIZES: SheetSize[] = [
  { id: 'a6', label: 'A6', w: 105, h: 148 },
  { id: 'a5', label: 'A5', w: 148, h: 210 },
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'half-letter', label: 'Half Letter', w: 139.7, h: 215.9 },
  { id: 'letter', label: 'US Letter', w: 215.9, h: 279.4 },
  { id: 'square-150', label: 'Square 150 mm', w: 150, h: 150 },
];

export type SheetChoice =
  { kind: 'preset'; id: string } | { kind: 'fit' } | { kind: 'custom'; w: number; h: number };

export interface PrintOptions {
  sheet: SheetChoice;
  orientation: 'auto' | 'portrait' | 'landscape';
  /** 'fit' scales the imposition to the printable area; 'actual' keeps 100 %. */
  scaling: 'fit' | 'actual';
  /** Unprintable margin on each side of a preset/custom sheet, mm. */
  margin: number;
  /** Bleed past the trim on the sheet's outer edges, mm (0 = none). */
  bleed: number;
  cropMarks: boolean;
  foldMarks: boolean;
  /** Small sheet/side label outside the trim. */
  slug: boolean;
  /** 'duplex': one PDF, front then back of each sheet. 'split': two PDFs (fronts, backs). */
  sides: 'duplex' | 'split';
  /**
   * How the printer turns the sheet over between sides. 'auto' turns it like a book page (left ↔
   * right), which needs no rotation; the UI tells the user which printer setting that is.
   */
  flip: 'auto' | 'short' | 'long';
  /** For 'split': print the backs in reverse order (for re-feeding a face-down stack). */
  reverseBacks: boolean;
  /** Several recipe sheets per printed sheet, cut apart after printing (default: one). */
  gang?: Gang;
  /** Extra gap between ganged units for the cut, mm (on top of their bleed). */
  gutter?: number;
  /**
   * Divide the sheet into equal sections, one page each; spreads fill whole sections and leftover
   * sections are printed blank, to be cut off (preset or custom sheets only). Replaces `gang`'s
   * across/down; its order still applies.
   */
  sections?: Sections | null;
}

export type PrintPreset = 'home' | 'manual' | 'shop';

export const PRINT_PRESETS: Record<
  PrintPreset,
  { label: string; hint: string; options: PrintOptions }
> = {
  home: {
    label: 'Home / office duplex printer',
    hint: 'One PDF, both sides. Scaled to fit the paper inside the printer margins.',
    options: {
      sheet: { kind: 'preset', id: 'a4' },
      orientation: 'auto',
      scaling: 'fit',
      margin: 5,
      bleed: 0,
      cropMarks: false,
      foldMarks: false,
      slug: false,
      sides: 'duplex',
      flip: 'auto',
      reverseBacks: false,
    },
  },
  manual: {
    label: 'Single-sided printer (manual duplex)',
    hint: 'Two PDFs: print the fronts, put the stack back in, print the backs.',
    options: {
      sheet: { kind: 'preset', id: 'a4' },
      orientation: 'auto',
      scaling: 'fit',
      margin: 5,
      bleed: 0,
      cropMarks: false,
      foldMarks: false,
      slug: false,
      sides: 'split',
      flip: 'auto',
      reverseBacks: true,
    },
  },
  shop: {
    label: 'Print shop',
    hint: 'Exact size at 100 %, 3 mm bleed, crop and fold marks, trim and bleed boxes set.',
    options: {
      sheet: { kind: 'fit' },
      orientation: 'auto',
      scaling: 'actual',
      margin: 0,
      bleed: 3,
      cropMarks: true,
      foldMarks: true,
      slug: true,
      sides: 'duplex',
      flip: 'auto',
      reverseBacks: false,
    },
  },
};

/** Distance of crop/fold marks from the trim, their length, and the room the slug needs. */
const MARK_OFFSET = 3 * MM;
const MARK_LENGTH = 5 * MM;
const SLUG_ROOM = 5 * MM;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One panel on an output sheet side, ready to draw. */
export interface PlacedSlot {
  slot: Slot;
  /** The recipe sheet this slot belongs to (several per printed sheet when ganged). */
  sheet: number;
  /** Panel rectangle on the output page (points, y up). */
  rect: Rect;
  /** Rotation of the page in this panel as printed (includes a rotated back side). */
  rotation: Rotation;
  /** Which panel edges are outer sheet edges (bleed goes there) — in output page orientation. */
  outer: { top: boolean; right: boolean; bottom: boolean; left: boolean };
}

export interface SheetLayout {
  /** Output page size, points. */
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  /** Imposition scale (1 = 100 %). */
  scale: number;
  /** Envelope of all units' trims, and of their bleeds. */
  trim: Rect;
  bleed: Rect;
  /** Printed sheets and which recipe sheet each unit holds. */
  gang: GangPlan;
  /** How the printed sheet is divided (units, blank sections). */
  paper: PaperPlan;
  /** Each unit's trim rectangle on the front, indexed [row][col] (front view). */
  units: Rect[][];
  /** Blank sections on the front, cut off after printing. */
  blanks: Rect[];
  /** Crop and fold marks for one side (an off-centre layout's cut lines mirror on the back). */
  marks(side: 'front' | 'back'): { crop: Segment[]; fold: Segment[] };
  /** Whether back sides are rotated 180° in the PDF (printer turns top ↔ bottom). */
  backRotated: boolean;
  /** Printer setting that matches: flip on the short or long edge. */
  printerFlip: 'short' | 'long';
  cropMarks: Segment[];
  foldMarks: Segment[];
  /** Where to put the slug label (baseline start), if enabled. */
  slugAt: { x: number; y: number } | null;
  warnings: string[];
  /** Panels on one side of printed sheet `paper` (all its units). */
  place(paper: number, side: 'front' | 'back'): PlacedSlot[];
}

/**
 * Lay the plan out on printed sheets. `page` is the finished (trimmed) page size in points. With a
 * gang, each printed sheet carries `across × down` units (recipe sheets) separated by their bleed
 * and the gutter; everything stays centred, so every unit's back lands behind its front.
 */
export function layoutSheets(
  plan: Plan,
  page: { w: number; h: number },
  o: PrintOptions,
): SheetLayout {
  const { cols, rows } = plan.grid;
  const sections = o.sheet.kind === 'fit' ? null : (o.sections ?? null);
  const paper = paperPlan(plan.sheets.length, plan.grid, o.gang ?? NO_GANG, sections);
  if (paper.sectioned) return layoutSections(plan, page, o, paper);
  const gang = paper.gang;
  const { across, down } = gang.gang;
  const unitW = cols * page.w;
  const unitH = rows * page.h;
  const bleed = Math.max(0, o.bleed) * MM;
  // Between units: each unit's own bleed, plus room to cut.
  const gap = across * down > 1 ? 2 * bleed + Math.max(0, o.gutter ?? 0) * MM : 0;
  const gangW = (s: number) => across * unitW * s + (across - 1) * gap;
  const gangH = (s: number) => down * unitH * s + (down - 1) * gap;
  const marks = o.cropMarks || o.foldMarks;
  // Room needed around the trim, beyond which nothing is drawn. It is the same on every side, so
  // the imposition stays centred on the sheet: a back turned top ↔ bottom then lands exactly
  // behind its front. (A label without marks gets its room on all sides rather than shifting the
  // imposition, which would misregister the backs.)
  const reserve = Math.max(
    bleed,
    marks ? Math.max(MARK_OFFSET, bleed) + MARK_LENGTH : 0,
    o.slug && !marks ? bleed + SLUG_ROOM : 0,
  );
  const warnings: string[] = [];

  let width: number;
  let height: number;
  let scale: number;
  if (o.sheet.kind === 'fit') {
    scale = 1;
    width = gangW(1) + 2 * reserve;
    height = gangH(1) + 2 * reserve;
  } else {
    let size: { w: number; h: number };
    if (o.sheet.kind === 'custom') size = { w: o.sheet.w * MM, h: o.sheet.h * MM };
    else {
      const id = o.sheet.id;
      const preset = SHEET_SIZES.find((s) => s.id === id) ?? SHEET_SIZES[1]!;
      size = { w: preset.w * MM, h: preset.h * MM };
    }
    const short = Math.min(size.w, size.h);
    const long = Math.max(size.w, size.h);
    const margin = Math.max(0, o.margin) * MM;
    // Bleed, marks and labels must print too, so they go inside the printer's margin; the gaps
    // between units do not scale.
    const fitScale = (w: number, h: number) =>
      Math.min(
        (w - 2 * (margin + reserve) - (across - 1) * gap) / (across * unitW),
        (h - 2 * (margin + reserve) - (down - 1) * gap) / (down * unitH),
      );
    let landscape: boolean;
    if (o.orientation === 'auto') landscape = fitScale(long, short) > fitScale(short, long);
    else landscape = o.orientation === 'landscape';
    width = landscape ? long : short;
    height = landscape ? short : long;
    const fit = fitScale(width, height);
    if (o.scaling === 'fit') scale = fit;
    else {
      scale = 1;
      if (fit < 1 - 1e-6) {
        warnings.push(
          `At 100 % the imposition (${fmtMm(gangW(1))} × ${fmtMm(gangH(1))} mm) does not fit the sheet with its margins and marks; it will be cut off.`,
        );
      }
    }
  }
  if (scale <= 0) {
    scale = 0.01;
    warnings.push('The sheet is too small for the margins and marks.');
  }
  if (o.scaling === 'fit' && o.sheet.kind !== 'fit' && Math.abs(scale - 1) > 0.005) {
    warnings.push(`Pages are scaled to ${Math.round(scale * 1000) / 10} % to fit the sheet.`);
  }

  const tw = gangW(scale);
  const th = gangH(scale);
  const trim: Rect = { x: (width - tw) / 2, y: (height - th) / 2, w: tw, h: th };
  const bleedRect: Rect = {
    x: trim.x - bleed,
    y: trim.y - bleed,
    w: tw + 2 * bleed,
    h: th + 2 * bleed,
  };
  const uw = unitW * scale;
  const uh = unitH * scale;
  const units: Rect[][] = Array.from({ length: down }, (_, r) =>
    Array.from({ length: across }, (_, c) => ({
      x: trim.x + c * (uw + gap),
      y: trim.y + th - r * (uh + gap) - uh,
      w: uw,
      h: uh,
    })),
  );
  const orientation = width > height ? 'landscape' : 'portrait';

  // Turning the sheet left ↔ right is our back view (no rotation). On a landscape sheet that is a
  // flip on the short edge, on a portrait sheet a flip on the long edge.
  const natural: 'short' | 'long' = orientation === 'landscape' ? 'short' : 'long';
  const printerFlip = o.flip === 'auto' ? natural : o.flip;
  const backRotated = printerFlip !== natural;

  // Marks sit outside the ganged area, at every cut line and every fold line.
  const off = Math.max(MARK_OFFSET, bleed);
  const top = trim.y + th;
  const right = trim.x + tw;
  const vertical = (x: number, into: Segment[]) => {
    into.push({ x1: x, y1: top + off, x2: x, y2: top + off + MARK_LENGTH });
    into.push({ x1: x, y1: trim.y - off, x2: x, y2: trim.y - off - MARK_LENGTH });
  };
  const horizontal = (y: number, into: Segment[]) => {
    into.push({ x1: trim.x - off, y1: y, x2: trim.x - off - MARK_LENGTH, y2: y });
    into.push({ x1: right + off, y1: y, x2: right + off + MARK_LENGTH, y2: y });
  };
  const cutXs = units[0]!.flatMap((u) => [u.x, u.x + u.w]);
  const cutYs = units.map((r) => r[0]!).flatMap((u) => [u.y, u.y + u.h]);
  const cropMarks: Segment[] = [];
  if (o.cropMarks) {
    for (const x of dedupe(cutXs)) vertical(x, cropMarks);
    for (const y of dedupe(cutYs)) horizontal(y, cropMarks);
  }
  const foldMarks: Segment[] = [];
  if (o.foldMarks) {
    for (const u of units[0]!)
      for (let c = 1; c < cols; c++) vertical(u.x + c * page.w * scale, foldMarks);
    for (const u of units.map((r) => r[0]!)) {
      for (let r = 1; r < rows; r++) horizontal(u.y + u.h - r * page.h * scale, foldMarks);
    }
  }
  const slugAt = o.slug
    ? {
        x: trim.x + (marks ? off + MARK_LENGTH + 2 * MM : 0),
        y: Math.max(2 * MM, trim.y - (marks ? off + 2.2 * MM : bleed + 3.5 * MM)),
      }
    : null;

  return {
    width,
    height,
    orientation,
    scale,
    trim,
    bleed: bleedRect,
    gang,
    paper,
    units,
    blanks: [],
    backRotated,
    printerFlip,
    cropMarks,
    foldMarks,
    marks: sideMarks(cropMarks, foldMarks, width, height, backRotated),
    slugAt,
    warnings,
    place: placer(plan, gang, units, width, height, backRotated),
  };
}

/**
 * Panels on one side of a printed sheet. A unit's back is its front rectangle mirrored about the
 * sheet's centre (the sheet turns left ↔ right), so it lands exactly behind its front however the
 * units are arranged; for a top ↔ bottom flip the whole back is then turned 180°.
 */
function placer(
  plan: Plan,
  gang: GangPlan,
  units: Rect[][],
  width: number,
  height: number,
  backRotated: boolean,
) {
  const { cols, rows } = plan.grid;
  return (paper: number, side: 'front' | 'back'): PlacedSlot[] => {
    const out: PlacedSlot[] = [];
    const turn = side === 'back' && backRotated;
    units.forEach((row, ur) =>
      row.forEach((front, uc) => {
        const sheet = gang.sheetAt(paper, uc, ur);
        if (sheet === null) return;
        const unit = side === 'back' ? { ...front, x: width - front.x - front.w } : front;
        const pw = unit.w / cols;
        const ph = unit.h / rows;
        for (const slot of plan.sheets[sheet]?.[side] ?? []) {
          let rect: Rect = {
            x: unit.x + slot.col * pw,
            y: unit.y + (rows - 1 - slot.row) * ph,
            w: pw,
            h: ph,
          };
          let rotation = slot.rotation;
          let outer = {
            top: slot.row === 0,
            bottom: slot.row === rows - 1,
            left: slot.col === 0,
            right: slot.col === cols - 1,
          };
          if (turn) {
            // A back printed for a top ↔ bottom flip is the back view turned 180° on the page.
            rect = {
              x: width - rect.x - rect.w,
              y: height - rect.y - rect.h,
              w: rect.w,
              h: rect.h,
            };
            rotation = ((rotation + 180) % 360) as Rotation;
            outer = { top: outer.bottom, bottom: outer.top, left: outer.right, right: outer.left };
          }
          out.push({ slot, sheet, rect, rotation, outer });
        }
      }),
    );
    return out;
  };
}

/** Marks for each side: the front's, mirrored (and turned, for a top ↔ bottom flip) on the back. */
function sideMarks(
  crop: Segment[],
  fold: Segment[],
  width: number,
  height: number,
  backRotated: boolean,
) {
  const mirror = (m: Segment): Segment =>
    backRotated
      ? { x1: m.x1, y1: height - m.y1, x2: m.x2, y2: height - m.y2 }
      : { x1: width - m.x1, y1: m.y1, x2: width - m.x2, y2: m.y2 };
  const back = { crop: crop.map(mirror), fold: fold.map(mirror) };
  return (side: 'front' | 'back') => (side === 'front' ? { crop, fold } : back);
}

const CUT_GUIDE = 4 * MM;

/** Page (section) size for a sheet divided into sections, or null when it is not. */
export function sectionPageSize(o: PrintOptions): { w: number; h: number } | null {
  if (o.sheet.kind === 'fit' || !o.sections) return null;
  const { width, height } = sheetSize(o, o.sections);
  return { w: width / Math.max(1, o.sections.across), h: height / Math.max(1, o.sections.down) };
}

/** Sheet size and orientation for a sectioned sheet: 'auto' turns it so sections are longest. */
function sheetSize(o: PrintOptions, sections: Sections) {
  let size: { w: number; h: number };
  if (o.sheet.kind === 'custom') size = { w: o.sheet.w * MM, h: o.sheet.h * MM };
  else {
    const id = o.sheet.kind === 'preset' ? o.sheet.id : 'a4';
    const preset = SHEET_SIZES.find((s) => s.id === id) ?? SHEET_SIZES[1]!;
    size = { w: preset.w * MM, h: preset.h * MM };
  }
  const short = Math.min(size.w, size.h);
  const long = Math.max(size.w, size.h);
  const landscape =
    o.orientation === 'auto' ? sections.across > sections.down : o.orientation === 'landscape';
  return { width: landscape ? long : short, height: landscape ? short : long };
}

/**
 * A sheet divided into equal sections, one page each. Spreads fill whole sections (edge to edge, no
 * bleed or gaps: the cuts are the section lines) and leftover sections stay blank. Cut guides are
 * short ticks at the sheet's edges on every cut line, inside the printer margin.
 */
function layoutSections(
  plan: Plan,
  page: { w: number; h: number },
  o: PrintOptions,
  paper: PaperPlan,
): SheetLayout {
  const { cols, rows } = plan.grid;
  const p = paper.paper;
  const { width, height } = sheetSize(o, { across: p.across, down: p.down, blank: 'end' });
  const cw = width / p.across;
  const ch = height / p.down;
  const cellRect = (col: number, row: number, w: number, h: number): Rect => ({
    x: col * cw,
    y: height - (row + h) * ch,
    w: w * cw,
    h: h * ch,
  });
  const { across, down } = paper.gang.gang;
  const units = Array.from({ length: down }, (_, ur) =>
    Array.from({ length: across }, (_, uc) => {
      const c = p.unitCell(uc, ur);
      return cellRect(c.col, c.row, cols, rows);
    }),
  );
  const blanks = p.blanks.map((b) => cellRect(b.col, b.row, b.w, b.h));
  const all = units.flat();
  const x0 = Math.min(...all.map((u) => u.x));
  const y0 = Math.min(...all.map((u) => u.y));
  const trim: Rect = {
    x: x0,
    y: y0,
    w: Math.max(...all.map((u) => u.x + u.w)) - x0,
    h: Math.max(...all.map((u) => u.y + u.h)) - y0,
  };
  const scale = Math.min(cw / page.w, ch / page.h);
  const orientation = width > height ? 'landscape' : 'portrait';
  const natural: 'short' | 'long' = orientation === 'landscape' ? 'short' : 'long';
  const printerFlip = o.flip === 'auto' ? natural : o.flip;
  const backRotated = printerFlip !== natural;

  const warnings: string[] = [];
  if (Math.abs(scale - 1) > 0.005) {
    warnings.push(
      `Pages (${fmtMm(page.w)} × ${fmtMm(page.h)} mm) are fitted to the ${fmtMm(cw)} × ${fmtMm(ch)} mm sections at ${Math.round(scale * 1000) / 10} %.`,
    );
  }
  if (o.bleed > 0)
    warnings.push('Bleed is not used on a sheet divided into sections: pages meet at the cuts.');
  if (o.margin > 0) {
    warnings.push(
      `Pages run to the edge of the sheet; keep artwork clear of the ${o.margin} mm the printer cannot print.`,
    );
  }

  // Cut guides: ticks at the sheet edges on every inner cut line; fold guides likewise, dashed.
  const inset = Math.max(0, o.margin) * MM;
  const tickV = (x: number, into: Segment[]) => {
    into.push({ x1: x, y1: height - inset, x2: x, y2: height - inset - CUT_GUIDE });
    into.push({ x1: x, y1: inset, x2: x, y2: inset + CUT_GUIDE });
  };
  const tickH = (y: number, into: Segment[]) => {
    into.push({ x1: inset, y1: y, x2: inset + CUT_GUIDE, y2: y });
    into.push({ x1: width - inset, y1: y, x2: width - inset - CUT_GUIDE, y2: y });
  };
  const inner = (v: number, max: number) => v > 1e-6 && v < max - 1e-6;
  const pieces = [...all, ...blanks];
  const cropMarks: Segment[] = [];
  if (o.cropMarks) {
    for (const x of dedupe(pieces.flatMap((r) => [r.x, r.x + r.w])).filter((x) => inner(x, width)))
      tickV(x, cropMarks);
    for (const y of dedupe(pieces.flatMap((r) => [r.y, r.y + r.h])).filter((y) => inner(y, height)))
      tickH(y, cropMarks);
  }
  const foldMarks: Segment[] = [];
  if (o.foldMarks) {
    for (const u of all) {
      for (let c = 1; c < cols; c++) tickV(u.x + (c * u.w) / cols, foldMarks);
      for (let r = 1; r < rows; r++) tickH(u.y + u.h - (r * u.h) / rows, foldMarks);
    }
  }

  return {
    width,
    height,
    orientation,
    scale,
    trim,
    bleed: trim,
    gang: paper.gang,
    paper,
    units,
    blanks,
    backRotated,
    printerFlip,
    cropMarks,
    foldMarks,
    marks: sideMarks(cropMarks, foldMarks, width, height, backRotated),
    slugAt: null,
    warnings,
    place: placer(plan, paper.gang, units, width, height, backRotated),
  };
}

/** Unique values (cut lines shared by touching units appear once). */
function dedupe(xs: number[]) {
  const out: number[] = [];
  for (const x of xs) if (!out.some((y) => Math.abs(y - x) < 1e-6)) out.push(x);
  return out;
}

const fmtMm = (pt: number) => Math.round((pt / MM) * 10) / 10;

/** A source PDF page: its /Rotate and trim box in unrotated user space. */
export interface SourcePage {
  rotate: number;
  trim: Rect;
}

export interface Placement {
  /** Region of the source page to embed (unrotated user space); it clips. */
  box: { left: number; bottom: number; right: number; top: number };
  /** drawPage parameters: anchor, uniform scale, counter-clockwise rotation in degrees. */
  x: number;
  y: number;
  scale: number;
  rotateCcw: number;
}

const EDGES = ['top', 'right', 'bottom', 'left'] as const;
type Edge = (typeof EDGES)[number];

/**
 * Place a source page into `rect`, turned `rotation` degrees (clockwise, as seen) on top of its own
 * /Rotate, scaled to fit and centred. Outer edges get `bleed` points of the page beyond its trim.
 */
export function placePage(
  page: SourcePage,
  rect: Rect,
  rotation: number,
  outer: Record<Edge, boolean>,
  bleed: number,
): Placement {
  const total = (((page.rotate + rotation) % 360) + 360) % 360; // clockwise, as displayed
  const quarter = Math.round(total / 90) % 4;
  const sideways = quarter % 2 === 1;
  const dispW = sideways ? page.trim.h : page.trim.w;
  const dispH = sideways ? page.trim.w : page.trim.h;
  const k = Math.min(rect.w / dispW, rect.h / dispH);
  // Bleed in source units, mapped from the panel's edges to the page's unrotated edges. Content
  // turned clockwise by `quarter` puts source edge i at displayed edge i + quarter.
  const extra: Record<Edge, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  EDGES.forEach((edge, v) => {
    if (outer[edge]) extra[EDGES[(v - quarter + 4) % 4]!] = bleed / k;
  });
  const t = page.trim;
  const box = {
    left: t.x - extra.left,
    bottom: t.y - extra.bottom,
    right: t.x + t.w + extra.right,
    top: t.y + t.h + extra.top,
  };
  // Map source point p to C + k·Rcw(total)·(p − trimCentre); drawPage applies
  // anchor + Rccw(rotate)·k·(p − boxBottomLeft), so anchor = C + k·Rcw(total)·(boxBL − trimCentre).
  const theta = (quarter * Math.PI) / 2;
  const cos = Math.round(Math.cos(theta));
  const sin = Math.round(Math.sin(theta));
  const dx = box.left - (t.x + t.w / 2);
  const dy = box.bottom - (t.y + t.h / 2);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    box,
    x: cx + k * (dx * cos + dy * sin),
    y: cy + k * (-dx * sin + dy * cos),
    scale: k,
    rotateCcw: (360 - quarter * 90) % 360,
  };
}

/** Apply a placement to a source point (unrotated user space) → output page point. */
export function placedPoint(p: Placement, sx: number, sy: number): [number, number] {
  const a = (p.rotateCcw * Math.PI) / 180;
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  const ux = (sx - p.box.left) * p.scale;
  const uy = (sy - p.box.bottom) * p.scale;
  return [p.x + ux * c - uy * s, p.y + ux * s + uy * c];
}

/**
 * The smallest panel of shape `aspect` (height / width) that holds a `w` × `h` page, and where the
 * page sits in it: scaled uniformly and centred, exactly as `placePage` puts pages on a sheet.
 */
export function fitInPanel(w: number, h: number, aspect: number) {
  const W = h / w > aspect ? h / aspect : w;
  const H = W * aspect;
  return { W, H, x: (W - w) / 2, y: (H - h) / 2 };
}

/** Grid helper shared with the imposed-PDF reader. */
export const panelCount = (g: Grid) => g.cols * g.rows;
