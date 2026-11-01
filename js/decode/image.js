// Turn a dropped File into pixels, whatever format it arrived in.

import { makeCanvas } from '../util.js';
import { decodeTiff, isTiff } from './tiff.js';

export const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'];

const MAX_PIXELS = 64_000_000; // ~8000x8000; guards against exhausting memory.

/** Sniff the real format from the file's magic bytes, not its name. */
function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'WEBP';
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (be || le) return 'TIFF';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'BMP';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'GIF';
  return 'UNKNOWN';
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{canvas:HTMLCanvasElement, width:number, height:number, name:string, meta:object}>}
 */
export async function loadImageFile(file) {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(32, buffer.byteLength));
  const kind = sniff(head);
  const name = file.name || 'image';

  if (kind === 'UNKNOWN') {
    throw new Error(`“${name}” does not look like an image file. Shapeshifter reads JPEG, PNG, TIFF and WebP.`);
  }

  if (kind === 'TIFF' || isTiff(buffer)) {
    const { width, height, data, meta } = await decodeTiff(buffer);
    guardSize(width, height);
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
    return { canvas, width, height, name, meta: { ...meta, bytes: file.size } };
  }

  // Everything else the browser can decode itself.
  const bitmap = await decodeNative(file, name, kind);
  guardSize(bitmap.width, bitmap.height);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    name,
    meta: { format: kind, bitDepth: 8, channels: kind === 'JPEG' ? 3 : 4, bytes: file.size },
  };
}

async function decodeNative(file, name, kind) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not decode “${name}” as ${kind}. The file may be damaged.`));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function guardSize(width, height) {
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `That image is ${width}x${height} (${(width * height / 1e6).toFixed(0)} megapixels), which is larger than Shapeshifter can edit in the browser. Scale it down below ${MAX_PIXELS / 1e6} megapixels and try again.`,
    );
  }
}
