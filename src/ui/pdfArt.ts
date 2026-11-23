/**
 * Page artwork from a loaded PDF for the 2D sheets and the 3D model. Pages are rendered once, in
 * the background, then cropped per panel on demand:
 *
 * - a *reading-order* PDF supplies page N's trim area, turned as the slot prints it;
 * - an *imposed* PDF is cut back into panels, so the model shows exactly what is printed where.
 *
 * Every image is in the side's own view (back = turned over left ↔ right), as printed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '../engine';
import {
  boxToDisplayed,
  displayedSize,
  physicalSize,
  proofLayout,
  slotsByPosition,
  type ImposedOptions,
  type PdfPageInfo,
} from '../pdf/imposed';
import { fitInPanel, type Rect } from '../pdf/geometry';
import { pageSource } from '../pdf/pageOrder';
import type { PdfJsDoc } from '../pdf/render';

export interface LoadedPdf {
  name: string;
  bytes: Uint8Array;
  info: PdfPageInfo[];
  js: PdfJsDoc;
  /** 'reading': one page per finished page. 'imposed': print-ready sheets to proof. */
  mode: 'reading' | 'imposed';
}

export type PanelArt = (
  sheet: number,
  side: 'front' | 'back',
  col: number,
  row: number,
) => HTMLCanvasElement | null;

export interface PdfArt {
  /** Image for a panel as printed, or null while it renders. */
  art: PanelArt;
  /** Upright image of a reading position (for the reading-order strip). */
  reading: (position: number) => HTMLCanvasElement | null;
  /** Upright image of a reading-order PDF's own page (1-based), whatever its place in the book. */
  sourcePage: (page: number) => HTMLCanvasElement | null;
  /** Bumps as pages finish rendering. */
  version: number;
  /** Finished page height / width. */
  aspect: number;
  rendered: number;
  total: number;
}

/** Longest side of a rendered page: sheets carry several panels, so they get more pixels. */
const RENDER_PX = { reading: 720, imposed: 1600 };

/**
 * Cut region `r` (displayed fractions) out of a rendered page and turn it `turn` degrees. With
 * `panelAspect`, the cut-out is first fitted into a panel of that shape (uniformly scaled and
 * centred on white), as the exporter places a page of a different shape.
 */
function crop(
  src: HTMLCanvasElement,
  r: Rect,
  turn: number,
  panelAspect?: number,
): HTMLCanvasElement {
  const sx = r.x * src.width;
  const sy = r.y * src.height;
  const sw = Math.max(1, r.w * src.width);
  const sh = Math.max(1, r.h * src.height);
  const fit = panelAspect ? fitInPanel(sw, sh, panelAspect) : { W: sw, H: sh, x: 0, y: 0 };
  const out = document.createElement('canvas');
  const sideways = turn % 180 !== 0;
  out.width = Math.round(sideways ? fit.H : fit.W);
  out.height = Math.round(sideways ? fit.W : fit.H);
  const ctx = out.getContext('2d')!;
  if (panelAspect) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((turn * Math.PI) / 180);
  ctx.drawImage(src, sx, sy, sw, sh, -fit.W / 2 + fit.x, -fit.H / 2 + fit.y, sw, sh);
  return out;
}

export function usePdfArt(
  pdf: LoadedPdf | null,
  plan: Plan | null,
  imposed: ImposedOptions,
  /** A reading-order PDF's pages in another order (see `pageSource`). */
  pageOrder?: number[],
): PdfArt | null {
  const pages = useRef(new Map<number, HTMLCanvasElement>());
  const [version, setVersion] = useState(0);
  const [rendered, setRendered] = useState(0);

  // Render every page in the background; publish progress at most every 150 ms.
  useEffect(() => {
    pages.current = new Map();
    setRendered(0);
    setVersion((v) => v + 1);
    if (!pdf) return;
    let cancelled = false;
    let last = 0;
    void (async () => {
      const { renderPage } = await import('../pdf/render');
      for (let i = 0; i < pdf.info.length && !cancelled; i++) {
        try {
          pages.current.set(i, await renderPage(pdf.js, i, RENDER_PX[pdf.mode]));
        } catch {
          // A page that fails to render just stays a placeholder.
        }
        const now = performance.now();
        if (cancelled) return;
        if (now - last > 150 || i === pdf.info.length - 1) {
          last = now;
          setRendered(i + 1);
          setVersion((v) => v + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  return useMemo(() => {
    if (!pdf || !plan) return null;
    const cache = new Map<string, HTMLCanvasElement>();
    const cached = (key: string, page: number, r: Rect, turn: number, panelAspect?: number) => {
      const hit = cache.get(key);
      if (hit) return hit;
      const src = pages.current.get(page);
      if (!src) return null;
      const out = crop(src, r, turn, panelAspect);
      cache.set(key, out);
      return out;
    };
    const bySlot = new Map(
      plan.sheets.flatMap((s, sheet) =>
        (['front', 'back'] as const).flatMap((side) =>
          s[side].map((slot) => [`${sheet}:${side}:${slot.col}:${slot.row}`, slot] as const),
        ),
      ),
    );
    const byPos = slotsByPosition(plan);

    if (pdf.mode === 'reading') {
      const trimOf = (i: number) => {
        const p = pdf.info[i]!;
        return boxToDisplayed(p.crop, p.rotate, p.trim);
      };
      const first = pdf.info[0];
      const size = first ? displayedSize(first.trim, first.rotate) : { w: 1, h: Math.SQRT2 };
      // Every panel has the PDF's first page's shape (as on the exported sheet, whatever the page
      // order); other pages are fitted.
      const panelAspect = size.h / size.w;
      // `page` is the PDF's own page (1-based).
      const pdfPageImage = (page: number, turn: number) =>
        page < 1 || page > pdf.info.length
          ? null
          : cached(`${page}:${turn}`, page - 1, trimOf(page - 1), turn, panelAspect);
      const source = pageSource(pageOrder, pdf.info.length);
      // `page` is a book page (1-based), read from wherever the page order puts it.
      const pageImage = (page: number | null, turn: number) =>
        page === null ? null : pdfPageImage(source(page), turn);
      return {
        art: (sheet, side, col, row) => {
          const slot = bySlot.get(`${sheet}:${side}:${col}:${row}`);
          return slot ? pageImage(slot.page, slot.rotation) : null;
        },
        reading: (pos) => pageImage(byPos.get(pos)?.slot.page ?? null, 0),
        sourcePage: (page) => pdfPageImage(page, 0),
        version,
        aspect: size.h / size.w,
        rendered,
        total: pdf.info.length,
      };
    }

    const proof = proofLayout(pdf.info, plan, imposed);
    const region = proof.region;
    // Page shape: one panel of the first sheet, in physical units.
    let aspect = Math.SQRT2;
    const r0 = region(0, 'front', 0, 0);
    if (r0) {
      const info = pdf.info[r0.index]!;
      const size = physicalSize(info, info.crop);
      aspect = (r0.rect.h * size.h) / (r0.rect.w * size.w);
    }
    const key = (r: { index: number; rect: Rect }, turn: number) =>
      `${r.index}:${r.rect.x}:${r.rect.y}:${r.rect.w}:${r.rect.h}:${turn}`;
    return {
      art: (sheet, side, col, row) => {
        const r = region(sheet, side, col, row);
        return r ? cached(key(r, r.turn), r.index, r.rect, r.turn) : null;
      },
      reading: (pos) => {
        const at = byPos.get(pos);
        if (!at) return null;
        const r = region(at.sheet, at.side, at.slot.col, at.slot.row);
        if (!r) return null;
        const turn = (r.turn + at.slot.rotation) % 360;
        return cached(key(r, turn), r.index, r.rect, turn);
      },
      sourcePage: () => null,
      version,
      aspect,
      rendered,
      total: pdf.info.length,
    };
  }, [pdf, plan, imposed, pageOrder, version, rendered]);
}
