/**
 * Print geometry, pure and unit-tested: where each panel of an imposed sheet goes on the output
 * sheet (PDF points, y up), crop and fold marks, and how to place a source page (with its own
 * /Rotate and trim box) into a panel. The PDF writer and the imposed-PDF reader only draw what
 * these functions compute.
 */
import type { Grid, Plan, Rotation, Slot } from '../engine';

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
  /** The whole imposition's trim and bleed rectangles. */
  trim: Rect;
  bleed: Rect;
  /** Whether back sides are rotated 180° in the PDF (printer turns top ↔ bottom). */
  backRotated: boolean;
  /** Printer setting that matches: flip on the short or long edge. */
  printerFlip: 'short' | 'long';
  cropMarks: Segment[];
  foldMarks: Segment[];
  /** Where to put the slug label (baseline start), if enabled. */
  slugAt: { x: number; y: number } | null;
  warnings: string[];
  /** Panels for each sheet side, in output order is decided by the writer. */
  place(sheet: number, side: 'front' | 'back'): PlacedSlot[];
}

/**
 * Lay the plan out on output sheets. `page` is the finished (trimmed) page size in points.
 */
export function layoutSheets(
  plan: Plan,
  page: { w: number; h: number },
  o: PrintOptions,
): SheetLayout {
  const { cols, rows } = plan.grid;
  const impW = cols * page.w;
  const impH = rows * page.h;
  const bleed = Math.max(0, o.bleed) * MM;
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
    width = impW + 2 * reserve;
    height = impH + 2 * reserve;
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
    const room = (w: number, h: number) => ({
      w: w - 2 * Math.max(margin, reserve),
      h: h - 2 * Math.max(margin, reserve),
    });
    const fitScale = (w: number, h: number) => {
      const r = room(w, h);
      return Math.min(r.w / impW, r.h / impH);
    };
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
          `At 100 % the imposition (${fmtMm(impW)} × ${fmtMm(impH)} mm) does not fit the sheet with its margins and marks; it will be cut off.`,
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

  const tw = impW * scale;
  const th = impH * scale;
  const trim: Rect = {
    x: (width - tw) / 2,
    y: (height - th) / 2,
    w: tw,
    h: th,
  };
  const bleedRect: Rect = {
    x: trim.x - bleed,
    y: trim.y - bleed,
    w: tw + 2 * bleed,
    h: th + 2 * bleed,
  };
  const orientation = width > height ? 'landscape' : 'portrait';

  // Turning the sheet left ↔ right is our back view (no rotation). On a landscape sheet that is a
  // flip on the short edge, on a portrait sheet a flip on the long edge.
  const natural: 'short' | 'long' = orientation === 'landscape' ? 'short' : 'long';
  const printerFlip = o.flip === 'auto' ? natural : o.flip;
  const backRotated = printerFlip !== natural;

  const off = Math.max(MARK_OFFSET, bleed);
  const cropMarks: Segment[] = [];
  if (o.cropMarks) {
    const xs = [trim.x, trim.x + tw];
    const ys = [trim.y, trim.y + th];
    for (const x of xs) {
      for (const y of ys) {
        const sx = x === trim.x ? -1 : 1;
        const sy = y === trim.y ? -1 : 1;
        cropMarks.push({ x1: x + sx * off, y1: y, x2: x + sx * (off + MARK_LENGTH), y2: y });
        cropMarks.push({ x1: x, y1: y + sy * off, x2: x, y2: y + sy * (off + MARK_LENGTH) });
      }
    }
  }
  const foldMarks: Segment[] = [];
  if (o.foldMarks) {
    for (let c = 1; c < cols; c++) {
      const x = trim.x + c * page.w * scale;
      foldMarks.push({ x1: x, y1: trim.y + th + off, x2: x, y2: trim.y + th + off + MARK_LENGTH });
      foldMarks.push({ x1: x, y1: trim.y - off, x2: x, y2: trim.y - off - MARK_LENGTH });
    }
    for (let r = 1; r < rows; r++) {
      const y = trim.y + th - r * page.h * scale;
      foldMarks.push({ x1: trim.x - off, y1: y, x2: trim.x - off - MARK_LENGTH, y2: y });
      foldMarks.push({ x1: trim.x + tw + off, y1: y, x2: trim.x + tw + off + MARK_LENGTH, y2: y });
    }
  }
  const slugAt = o.slug
    ? {
        x: trim.x + (marks ? off + MARK_LENGTH + 2 * MM : 0),
        y: Math.max(2 * MM, trim.y - (marks ? off + 2.2 * MM : bleed + 3.5 * MM)),
      }
    : null;

  function place(sheet: number, side: 'front' | 'back'): PlacedSlot[] {
    const slots = plan.sheets[sheet]?.[side] ?? [];
    const turn = side === 'back' && backRotated;
    return slots.map((slot) => {
      // A back printed top ↔ bottom is our back view turned by 180°.
      const col = turn ? cols - 1 - slot.col : slot.col;
      const row = turn ? rows - 1 - slot.row : slot.row;
      const rotation = (turn ? (slot.rotation + 180) % 360 : slot.rotation) as Rotation;
      return {
        slot,
        rotation,
        rect: {
          x: trim.x + col * page.w * scale,
          y: trim.y + (rows - 1 - row) * page.h * scale,
          w: page.w * scale,
          h: page.h * scale,
        },
        outer: {
          top: row === 0,
          bottom: row === rows - 1,
          left: col === 0,
          right: col === cols - 1,
        },
      };
    });
  }

  return {
    width,
    height,
    orientation,
    scale,
    trim,
    bleed: bleedRect,
    backRotated,
    printerFlip,
    cropMarks,
    foldMarks,
    slugAt,
    warnings,
    place,
  };
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
