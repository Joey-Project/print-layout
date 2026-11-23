/**
 * Opening single images as book pages: each file becomes a PNG or JPEG to embed (other formats are
 * converted to PNG through a canvas, at their full size), then `imagesToPdf` builds an in-memory
 * pages PDF that loads like any other.
 */
import type { ImagePageOptions, SourceImage } from '../pdf/images';
import type { LoadedPdf } from './pdfArt';

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** Decode any image the browser can show and re-encode it as PNG, pixel for pixel. */
async function toPng(file: File): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error(`${file.name} is not an image this browser can read.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    if (!canvas.width || !canvas.height) throw new Error(`${file.name} has no size.`);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`${file.name} is too large to convert.`);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error(`${file.name} is too large to convert.`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file as PNG or JPEG bytes: as it is when it already is one, else converted. */
export async function readImage(file: File): Promise<SourceImage> {
  const [{ imageType }, bytes] = await Promise.all([
    import('../pdf/images'),
    file.arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  const type = imageType(bytes);
  if (type) return { name: file.name, type, bytes };
  return { name: file.name, type: 'png', bytes: await toPng(file) };
}

/** A name for the pages: the image's own, or the first and last of several. */
const nameOf = (list: SourceImage[]) =>
  list.length === 1 ? stem(list[0]!.name) : `${stem(list[0]!.name)}–${stem(list.at(-1)!.name)}`;

/** Build (or rebuild) the pages PDF from images already read, and load it like a pages PDF. */
export async function imagesPdf(
  list: SourceImage[],
  options: ImagePageOptions,
): Promise<LoadedPdf> {
  const [{ imagesToPdf }, { loadPdf, pageInfo }, { openPdfJs }] = await Promise.all([
    import('../pdf/images'),
    import('../pdf/pdfFiles'),
    import('../pdf/render'),
  ]);
  const name = nameOf(list);
  const bytes = await imagesToPdf(list, options, name);
  const info = pageInfo(await loadPdf(bytes));
  return {
    name,
    bytes,
    info,
    js: await openPdfJs(bytes),
    mode: 'reading',
    images: { list, options },
  };
}

/** Open several image files as pages, one each, in file-name order (natural: "2" before "10"). */
export async function openImageFiles(
  files: readonly File[],
  options: ImagePageOptions,
): Promise<LoadedPdf> {
  if (files.length === 0) throw new Error('No images chosen.');
  const { naturalCompare } = await import('../pdf/images');
  const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
  const list: SourceImage[] = [];
  for (const f of sorted) list.push(await readImage(f));
  return imagesPdf(list, options);
}
