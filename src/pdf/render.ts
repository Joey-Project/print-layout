/** pdf.js in the browser: open a PDF and render pages to canvases (loaded lazily). */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfJsDoc = pdfjs.PDFDocumentProxy;

/** Where the build publishes pdf.js's CMaps and standard fonts (see vite.config.ts). */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** pdf.js takes ownership of the buffer it is given, so it gets a copy. */
export const openPdfJs = (bytes: Uint8Array): Promise<PdfJsDoc> =>
  pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: 0,
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
  }).promise;

/** Render page `index` (0-based) as displayed (after /Rotate), its longest side `px` pixels. */
export async function renderPage(
  doc: PdfJsDoc,
  index: number,
  px: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: px / Math.max(unit.width, unit.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  // Print intent: annotations show exactly when they would print (as in the exported sheets).
  await page.render({ canvas, viewport, intent: 'print' }).promise;
  page.cleanup();
  return canvas;
}
