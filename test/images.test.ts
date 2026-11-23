import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { MM } from '../src/pdf/geometry';
import {
  imagePageSize,
  imagesToPdf,
  imageType,
  jpegOrientation,
  naturalCompare,
  orientationMatrix,
  placeImage,
  shownSize,
  type SourceImage,
} from '../src/pdf/images';
import { loadPdf, pageInfo } from '../src/pdf/pdfFiles';
import { png } from './helpers/png';

/** A 6 × 4 baseline JPEG (no EXIF orientation). */
const JPEG = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABqADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAGAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8AvaD4R0PyP9T29v8ACt//AIRLQ/8Anj/n8qm0H/UfhXQVx4jEVfaS99/edeT4ut9Tpe+9u7P/2Q==',
    'base64',
  ),
);

/** `jpeg` with an EXIF APP1 segment setting orientation `o` (little- or big-endian TIFF). */
function withOrientation(jpeg: Uint8Array, o: number, le = false): Uint8Array {
  const tiff = Buffer.alloc(26);
  if (le) {
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(o, 18);
  } else {
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(o, 18);
  }
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]));
}

/** The `cm` matrix each page draws its image with, and the image's stored size. */
async function drawnImages(bytes: Uint8Array) {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((p) => {
    const contents = p.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r))
        : [contents];
    const text = streams
      .map((s) => new TextDecoder().decode(decodePDFRawStream(s as PDFRawStream).decode()))
      .join('\n');
    const cm = /([-\d.e ]+) cm/.exec(text)![1]!.trim().split(/\s+/).map(Number);
    const xobjects = p.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const ref = xobjects.values()[0] as PDFRef;
    const img = doc.context.lookup(ref) as PDFRawStream;
    const num = (k: string) => Number(img.dict.get(PDFName.of(k))!.toString());
    return {
      cm,
      stored: { w: num('Width'), h: num('Height') },
      filter: String(img.dict.get(PDFName.of('Filter'))),
    };
  });
}

describe('images as book pages', () => {
  it('sorts file names naturally', () => {
    const names = ['img10.png', 'IMG2.png', 'img1.png', 'img2b.png', 'cover.jpg'];
    expect([...names].sort(naturalCompare)).toEqual([
      'cover.jpg',
      'img1.png',
      'IMG2.png',
      'img2b.png',
      'img10.png',
    ]);
  });

  it('recognises PNG and JPEG by their bytes', () => {
    expect(imageType(png(2, 2))).toBe('png');
    expect(imageType(JPEG)).toBe('jpg');
    expect(imageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(imageType(new Uint8Array())).toBeNull();
  });

  it('reads the EXIF orientation of a JPEG', () => {
    expect(jpegOrientation(JPEG)).toBe(1);
    for (const o of [1, 3, 6, 8]) {
      expect(jpegOrientation(withOrientation(JPEG, o))).toBe(o);
      expect(jpegOrientation(withOrientation(JPEG, o, true))).toBe(o);
    }
    expect(jpegOrientation(withOrientation(JPEG, 42))).toBe(1);
    expect(shownSize({ w: 6, h: 4 }, 6)).toEqual({ w: 4, h: 6 });
    expect(shownSize({ w: 6, h: 4 }, 3)).toEqual({ w: 6, h: 4 });
  });

  it('maps the stored image onto the page as shown, for every orientation', () => {
    const r = { x: 10, y: 20, w: 30, h: 40 };
    // Where the stored image's top-left pixel (unit square (0, 1)) lands, as shown.
    const topLeft = (o: number) => {
      const [a, b, c, d, e, f] = orientationMatrix(o, r);
      return [a * 0 + c * 1 + e, b * 0 + d * 1 + f];
    };
    const [L, R, B, T] = [10, 40, 20, 60];
    expect(topLeft(1)).toEqual([L, T]);
    expect(topLeft(2)).toEqual([R, T]); // mirrored
    expect(topLeft(3)).toEqual([R, B]); // half turn
    expect(topLeft(4)).toEqual([L, B]); // flipped
    expect(topLeft(5)).toEqual([L, T]); // transposed
    expect(topLeft(6)).toEqual([R, T]); // a quarter clockwise
    expect(topLeft(7)).toEqual([R, B]);
    expect(topLeft(8)).toEqual([L, B]); // a quarter anticlockwise
    // Every orientation covers exactly the rectangle.
    for (let o = 1; o <= 8; o++) {
      const [a, b, c, d, e, f] = orientationMatrix(o, r);
      const xs = [0, 1].flatMap((u) => [0, 1].map((v) => a * u + c * v + e));
      const ys = [0, 1].flatMap((u) => [0, 1].map((v) => b * u + d * v + f));
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([
        L,
        R,
        B,
        T,
      ]);
    }
  });

  it('sizes the page like the first image, or as a chosen paper size', () => {
    const long = 210 * MM;
    expect(imagePageSize({ w: 4000, h: 3000 }, { kind: 'image' })).toEqual({
      w: long,
      h: long * 0.75,
    });
    expect(imagePageSize({ w: 3000, h: 4000 }, { kind: 'image' })).toEqual({
      w: long * 0.75,
      h: long,
    });
    const a5 = imagePageSize(null, { kind: 'preset', id: 'a5', orientation: 'portrait' });
    expect(a5.w).toBeCloseTo(148 * MM, 6);
    expect(a5.h).toBeCloseTo(210 * MM, 6);
    const a4l = imagePageSize(null, { kind: 'preset', id: 'a4', orientation: 'landscape' });
    expect(a4l.w).toBeCloseTo(297 * MM, 6);
    expect(a4l.h).toBeCloseTo(210 * MM, 6);
  });

  it('places an image whole (fit) or covering the page (fill), centred', () => {
    const page = { w: 100, h: 200 };
    // A landscape image on a portrait page.
    expect(placeImage({ w: 400, h: 200 }, page, 'fit')).toEqual({ x: 0, y: 75, w: 100, h: 50 });
    expect(placeImage({ w: 400, h: 200 }, page, 'fill')).toEqual({
      x: -150,
      y: 0,
      w: 400,
      h: 200,
    });
    // A tall image: fit leaves margins at the sides.
    expect(placeImage({ w: 100, h: 400 }, page, 'fit')).toEqual({ x: 25, y: 0, w: 50, h: 200 });
    expect(placeImage({ w: 100, h: 400 }, page, 'fill')).toEqual({
      x: 0,
      y: -100,
      w: 100,
      h: 400,
    });
    // The same shape: both fill the page exactly.
    expect(placeImage({ w: 1, h: 2 }, page, 'fit')).toEqual({ x: 0, y: 0, w: 100, h: 200 });
  });

  it('builds one page per image, all one size, images at full resolution', async () => {
    const images: SourceImage[] = [
      { name: 'a.png', type: 'png', bytes: png(300, 200) },
      { name: 'b.jpg', type: 'jpg', bytes: JPEG },
      { name: 'c.png', type: 'png', bytes: png(100, 400) },
      { name: 'd.jpg', type: 'jpg', bytes: withOrientation(JPEG, 6) },
    ];
    const bytes = await imagesToPdf(images, { size: { kind: 'image' }, fit: 'fit' }, 'Test');
    const info = pageInfo(await loadPdf(bytes));
    expect(info).toHaveLength(4);
    // Shaped like the first image (3 : 2), its long side 210 mm.
    const W = 210 * MM;
    const H = (210 * MM * 2) / 3;
    for (const p of info) {
      expect(p.crop.w).toBeCloseTo(W, 6);
      expect(p.crop.h).toBeCloseTo(H, 6);
    }
    const drawn = await drawnImages(bytes);
    // Never downsampled; JPEG kept as JPEG.
    expect(drawn.map((d) => d.stored)).toEqual([
      { w: 300, h: 200 },
      { w: 6, h: 4 },
      { w: 100, h: 400 },
      { w: 6, h: 4 },
    ]);
    expect(drawn[1]!.filter).toBe('/DCTDecode');
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 3));
    near(drawn[0]!.cm, [W, 0, 0, H, 0, 0]);
    // 6 × 4 in a 3 : 2 page: the same shape, edge to edge.
    near(drawn[1]!.cm, [W, 0, 0, H, 0, 0]);
    // 1 × 4, fitted: full height, centred.
    const w4 = H / 4;
    near(drawn[2]!.cm, [w4, 0, 0, H, (W - w4) / 2, 0]);
    // Stored 6 × 4 shown turned a quarter (4 × 6): full height, centred, drawn turned.
    const w6 = (H * 4) / 6;
    near(drawn[3]!.cm, [0, -H, w6, 0, (W - w6) / 2, H]);
  });

  it('builds pages of a chosen size, filling them', async () => {
    const bytes = await imagesToPdf([{ name: 'wide.png', type: 'png', bytes: png(400, 100) }], {
      size: { kind: 'preset', id: 'a5', orientation: 'portrait' },
      fit: 'fill',
    });
    const [p] = pageInfo(await loadPdf(bytes));
    expect(p!.crop.w).toBeCloseTo(148 * MM, 6);
    expect(p!.crop.h).toBeCloseTo(210 * MM, 6);
    const [d] = await drawnImages(bytes);
    const H = 210 * MM;
    const w = H * 4;
    // Full height, the sides cropped by the page edge.
    [w, 0, 0, H, (148 * MM - w) / 2, 0].forEach((v, i) => expect(d!.cm[i]).toBeCloseTo(v, 3));
  });

  it('names the image it cannot read', async () => {
    await expect(
      imagesToPdf(
        [{ name: 'broken.jpg', type: 'jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]) }],
        {
          size: { kind: 'image' },
          fit: 'fit',
        },
      ),
    ).rejects.toThrow(/broken\.jpg/);
    await expect(imagesToPdf([], { size: { kind: 'image' }, fit: 'fit' })).rejects.toThrow();
  });
});
