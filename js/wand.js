// Magic wand: pick the part of the photo you mean by clicking it.
//
// Scanline flood fill over the colour distance from the clicked pixel. Fast
// enough to feel instant at full resolution, and the usual way people outline
// an object without tracing it by hand.

/**
 * @param {ImageData} image source pixels
 * @param {number} seedX
 * @param {number} seedY
 * @param {object} options
 * @param {number} options.tolerance 0-100
 * @param {boolean} options.contiguous only the connected region, or every matching pixel
 * @returns {Uint8ClampedArray} 8-bit stamp, 255 where matched
 */
export function magicWand(image, seedX, seedY, { tolerance = 15, contiguous = true } = {}) {
  const { width: w, height: h, data: px } = image;
  const out = new Uint8ClampedArray(w * h);
  const sx = Math.max(0, Math.min(w - 1, Math.round(seedX)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(seedY)));

  const seed = (sy * w + sx) * 4;
  const sr = px[seed];
  const sg = px[seed + 1];
  const sb = px[seed + 2];
  const sa = px[seed + 3];

  // Compare in squared distance over RGBA, scaled so the slider feels linear.
  const limit = (tolerance / 100) * (tolerance / 100) * 4 * 255 * 255;

  const matches = (i) => {
    const dr = px[i] - sr;
    const dg = px[i + 1] - sg;
    const db = px[i + 2] - sb;
    const da = px[i + 3] - sa;
    return dr * dr + dg * dg + db * db + da * da <= limit;
  };

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (matches(p * 4)) out[p] = 255;
    return out;
  }

  // Scanline fill: push spans rather than individual pixels.
  const visited = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  while (stack.length) {
    const [px0, py] = stack.pop();
    if (py < 0 || py >= h) continue;
    const row = py * w;
    let left = px0;
    while (left > 0 && !visited[row + left - 1] && matches((row + left - 1) * 4)) left--;
    let right = px0;
    while (right < w - 1 && !visited[row + right + 1] && matches((row + right + 1) * 4)) right++;

    for (let x = left; x <= right; x++) {
      visited[row + x] = 1;
      out[row + x] = 255;
    }
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      for (let x = left; x <= right; x++) {
        if (!visited[nrow + x] && matches((nrow + x) * 4)) {
          stack.push([x, ny]);
          // Skip ahead over the rest of this matching run.
          while (x < right && !visited[nrow + x + 1] && matches((nrow + x + 1) * 4)) x++;
        }
      }
    }
  }
  return out;
}

/**
 * Antialias a hard-edged wand result by one pixel, so the cut-out does not
 * look like it was made with scissors.
 */
export function softenEdge(stamp, w, h, amount = 1) {
  if (amount <= 0) return stamp;
  const out = new Uint8ClampedArray(stamp);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!stamp[i]) continue;
      let neighbours = 0;
      let on = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          neighbours++;
          if (stamp[ny * w + nx]) on++;
        }
      }
      if (on < neighbours) out[i] = Math.round(255 * (on / neighbours));
    }
  }
  return out;
}
