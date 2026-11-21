import { CanvasTexture, SRGBColorSpace } from 'three';
import type { Slot } from '../engine';

/** A distinct, print-friendly hue per sheet so sheets can be told apart in 3D. */
export const sheetHue = (sheet: number) => (sheet * 137.508 + 20) % 360;

/**
 * Page artwork for one face of a panel, as printed on that sheet side. With `image` (from the
 * loaded PDF, already turned as printed) it is drawn edge to edge inside a thin frame in the
 * sheet's colour. Without it, a placeholder: the page number upright in the finished piece (i.e.
 * rotated by the slot's rotation on the sheet), framed in the sheet's colour.
 */
export function faceTexture(
  slot: Slot | undefined,
  sheet: number,
  sideLabel: string,
  aspect: number,
  image: CanvasImageSource | null = null,
): CanvasTexture {
  if (image) return imageTexture(image, sheet, aspect);
  const w = 256;
  const h = Math.round(w * aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const hue = sheetHue(sheet);

  const blank = !slot || slot.page === null;
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, w, h);
  if (blank) {
    ctx.strokeStyle = '#e4e0d6';
    ctx.lineWidth = 6;
    for (let x = -h; x < w; x += 18) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + h, h);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = `hsl(${hue} 55% 55%)`;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(((slot?.rotation ?? 0) * Math.PI) / 180);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = blank ? '#9b968c' : '#1d1c1a';
  ctx.font = blank ? '500 34px system-ui, sans-serif' : '700 120px system-ui, sans-serif';
  ctx.fillText(blank ? 'blank' : String(slot!.page), 0, -8);
  ctx.fillStyle = `hsl(${hue} 45% 40%)`;
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText(`Sheet ${sheet + 1} · ${sideLabel}`, 0, h / 2 - 34);
  ctx.restore();

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Paper for a fold strip: plain paper with the sheet's coloured frame continuing across the fold at
 * both ends, so the frames of the two joined pages read as one sheet. `length` is the fold's length
 * in panel widths (the frame is drawn at the same thickness as on the pages).
 */
export function seamTexture(sheet: number, length: number): CanvasTexture {
  // Pages are 256 px per panel width with a 10 px frame.
  const h = Math.round(256 * length);
  const band = 10;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, 4, h);
  ctx.fillStyle = `hsl(${sheetHue(sheet)} 55% 55%)`;
  ctx.fillRect(0, 0, 4, band);
  ctx.fillRect(0, h - band, 4, band);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function imageTexture(image: CanvasImageSource, sheet: number, aspect: number): CanvasTexture {
  const w = 384;
  const h = Math.round(w * aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  ctx.strokeStyle = `hsl(${sheetHue(sheet)} 55% 55%)`;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
