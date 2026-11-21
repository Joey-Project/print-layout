import { buildPlan, builtinRecipes, type Recipe } from '../src/engine';
import { MM, PRINT_PRESETS, type PrintOptions } from '../src/pdf/geometry';
import { DEFAULT_IMPOSED, type ImposedOptions } from '../src/pdf/imposed';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from 'pdf-lib';
import { deimposePdf, exportImposed, loadPdf, pageInfo, placeholderPdf } from '../src/pdf/pdfFiles';

const recipe = (id: string): Recipe => builtinRecipes.find((r) => r.id === id)!;
const A5 = { w: 148 * MM, h: 210 * MM };

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfJs;
beforeAll(async () => {
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
});

/**
 * For each page: the big page numbers that are visible (inside the page) and upright. The dummy
 * draws each page's number as one large text item; text from neighbouring pages clipped away by
 * the embedding falls outside the page or is tiny.
 */
async function visibleNumbers(bytes: Uint8Array): Promise<string[][]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: string[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    const found: string[] = [];
    for (const it of items) {
      if (!('str' in it) || !/^\d+$/.test(it.str)) continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      const size = Math.hypot(c!, d!);
      if (size < 20) continue; // captions, not the big number
      // Centre of the glyph run in viewport space must be on the page.
      const [x, y] = vp.convertToViewportPoint(
        e! + (a! * it.width) / 2 / size + c! * 0.3,
        f! + b! * 0 + d! * 0.3,
      );
      if (x! < 0 || y! < 0 || x! > vp.width || y! > vp.height) continue;
      const upright = a! > 0 && Math.abs(b!) < 1e-6 && d! > 0;
      found.push(upright ? it.str : `${it.str}↻`);
    }
    pages.push(found);
  }
  return pages;
}

const opts = (preset: keyof typeof PRINT_PRESETS, o: Partial<PrintOptions> = {}): PrintOptions => ({
  ...PRINT_PRESETS[preset].options,
  ...o,
});

describe('PDF export and de-imposition round trip', () => {
  const cases: [
    string,
    string,
    number,
    keyof typeof PRINT_PRESETS,
    Partial<PrintOptions>,
    Partial<ImposedOptions>,
  ][] = [
    ['saddle stitch, home duplex', 'saddle-stitch', 8, 'home', {}, {}],
    [
      'saddle stitch, print shop',
      'saddle-stitch',
      12,
      'shop',
      {},
      { inset: { top: 8, right: 8, bottom: 8, left: 8 }, useTrimBox: false },
    ],
    [
      'saddle stitch, backs flipped top-bottom',
      'saddle-stitch',
      8,
      'home',
      { flip: 'long' },
      { backRotated: true },
    ],
    ['8-page signature (head-to-head)', 'signature-8', 16, 'shop', {}, {}],
    ['right-to-left saddle stitch', 'saddle-stitch-rtl', 8, 'home', {}, {}],
  ];

  it.each(cases)('%s', async (_name, id, pages, preset, print, imposed) => {
    const r = recipe(id);
    const plan = buildPlan(r, pages);
    const { files, layout } = await exportImposed({
      plan,
      recipe: r,
      source: null,
      dummyPageSize: A5,
      options: opts(preset, print),
      baseName: 'test',
    });
    expect(files).toHaveLength(1);
    const doc = await loadPdf(files[0]!.bytes);
    expect(doc.getPageCount()).toBe(plan.sheets.length * 2);
    const info = pageInfo(doc);
    for (const p of info) {
      expect(p.crop.w).toBeCloseTo(layout.width, 3);
      expect(p.hasTrim).toBe(true);
    }

    // The imposed sheets show each slot's page, rotated as planned.
    const sheetsText = await visibleNumbers(files[0]!.bytes);
    plan.sheets.forEach((s, i) => {
      for (const side of ['front', 'back'] as const) {
        const want = s[side]
          .filter((x) => x.page !== null)
          .map(
            (x) =>
              `${x.page}${(x.rotation + (side === 'back' && layout.backRotated ? 180 : 0)) % 360 ? '↻' : ''}`,
          )
          .sort();
        expect(sheetsText[i * 2 + (side === 'back' ? 1 : 0)]!.sort()).toEqual(want);
      }
    });

    // Cutting it back up gives every page, in order, upright.
    const back = await deimposePdf(
      files[0]!.bytes,
      plan,
      { ...DEFAULT_IMPOSED, ...imposed },
      'test',
    );
    const reading = await visibleNumbers(back.bytes);
    expect(reading).toHaveLength(plan.slotCount);
    reading.forEach((nums, i) => {
      const pos = i + 1;
      const slot = plan.sheets
        .flatMap((s) => [...s.front, ...s.back])
        .find((x) => x.position === pos)!;
      expect(nums, `reading position ${pos}`).toEqual(
        slot.page === null ? [] : [String(slot.page)],
      );
    });
  });

  it('splits fronts and backs for manual duplex, backs reversed', async () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 12);
    const { files } = await exportImposed({
      plan,
      recipe: r,
      source: null,
      dummyPageSize: A5,
      options: opts('manual'),
      baseName: 'test',
    });
    expect(files.map((f) => f.name)).toEqual(['test-fronts.pdf', 'test-backs.pdf']);
    const fronts = await visibleNumbers(files[0]!.bytes);
    const backs = await visibleNumbers(files[1]!.bytes);
    expect(fronts.map((p) => p.sort())).toEqual([
      ['1', '12'],
      ['10', '3'],
      ['5', '8'],
    ]);
    expect(backs.map((p) => p.sort())).toEqual([
      ['6', '7'],
      ['4', '9'],
      ['11', '2'],
    ]);
  });
  it('keeps pages that have no content stream as blanks', async () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    // Page 3 is a valid blank page with no /Contents at all.
    const dummy = await placeholderPdf(8, A5);
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(dummy, [0, 1, 2, 3, 4, 5, 6, 7]);
    copied.forEach((p, i) => {
      if (i === 2) doc.addPage([A5.w, A5.h]);
      else doc.addPage(p);
    });
    expect(doc.getPage(2).node.Contents()).toBeUndefined();
    const source = await doc.save();
    const { files } = await exportImposed({
      plan,
      recipe: r,
      source,
      dummyPageSize: A5,
      options: opts('home'),
      baseName: 'test',
    });
    const sheets = await visibleNumbers(files[0]!.bytes);
    expect(sheets.flat()).not.toContain('3');
    expect(sheets.flat()).toContain('4');

    // An imposed PDF with an empty sheet side de-imposes to blank pages there.
    const bare = await PDFDocument.create();
    const src = await PDFDocument.load(files[0]!.bytes);
    const [f0] = await bare.copyPages(src, [0]);
    bare.addPage(f0!);
    bare.addPage([f0!.getWidth(), f0!.getHeight()]); // an empty back, no /Contents
    const back = await deimposePdf(await bare.save(), plan, DEFAULT_IMPOSED, 'test');
    const reading = await visibleNumbers(back.bytes);
    // Sheet 1 front holds 8 and 1; its back (2 and 7) is empty.
    expect(reading[0]).toEqual(['1']);
    expect(reading[1]).toEqual([]);
    expect(reading[6]).toEqual([]);
    expect(reading[7]).toEqual(['8']);
  });
  it('keeps filled form fields and printable annotations', async () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    const dummy = await placeholderPdf(8, A5);
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(dummy, [0, 1, 2, 3, 4, 5, 6, 7]);
    // Page 1: nothing in its content, only a printable stamp whose appearance shows "1".
    const stampArt = await doc.embedPage(copied[0]!);
    // Page 2: only a filled form field showing "2".
    copied.forEach((p, i) => {
      if (i === 0 || i === 1) doc.addPage([A5.w, A5.h]);
      else doc.addPage(p);
    });
    const stamp = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Rect: [0, 0, A5.w, A5.h],
      F: 4,
      AP: { N: stampArt.ref },
    });
    doc.getPage(0).node.addAnnot(doc.context.register(stamp));
    // A hidden stamp must not print.
    const hidden = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Rect: [0, 0, A5.w, A5.h],
      F: 4 | 2,
      AP: { N: (await doc.embedPage(copied[6]!)).ref },
    });
    doc.getPage(0).node.addAnnot(doc.context.register(hidden));
    const field = doc.getForm().createTextField('page2');
    field.setText('2');
    field.addToPage(doc.getPage(1), { x: 40, y: 200, width: 200, height: 120 });
    field.setFontSize(80);
    // A hidden form field must not print either.
    const secret = doc.getForm().createTextField('secret');
    secret.setText('9');
    secret.addToPage(doc.getPage(1), { x: 40, y: 360, width: 200, height: 120, hidden: true });
    secret.setFontSize(80);
    expect(doc.getPage(0).node.Contents()).toBeUndefined();
    const source = await doc.save();

    const { files } = await exportImposed({
      plan,
      recipe: r,
      source,
      dummyPageSize: A5,
      options: opts('home'),
      baseName: 'test',
    });
    const shown = (await visibleNumbers(files[0]!.bytes)).flat();
    expect(shown).toContain('1');
    expect(shown).toContain('2');
    expect(shown.filter((x) => x === '7')).toHaveLength(1); // page 7 itself, not the hidden stamp
    expect(shown).not.toContain('9'); // the hidden field
  });
  it('draws crop and fold marks in the registration (/All) separation', async () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    const { files } = await exportImposed({
      plan,
      recipe: r,
      source: null,
      dummyPageSize: A5,
      options: opts('shop'),
      baseName: 'test',
    });
    const doc = await loadPdf(files[0]!.bytes);
    const page = doc.getPage(0);
    const spaces = page.node.Resources()!.lookup(PDFName.of('ColorSpace'), PDFDict);
    const cs = spaces.lookup(PDFName.of('CSRegistration'), PDFArray);
    expect(cs.lookup(0)).toBe(PDFName.of('Separation'));
    expect(cs.lookup(1)).toBe(PDFName.of('All'));
    // The page content selects it for stroking before drawing the marks.
    const contents = page.node.Contents()!;
    const streams =
      contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, k) => contents.lookup(k, PDFRawStream))
        : [contents as PDFRawStream];
    const content = streams
      .map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode()))
      .join('\n');
    expect(content).toMatch(/\/CSRegistration CS\s+1 SCN/);
  });
  it('sizes pages with a /UserUnit by their physical size', async () => {
    const r = recipe('saddle-stitch');
    const plan = buildPlan(r, 8);
    // Half-size boxes with /UserUnit 2: physically A5.
    const doc = await placeholderPdf(8, { w: A5.w / 2, h: A5.h / 2 });
    for (const p of doc.getPages()) p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const source = await doc.save();
    const info = pageInfo(await loadPdf(source));
    expect(info[0]!.unit).toBe(2);
    const { files, layout } = await exportImposed({
      plan,
      recipe: r,
      source,
      dummyPageSize: A5,
      options: opts('shop'),
      baseName: 'test',
    });
    // Exact-size sheet: two A5 pages wide plus 8 mm of marks each side.
    expect(layout.width / MM).toBeCloseTo(296 + 16, 6);
    expect(layout.scale).toBe(1);
    // Cut back up, each page is A5 again and shows its number.
    const back = await deimposePdf(files[0]!.bytes, plan, DEFAULT_IMPOSED, 'test');
    const out = await loadPdf(back.bytes);
    expect(out.getPage(0).getWidth() / MM).toBeCloseTo(148, 3);
    expect((await visibleNumbers(back.bytes)).map((n) => n.join())).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
  });
});
