import { CanvasTexture, SRGBColorSpace } from 'three';
import type { Slot } from '../engine';

/** A distinct, print-friendly hue per sheet so sheets can be told apart in 3D. */
export const sheetHue = (sheet: number) => (sheet * 137.508 + 20) % 360;

/**
 * Placeholder page artwork: the page number drawn upright in the finished piece (i.e. rotated by
 * the slot's rotation on the sheet), framed in the sheet's colour. PDF thumbnails replace this later.
 */
export function faceTexture(
  slot: Slot | undefined,
  sheet: number,
  sideLabel: string,
  aspect: number,
): CanvasTexture {
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
