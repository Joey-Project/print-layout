/**
 * PDF reading and writing with pdf-lib. Pages are embedded as vector Form XObjects (no
 * rasterising), clipped to the region they show. All geometry comes from `geometry.ts` and
 * `imposed.ts`.
 */
import {
  cmyk,
  concatTransformationMatrix,
  degrees,
  drawObject,
  grayscale,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFOperator,
  PDFOperatorNames,
  type PDFPage,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  lineTo,
  moveTo,
  setDashPattern,
  setLineWidth,
  stroke,
  StandardFonts,
  type PDFFont,
} from 'pdf-lib';
import type { Plan, Recipe } from '../engine';
import {
  layoutSheets,
  MM,
  sectionPageSize,
  type Segment,
  placePage,
  type PrintOptions,
  type Rect,
  type SheetLayout,
} from './geometry';
import {
  physicalSize,
  displayedToBox,
  proofLayout,
  type ImposedOptions,
  type PdfPageInfo,
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

/** Annotation flags (PDF 32000, 12.5.3). */
const ANNOT_HIDDEN = 2;
const ANNOT_PRINT = 4;

/**
 * Bake what would print into each page's own content, so embedding a page (which carries only its
 * content stream) keeps it: every annotation that is set to print, is not hidden and has an
 * appearance — form fields, stamps, highlights, signatures, free text… pdf.js shows these in the
 * preview, so without this they would silently vanish from the exported sheets.
 *
 * Form fields are not flattened with pdf-lib's `form.flatten()`, which draws every widget
 * regardless of its flags; their appearances are only brought up to date, then drawn like any
 * other annotation.
 */
export function flattenForPrint(doc: PDFDocument) {
  try {
    const form = doc.getForm();
    if (form.getFields().length > 0) form.updateFieldAppearances();
  } catch {
    // Values the standard fonts cannot draw, or a broken form: keep the appearances it has.
  }
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookupMaybe(annots.get(i), PDFDict);
      if (annot) drawAppearance(doc, page, annot);
    }
  }
}

const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

function drawAppearance(doc: PDFDocument, page: PDFPage, annot: PDFDict) {
  const flags = num(annot.lookup(PDFName.of('F'))) ?? 0;
  if (!(flags & ANNOT_PRINT) || flags & ANNOT_HIDDEN) return;
  const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
  let normal = ap?.get(PDFName.of('N'));
  // Appearance states (check boxes…): pick the one named by /AS.
  const states = normal ? doc.context.lookup(normal) : undefined;
  if (states instanceof PDFDict && !(states instanceof PDFStream)) {
    const as = annot.lookup(PDFName.of('AS'));
    normal = as instanceof PDFName ? states.get(as) : undefined;
  }
  if (!normal) return;
  const ref = normal instanceof PDFRef ? normal : doc.context.register(normal);
  const stream = doc.context.lookupMaybe(ref, PDFStream);
  const rect = annot.lookupMaybe(PDFName.of('Rect'), PDFArray);
  if (!stream || !rect || rect.size() < 4) return;
  const [rx1, ry1, rx2, ry2] = [0, 1, 2, 3].map((k) => num(rect.lookup(k)) ?? 0) as [
    number,
    number,
    number,
    number,
  ];
  const bboxArr = stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
  const bbox = bboxArr ? [0, 1, 2, 3].map((k) => num(bboxArr.lookup(k)) ?? 0) : [0, 0, 1, 1];
  const matArr = stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
  const [a, b, c, d, e, f] = matArr
    ? [0, 1, 2, 3, 4, 5].map((k) => num(matArr.lookup(k)) ?? 0)
    : [1, 0, 0, 1, 0, 0];
  // PDF 32000 12.5.5: transform the BBox by the form's Matrix, then map that box onto Rect.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [bbox[0]!, bbox[1]!],
    [bbox[2]!, bbox[1]!],
    [bbox[0]!, bbox[3]!],
    [bbox[2]!, bbox[3]!],
  ] as const) {
    xs.push(a! * x + c! * y + e!);
    ys.push(b! * x + d! * y + f!);
  }
  const bw = Math.max(...xs) - Math.min(...xs);
  const bh = Math.max(...ys) - Math.min(...ys);
  if (bw <= 0 || bh <= 0) return;
  const sx = (Math.max(rx1, rx2) - Math.min(rx1, rx2)) / bw;
  const sy = (Math.max(ry1, ry2) - Math.min(ry1, ry2)) / bh;
  const tx = Math.min(rx1, rx2) - Math.min(...xs) * sx;
  const ty = Math.min(ry1, ry2) - Math.min(...ys) * sy;
  const name = page.node.newXObject('FlatAnnot', ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(sx, 0, 0, sy, tx, ty),
    drawObject(name),
    popGraphicsState(),
  );
}

/** /Rotate and boxes of every page. */
export function pageInfo(doc: PDFDocument): PdfPageInfo[] {
  return doc.getPages().map((p) => {
    const crop = asRect(p.getCropBox());
    const hasTrim = p.node.TrimBox() !== undefined;
    const unit = num(p.node.get(PDFName.of('UserUnit')));
    return {
      rotate: p.getRotation().angle,
      crop,
      trim: hasTrim ? asRect(p.getTrimBox()) : crop,
      hasTrim,
      unit: unit && unit > 0 ? unit : 1,
    };
  });
}

/** Finished page size (points) as seen: the trim box of the first page, after its /Rotate. */
export function finishedPageSize(info: PdfPageInfo[]): { w: number; h: number } {
  const first = info[0];
  if (!first) return { w: 148 * MM, h: 210 * MM };
  return physicalSize(first, first.trim);
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

async function drawSide(
  out: PDFDocument,
  src: PDFDocument,
  info: PdfPageInfo[],
  layout: SheetLayout,
  paper: number,
  side: 'front' | 'back',
  bleed: number,
  extras: { slug: { font: PDFFont; text: string } | null; registration: PDFRef },
) {
  const { slug, registration } = extras;
  const page = out.addPage([layout.width, layout.height]);
  for (const placed of layout.place(paper, side)) {
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
  drawMarks(page, layout.marks(side), registration);
  if (slug && layout.slugAt) {
    page.drawText(`${slug.text} · sheet ${paper + 1} of ${layout.gang.papers} ${side}`, {
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

/**
 * The registration colour space: the special separation /All paints on every plate, process and
 * spot alike (PDF 32000 8.6.6.4); viewers show it through its CMYK alternate (all inks = black).
 */
function registrationColorSpace(doc: PDFDocument): PDFRef {
  const tint = doc.context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [1, 1, 1, 1],
    N: 1,
  });
  return doc.context.register(
    doc.context.obj([PDFName.of('Separation'), PDFName.of('All'), PDFName.of('DeviceCMYK'), tint]),
  );
}

const REG_CS = 'CSRegistration';

function drawMarks(
  page: PDFPage,
  marks: { crop: Segment[]; fold: Segment[] },
  registration: PDFRef,
) {
  if (!marks.crop.length && !marks.fold.length) return;
  const { Resources } = page.node.normalizedEntries();
  let spaces = Resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  if (!spaces) {
    spaces = page.doc.context.obj({});
    Resources.set(PDFName.of('ColorSpace'), spaces);
  }
  spaces.set(PDFName.of(REG_CS), registration);
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of(REG_CS)]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(0.25),
  ];
  const line = (m: { x1: number; y1: number; x2: number; y2: number }) =>
    ops.push(moveTo(m.x1, m.y1), lineTo(m.x2, m.y2), stroke());
  marks.crop.forEach(line);
  if (marks.fold.length) {
    ops.push(setDashPattern([2, 2], 0));
    marks.fold.forEach(line);
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
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
  /** Only this printed sheet (for a quick preview). */
  onlySheet?: number;
}

/** Impose the source onto print-ready sheets. */
export async function exportImposed(input: ExportInput): Promise<ExportResult> {
  const { plan, recipe, options } = input;
  // A sheet divided into sections sizes the dummy's pages itself.
  const dummySize = sectionPageSize(options, plan.grid) ?? input.dummyPageSize;
  // The dummy is saved and reloaded so its pages embed like any loaded PDF's.
  const src = await loadPdf(
    input.source ?? (await (await placeholderPdf(plan.pageCount, dummySize)).save()),
  );
  flattenForPrint(src);
  const info = pageInfo(src);
  const pageSize = input.source ? finishedPageSize(info) : dummySize;
  const layout = layoutSheets(plan, pageSize, options);
  // Sections meet at the cuts: drawing bleed there would spill into the neighbour or the blank.
  const bleed = layout.paper.sectioned ? 0 : Math.max(0, options.bleed) * MM;
  // Printed sheets (several recipe sheets each when ganged).
  const sheets =
    input.onlySheet !== undefined
      ? [input.onlySheet]
      : Array.from({ length: layout.gang.papers }, (_, i) => i);
  const hasBacks = plan.sheets.some((s) => s.back.length > 0);
  const title = `${input.baseName} · ${recipe.name}`;

  const make = async () => {
    const doc = await PDFDocument.create();
    doc.setTitle(title);
    doc.setCreator('Print Layout');
    doc.setProducer('Print Layout (pdf-lib)');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    return {
      doc,
      extras: {
        slug: options.slug ? { font, text: asciiOnly(title) } : null,
        registration: registrationColorSpace(doc),
      },
    };
  };

  const files: ExportFile[] = [];
  if (options.sides === 'duplex' || !hasBacks) {
    const { doc, extras } = await make();
    for (const s of sheets) {
      await drawSide(doc, src, info, layout, s, 'front', bleed, extras);
      if (hasBacks) await drawSide(doc, src, info, layout, s, 'back', bleed, extras);
    }
    files.push({ name: `${input.baseName}-imposed.pdf`, bytes: await doc.save() });
  } else {
    const fronts = await make();
    const backs = await make();
    for (const s of sheets)
      await drawSide(fronts.doc, src, info, layout, s, 'front', bleed, fronts.extras);
    const backOrder = options.reverseBacks ? [...sheets].reverse() : sheets;
    for (const s of backOrder)
      await drawSide(backs.doc, src, info, layout, s, 'back', bleed, backs.extras);
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
  flattenForPrint(src);
  const info = pageInfo(src);
  const proof = proofLayout(info, plan, options);
  const out = await PDFDocument.create();
  out.setTitle(`${baseName} (reading order)`);
  out.setCreator('Print Layout');
  const bySlot = slotsByPosition(plan);
  for (let pos = 1; pos <= plan.slotCount; pos++) {
    const at = bySlot.get(pos);
    const region = at ? proof.region(at.sheet, at.side, at.slot.col, at.slot.row) : null;
    if (!at || !region) {
      const prev = out.getPageCount() ? out.getPage(0).getSize() : { width: 420, height: 595 };
      out.addPage([prev.width, prev.height]);
      continue;
    }
    const index = region.index;
    const pi = info[index]!;
    const box = displayedToBox(pi.crop, pi.rotate, region.rect);
    // Keep the physical size: user units are /UserUnit points each.
    const shown = physicalSize(pi, box);
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
