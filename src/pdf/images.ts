/**
 * Single images as book pages: an in-memory reading-order PDF with one image per page, built with
 * pdf-lib, which the app then loads like any pages PDF (2D sheets, 3D model, page order, export).
 *
 * PNG and JPEG bytes are embedded as they are, at full resolution (JPEG is not even re-encoded);
 * other formats are converted to PNG by the browser first (`src/ui/imageFiles.ts`). Every page has
 * the same size, as the exporter expects; each image is fitted into it or fills it.
 */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { MM, PAGE_SIZES, type Rect } from './geometry';

/** An image ready to embed: PNG or JPEG bytes. */
export interface SourceImage {
  /** File name, with its extension. */
  name: string;
  type: 'png' | 'jpg';
  bytes: Uint8Array;
}

export type ImageFit = 'fit' | 'fill';

export type ImagePageSize =
  /** The first image's shape, its long side `IMAGE_LONG_SIDE_MM`. */
  | { kind: 'image' }
  /** One of `PAGE_SIZES`, upright or turned. */
  | { kind: 'preset'; id: string; orientation: 'portrait' | 'landscape' };

export interface ImagePageOptions {
  size: ImagePageSize;
  /** 'fit': the whole image, white margins. 'fill': cropped to cover the page. */
  fit: ImageFit;
}

export const DEFAULT_IMAGE_PAGES: ImagePageOptions = { size: { kind: 'image' }, fit: 'fit' };

/** Long side of a page shaped like the first image (A5's height). */
export const IMAGE_LONG_SIDE_MM = 210;

/** File names in natural order: "2" before "10", case and accents ignored. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : 1);

/** PNG or JPEG from the first bytes (the extension can lie); null for anything else. */
export function imageType(bytes: Uint8Array): SourceImage['type'] | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpg';
  return null;
}

/**
 * The EXIF orientation of a JPEG (1–8; 1 = as stored), which cameras and phones set instead of
 * turning the pixels. Browsers apply it when showing the image, so the page must too.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const u16 = (i: number, le: boolean) =>
    le ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
  const u32 = (i: number, le: boolean) =>
    le
      ? (u16(i, true) | (u16(i + 2, true) << 16)) >>> 0
      : ((u16(i, false) << 16) | u16(i + 2, false)) >>> 0;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // image data: no more headers
    const len = u16(i + 2, false);
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
    if (marker === 0xe1 && exif.every((b, k) => bytes[i + 4 + k] === b)) {
      const tiff = i + 10;
      const le = bytes[tiff] === 0x49; // "II": little-endian, "MM": big-endian
      const ifd = tiff + u32(tiff + 4, le);
      if (ifd + 2 > bytes.length) return 1;
      const count = u16(ifd, le);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > bytes.length) break;
        if (u16(e, le) === 0x0112) {
          const o = u16(e + 8, le);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Size as shown: orientations 5–8 turn the stored image a quarter. */
export const shownSize = (stored: { w: number; h: number }, orientation: number) =>
  orientation >= 5 ? { w: stored.h, h: stored.w } : stored;

/**
 * The matrix that draws an image XObject (the unit square, stored pixels) into `r` (points) as it
 * is shown after EXIF orientation `o`: flipped and/or turned a quarter or a half.
 */
export function orientationMatrix(
  o: number,
  r: Rect,
): [number, number, number, number, number, number] {
  const { x, y, w, h } = r;
  switch (o) {
    case 2:
      return [-w, 0, 0, h, x + w, y];
    case 3:
      return [-w, 0, 0, -h, x + w, y + h];
    case 4:
      return [w, 0, 0, -h, x, y + h];
    case 5:
      return [0, -h, -w, 0, x + w, y + h];
    case 6:
      return [0, -h, w, 0, x, y + h];
    case 7:
      return [0, h, w, 0, x, y];
    case 8:
      return [0, h, -w, 0, x + w, y];
    default:
      return [w, 0, 0, h, x, y];
  }
}

/** The finished page size (points) for these options, given the first image's shown size. */
export function imagePageSize(
  first: { w: number; h: number } | null,
  size: ImagePageSize,
): { w: number; h: number } {
  if (size.kind === 'preset') {
    const p = PAGE_SIZES.find((s) => s.id === size.id) ?? PAGE_SIZES[1]!;
    const [short, long] = [Math.min(p.w, p.h), Math.max(p.w, p.h)];
    return size.orientation === 'landscape'
      ? { w: long * MM, h: short * MM }
      : { w: short * MM, h: long * MM };
  }
  const long = IMAGE_LONG_SIDE_MM * MM;
  if (!first || first.w <= 0 || first.h <= 0) return { w: (148 / 210) * long, h: long };
  return first.w >= first.h
    ? { w: long, h: (long * first.h) / first.w }
    : { w: (long * first.w) / first.h, h: long };
}

/**
 * Where an image of shown size `img` goes on a page of size `page` (points, origin bottom left):
 * scaled uniformly and centred, the whole image inside ('fit') or covering the page ('fill', the
 * overflow cropped by the page edge — and kept as bleed).
 */
export function placeImage(
  img: { w: number; h: number },
  page: { w: number; h: number },
  fit: ImageFit,
): Rect {
  const sx = page.w / img.w;
  const sy = page.h / img.h;
  const s = fit === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = img.w * s;
  const h = img.h * s;
  return { x: (page.w - w) / 2, y: (page.h - h) / 2, w, h };
}

/** One page per image, in the given order, all the same size. */
export async function imagesToPdf(
  images: readonly SourceImage[],
  options: ImagePageOptions,
  title?: string,
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('No images to make pages from.');
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  doc.setCreator('Print Layout');
  doc.setProducer('Print Layout (pdf-lib)');
  let pageSize: { w: number; h: number } | null = null;
  for (const im of images) {
    let embedded;
    try {
      embedded = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    } catch (e) {
      throw new Error(`Could not read ${im.name}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
    const o = im.type === 'jpg' ? jpegOrientation(im.bytes) : 1;
    const shown = shownSize({ w: embedded.width, h: embedded.height }, o);
    pageSize ??= imagePageSize(shown, options.size);
    const page = doc.addPage([pageSize.w, pageSize.h]);
    const r = placeImage(shown, pageSize, options.fit);
    const name = page.node.newXObject('Image', embedded.ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...orientationMatrix(o, r)),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return doc.save();
}
