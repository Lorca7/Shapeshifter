// Save the traced object as a PNG whose shape is the outline.
//
// A picture file is always a rectangle of pixels, so "keeping the shape" means
// two things: crop the rectangle tight around the outline, and make every
// pixel outside the outline fully transparent. Opened anywhere that respects
// transparency, the file then reads as the shape you traced.
//
// The outline is applied as a clipping path at the photo's full resolution,
// so the edge is smooth and antialiased rather than a stair-step of pixels.

import { canvasToBlob, clamp, makeCanvas } from './util.js';

/** The whole-pixel rectangle that contains the outline, or null if there isn't one. */
export function cutoutRegion(points, photoWidth, photoHeight) {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = clamp(Math.floor(minX), 0, photoWidth);
  const y0 = clamp(Math.floor(minY), 0, photoHeight);
  const x1 = clamp(Math.ceil(maxX), 0, photoWidth);
  const y1 = clamp(Math.ceil(maxY), 0, photoHeight);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export async function exportCutout(photo, points, stem = 'photo') {
  const region = cutoutRegion(points, photo.width, photo.height);
  if (!region) throw new Error('Finish the outline first — it needs at least three points.');

  const canvas = makeCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d');
  ctx.translate(-region.x, -region.y);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(photo, 0, 0);

  return {
    blob: await canvasToBlob(canvas, 'image/png'),
    filename: `${stem}-cutout.png`,
    width: region.width,
    height: region.height,
  };
}
