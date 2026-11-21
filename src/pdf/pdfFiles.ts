/**
 * PDF reading and writing with pdf-lib. Pages are embedded as vector Form XObjects (no
 * rasterising), clipped to the region they show. All geometry comes from `geometry.ts` and
 * `imposed.ts`.
 */
import {
  cmyk,
  degrees,
  PDFDocument,
  type PDFPage,
  StandardFonts,
  type PDFFont,
  grayscale,
} from 'pdf-lib';
import type { Plan, Recipe } from '../engine';
import {
  layoutSheets,
  MM,
  placePage,
  type PrintOptions,
  type Rect,
  type SheetLayout,
} from './geometry';
import {
  displayedSize,
  displayedToBox,
  imposedArea,
  panelRegion,
  type ImposedOptions,
  type PdfPageInfo,
  sideMap,
  slotsByPosition,
} from './imposed';

const asRect = (b: { x: number; y: number; width: number; height: number }): Rect => ({
  x: b.x,
  y: b.y,
  w: b.width,
  h: b.height,
});

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/** /Rotate and boxes of every page. */
export function pageInfo(doc: PDFDocument): PdfPageInfo[] {
  return doc.getPages().map((p) => {
    const crop = asRect(p.getCropBox());
    const hasTrim = p.node.TrimBox() !== undefined;
    return {
      rotate: p.getRotation().angle,
      crop,
      trim: hasTrim ? asRect(p.getTrimBox()) : crop,
      hasTrim,
    };
  });
}

/** Finished page size (points) as seen: the trim box of the first page, after its /Rotate. */
export function finishedPageSize(info: PdfPageInfo[]): { w: number; h: number } {
  const first = info[0];
  if (!first) return { w: 148 * MM, h: 210 * MM };
  return displayedSize(first.trim, first.rotate);
}

/**
 * A numbered dummy: one page per booklet page, with a big page number and a frame, for test
 * prints (a paper dummy) and for exporting before the real PDF exists.
 */
export async function placeholderPdf(pageCount: number, size: { w: number; h: number }) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = doc.addPage([size.w, size.h]);
    const inset = Math.min(size.w, size.h) * 0.06;
    page.drawRectangle({
      x: inset,
      y: inset,
      width: size.w - 2 * inset,
      height: size.h - 2 * inset,
      borderColor: grayscale(0.6),
      borderWidth: 1,
    });
    const label = String(n);
    const fontSize = Math.min(size.w, size.h) * 0.4;
    const w = bold.widthOfTextAtSize(label, fontSize);
    page.drawText(label, {
      x: (size.w - w) / 2,
      y: size.h / 2 - fontSize * 0.35,
      size: fontSize,
      font: bold,
    });
    const caption = `page ${n} of ${pageCount}`;
    const cs = Math.max(6, fontSize * 0.08);
    page.drawText(caption, {
      x: (size.w - font.widthOfTextAtSize(caption, cs)) / 2,
      y: inset * 1.6,
      size: cs,
      font,
      color: grayscale(0.4),
    });
    // An arrow at the head, so orientation is obvious on paper.
    const ax = size.w / 2;
    const ay = size.h - inset * 1.4;
    page.drawLine({ start: { x: ax, y: ay - cs * 3 }, end: { x: ax, y: ay }, thickness: 1.5 });
    page.drawLine({ start: { x: ax - cs, y: ay - cs }, end: { x: ax, y: ay }, thickness: 1.5 });
    page.drawLine({ start: { x: ax + cs, y: ay - cs }, end: { x: ax, y: ay }, thickness: 1.5 });
  }
  return doc;
}

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
}

export interface ExportResult {
  files: ExportFile[];
  layout: SheetLayout;
}

/**
 * Whether a page has a content stream. pdf-lib refuses to embed a page without one (a valid, blank
 * page), so those are skipped and simply stay blank.
 */
const hasContents = (page: PDFPage) => page.node.Contents() !== undefined;

/** Registration colour for marks: prints on every plate. */
const REGISTRATION = cmyk(1, 1, 1, 1);

async function drawSide(
  out: PDFDocument,
  src: PDFDocument,
  info: PdfPageInfo[],
  layout: SheetLayout,
  sheet: number,
  side: 'front' | 'back',
  bleed: number,
  slug: { font: PDFFont; text: string } | null,
) {
  const page = out.addPage([layout.width, layout.height]);
  for (const placed of layout.place(sheet, side)) {
    const n = placed.slot.page;
    if (n === null || n > info.length) continue;
    const srcPage = src.getPage(n - 1);
    if (!hasContents(srcPage)) continue; // a truly empty page: nothing to draw
    const p = placePage(
      { rotate: info[n - 1]!.rotate, trim: info[n - 1]!.trim },
      placed.rect,
      placed.rotation,
      placed.outer,
      bleed,
    );
    const embedded = await out.embedPage(srcPage, p.box);
    page.drawPage(embedded, {
      x: p.x,
      y: p.y,
      xScale: p.scale,
      yScale: p.scale,
      rotate: degrees(p.rotateCcw),
    });
  }
  drawMarks(page, layout);
  if (slug && layout.slugAt) {
    page.drawText(`${slug.text} · sheet ${sheet + 1} ${side}`, {
      x: layout.slugAt.x,
      y: layout.slugAt.y,
      size: 6,
      font: slug.font,
      color: cmyk(0, 0, 0, 1),
    });
  }
  const t = layout.trim;
  page.setTrimBox(t.x, t.y, t.w, t.h);
  const b = layout.bleed;
  page.setBleedBox(b.x, b.y, b.w, b.h);
  return page;
}

function drawMarks(page: PDFPage, layout: SheetLayout) {
  for (const m of layout.cropMarks) {
    page.drawLine({
      start: { x: m.x1, y: m.y1 },
      end: { x: m.x2, y: m.y2 },
      thickness: 0.25,
      color: REGISTRATION,
    });
  }
  for (const m of layout.foldMarks) {
    page.drawLine({
      start: { x: m.x1, y: m.y1 },
      end: { x: m.x2, y: m.y2 },
      thickness: 0.25,
      color: REGISTRATION,
      dashArray: [2, 2],
    });
  }
}

export interface ExportInput {
  plan: Plan;
  recipe: Recipe;
  /** Reading-order source; null exports the numbered dummy. */
  source: Uint8Array | null;
  /** Finished page size for the dummy (ignored with a source). */
  dummyPageSize: { w: number; h: number };
  options: PrintOptions;
  /** File name stem, e.g. the source PDF's name. */
  baseName: string;
  /** Only this sheet (for a quick preview). */
  onlySheet?: number;
}

/** Impose the source onto print-ready sheets. */
export async function exportImposed(input: ExportInput): Promise<ExportResult> {
  const { plan, recipe, options } = input;
  // The dummy is saved and reloaded so its pages embed like any loaded PDF's.
  const src = await loadPdf(
    input.source ?? (await (await placeholderPdf(plan.pageCount, input.dummyPageSize)).save()),
  );
  const info = pageInfo(src);
  const pageSize = input.source ? finishedPageSize(info) : input.dummyPageSize;
  const layout = layoutSheets(plan, pageSize, options);
  const bleed = Math.max(0, options.bleed) * MM;
  const sheets = input.onlySheet !== undefined ? [input.onlySheet] : plan.sheets.map((_, i) => i);
  const hasBacks = plan.sheets.some((s) => s.back.length > 0);
  const title = `${input.baseName} · ${recipe.name}`;

  const make = async () => {
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setCreator('Print Layout');
    doc.setProducer('Print Layout (pdf-lib)');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return { doc, slug: options.slug ? { font, text: asciiOnly(title) } : null };
  };

  const files: ExportFile[] = [];
  if (options.sides === 'duplex' || !hasBacks) {
    const { doc, slug } = await make();
    for (const s of sheets) {
      await drawSide(doc, src, info, layout, s, 'front', bleed, slug);
      if (hasBacks) await drawSide(doc, src, info, layout, s, 'back', bleed, slug);
    }
    files.push({ name: `${input.baseName}-imposed.pdf`, bytes: await doc.save() });
  } else {
    const fronts = await make();
    const backs = await make();
    for (const s of sheets)
      await drawSide(fronts.doc, src, info, layout, s, 'front', bleed, fronts.slug);
    const backOrder = options.reverseBacks ? [...sheets].reverse() : sheets;
    for (const s of backOrder)
      await drawSide(backs.doc, src, info, layout, s, 'back', bleed, backs.slug);
    files.push({ name: `${input.baseName}-fronts.pdf`, bytes: await fronts.doc.save() });
    files.push({ name: `${input.baseName}-backs.pdf`, bytes: await backs.doc.save() });
  }
  return { files, layout };
}

/** The standard fonts only cover WinAnsi; keep slugs to plain characters. */
const asciiOnly = (s: string) => s.replace(/[^\x20-\x7e]/g, (c) => (c === '·' ? '-' : '?'));

/**
 * De-impose: cut an imposed PDF back into single pages in reading order (upright), using the
 * recipe's plan. Blank positions become empty pages.
 */
export async function deimposePdf(
  imposed: Uint8Array,
  plan: Plan,
  options: ImposedOptions,
  baseName: string,
): Promise<ExportFile> {
  const src = await loadPdf(imposed);
  const info = pageInfo(src);
  const sides = sideMap(info.length, options.order);
  const out = await PDFDocument.create();
  out.setTitle(`${baseName} (reading order)`);
  out.setCreator('Print Layout');
  const bySlot = slotsByPosition(plan);
  for (let pos = 1; pos <= plan.slotCount; pos++) {
    const at = bySlot.get(pos);
    const index = at ? sides.pageOf(at.sheet, at.side) : null;
    if (!at || index === null) {
      const prev = out.getPageCount() ? out.getPage(0).getSize() : { width: 420, height: 595 };
      out.addPage([prev.width, prev.height]);
      continue;
    }
    const pi = info[index]!;
    const region = panelRegion(
      imposedArea(pi, options),
      plan.grid,
      at.slot.col,
      at.slot.row,
      at.side,
      options,
    );
    const box = displayedToBox(pi.crop, pi.rotate, region.rect);
    const shown = displayedSize(box, pi.rotate);
    // Read it upright: undo the slot's rotation and any back-side turn.
    const upright = (region.turn + at.slot.rotation) % 360;
    const page = out.addPage([shown.w, shown.h]);
    const p = placePage(
      { rotate: pi.rotate, trim: box },
      { x: 0, y: 0, w: shown.w, h: shown.h },
      upright,
      { top: false, right: false, bottom: false, left: false },
      0,
    );
    const srcPage = src.getPage(index);
    if (!hasContents(srcPage)) continue; // an empty sheet side reads as a blank page
    const embedded = await out.embedPage(srcPage, p.box);
    page.drawPage(embedded, {
      x: p.x,
      y: p.y,
      xScale: p.scale,
      yScale: p.scale,
      rotate: degrees(p.rotateCcw),
    });
  }
  return { name: `${baseName}-reading-order.pdf`, bytes: await out.save() };
}
