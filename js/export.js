// Export the outlined region as a file whose shape *is* the outline.
//
// The trick the whole program rests on: a raster file is always a rectangle of
// pixels, but pixels outside the outline are written fully transparent and the
// rectangle is cropped tight to the outline's bounding box. Opened anywhere
// that respects alpha — Preview, Photoshop, a browser, Figma, Keynote — the
// image reads as the shape that was drawn, not as a square.
//
// SVG goes further: the traced outline is written as a real vector <clipPath>,
// so the shape stays crisp at any size and can be edited as a path.

import { canvasToBlob, makeCanvas } from './util.js';
import { contoursToPathData, traceContours } from './contour.js';

export const FORMATS = {
  png: { label: 'PNG', ext: 'png', mime: 'image/png', alpha: true, quality: false,
    note: 'Lossless with real transparency. The safest choice — opens as the drawn shape everywhere.' },
  webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', alpha: true, quality: true,
    note: 'Transparent and much smaller than PNG. Supported by every current browser and OS.' },
  svg: { label: 'SVG', ext: 'svg', mime: 'image/svg+xml', alpha: true, quality: true,
    note: 'The outline becomes an editable vector clip path, so the shape scales without softening.' },
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', alpha: false, quality: true,
    note: 'JPEG cannot store transparency, so everything outside the outline is filled with the matte colour.' },
  mask: { label: 'Mask only (PNG)', ext: 'mask.png', mime: 'image/png', alpha: true, quality: false,
    note: 'The shape itself as a white-on-transparent stencil, for reuse in other tools.' },
};

/**
 * @typedef {object} ExportOptions
 * @property {keyof FORMATS} format
 * @property {number} scale           output scale multiplier (1 = original pixels)
 * @property {number} padding         transparent margin around the shape, in source pixels
 * @property {number} quality         0-1, for WebP/JPEG
 * @property {string|null} matte      fill behind the shape, or null to keep it transparent
 * @property {number} outlineWidth    stroke drawn along the shape's edge, in source pixels
 * @property {string} outlineColor
 * @property {boolean} trim           crop to the shape's bounding box (otherwise keep the full canvas)
 */

export const DEFAULT_OPTIONS = {
  format: 'png',
  scale: 1,
  padding: 0,
  quality: 0.92,
  matte: null,
  outlineWidth: 0,
  outlineColor: '#ffffff',
  trim: true,
};

/** The pixel region the export will cover, before scaling. */
export function exportRegion(mask, { padding = 0, trim = true } = {}) {
  if (!trim) return { x: 0, y: 0, width: mask.width, height: mask.height };
  const box = mask.bbox(0);
  if (!box) return null;
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  return {
    x,
    y,
    width: Math.min(mask.width, box.x + box.width + padding) - x,
    height: Math.min(mask.height, box.y + box.height + padding) - y,
  };
}

/**
 * Compose the cut-out onto a canvas at export size.
 * @returns {{canvas:HTMLCanvasElement, region:object}}
 */
export function composeCutout(source, mask, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const region = exportRegion(mask, opts);
  if (!region) throw new Error('Nothing is selected, so there is no shape to export.');

  const outWidth = Math.max(1, Math.round(region.width * opts.scale));
  const outHeight = Math.max(1, Math.round(region.height * opts.scale));

  // The mask, cropped and scaled to the output size, as an alpha stencil.
  const stencil = makeCanvas(outWidth, outHeight);
  {
    const full = makeCanvas(mask.width, mask.height);
    full.getContext('2d').putImageData(mask.toImageData(), 0, 0);
    const ctx = stencil.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, region.x, region.y, region.width, region.height, 0, 0, outWidth, outHeight);
  }

  // The photo, cropped and scaled the same way, then cut to the stencil.
  const cut = makeCanvas(outWidth, outHeight);
  {
    const ctx = cut.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, outWidth, outHeight);
    // Keep only what the stencil covers. This is the cut.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(stencil, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  if (opts.format === 'mask') return { canvas: stencil, region };

  const out = makeCanvas(outWidth, outHeight);
  const ctx = out.getContext('2d');

  // A matte is required for formats without alpha, optional elsewhere.
  const needsMatte = !FORMATS[opts.format]?.alpha;
  const matte = opts.matte || (needsMatte ? '#ffffff' : null);
  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, outWidth, outHeight);
    // Outside the shape stays matte-only; inside gets the photo.
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(cut, 0, 0);
    if (!needsMatte) {
      // Trim the matte back to the shape so the file is still shaped, just
      // with a solid fill behind any soft or semi-transparent pixels.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(stencil, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
  } else {
    ctx.drawImage(cut, 0, 0);
  }

  if (opts.outlineWidth > 0) {
    const loops = traceContours(mask, { tolerance: 0.4 });
    ctx.save();
    ctx.translate(-region.x * opts.scale, -region.y * opts.scale);
    ctx.scale(opts.scale, opts.scale);
    ctx.strokeStyle = opts.outlineColor;
    ctx.lineWidth = opts.outlineWidth;
    ctx.lineJoin = 'round';
    for (const loop of loops) {
      ctx.beginPath();
      ctx.moveTo(loop[0].x, loop[0].y);
      for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  return { canvas: out, region };
}

/**
 * Produce the finished file.
 * @returns {Promise<{blob:Blob, filename:string, width:number, height:number, region:object}>}
 */
export async function exportCutout(source, mask, stem = 'cutout', options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const spec = FORMATS[opts.format];
  if (!spec) throw new Error(`Unknown export format: ${opts.format}`);

  if (opts.format === 'svg') {
    const svg = await buildSvg(source, mask, opts);
    const region = exportRegion(mask, opts);
    return {
      blob: new Blob([svg], { type: 'image/svg+xml' }),
      filename: `${stem}-shape.svg`,
      width: Math.round(region.width * opts.scale),
      height: Math.round(region.height * opts.scale),
      region,
    };
  }

  const { canvas, region } = composeCutout(source, mask, opts);
  const blob = await canvasToBlob(canvas, spec.mime, spec.quality ? opts.quality : undefined);
  const suffix = opts.format === 'mask' ? '' : '-shape';
  return {
    blob,
    filename: `${stem}${suffix}.${spec.ext}`,
    width: canvas.width,
    height: canvas.height,
    region,
  };
}

/**
 * SVG carrying both a raster payload already cut to the shape *and* a vector
 * clip path traced from the same outline. Renderers that honour clip paths get
 * a crisp, scalable edge; everything else still sees the shaped alpha.
 */
async function buildSvg(source, mask, opts) {
  const region = exportRegion(mask, opts);
  if (!region) throw new Error('Nothing is selected, so there is no shape to export.');

  const width = Math.max(1, Math.round(region.width * opts.scale));
  const height = Math.max(1, Math.round(region.height * opts.scale));

  const { canvas } = composeCutout(source, mask, { ...opts, format: 'png', outlineWidth: 0 });
  // WebP keeps embedded SVG payloads reasonable; PNG is the safe fallback.
  let href;
  try {
    const blob = await canvasToBlob(canvas, 'image/webp', opts.quality);
    const pngBlob = await canvasToBlob(canvas, 'image/png');
    href = await blobToDataUrl(blob.size < pngBlob.size ? blob : pngBlob);
  } catch {
    href = await blobToDataUrl(await canvasToBlob(canvas, 'image/png'));
  }

  const loops = traceContours(mask, { tolerance: 0.5 });
  const d = contoursToPathData(loops, { offsetX: region.x, offsetY: region.y, scale: opts.scale });
  const id = `shape-${Math.random().toString(36).slice(2, 8)}`;

  const outline = opts.outlineWidth > 0
    ? `\n  <path d="${d}" fill="none" stroke="${escapeAttr(opts.outlineColor)}" stroke-width="${opts.outlineWidth * opts.scale}" stroke-linejoin="round" clip-path="url(#${id})"/>`
    : '';
  const matte = opts.matte
    ? `\n  <path d="${d}" fill="${escapeAttr(opts.matte)}" fill-rule="evenodd"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>Cut-out shape</title>
  <desc>Exported by Shapeshifter. The visible area is bounded by the traced outline below.</desc>
  <defs>
    <clipPath id="${id}" clip-rule="evenodd">
      <path d="${d}"/>
    </clipPath>
  </defs>${matte}
  <g clip-path="url(#${id})">
    <image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"
           image-rendering="auto" xlink:href="${href}" href="${href}"/>
  </g>${outline}
</svg>
`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not embed the image into the SVG.'));
    reader.readAsDataURL(blob);
  });
}

function escapeAttr(value) {
  return String(value).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
