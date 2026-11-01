// The selection mask: one 8-bit alpha value per image pixel.
//
// Every outline tool, however it is drawn, ends up stamped into this single
// buffer. That is what lets a freehand lasso, a polygon, a magic wand and a
// brush all be combined into one arbitrary shape, and it is exactly the alpha
// channel the exported file receives.

import { clamp, makeCanvas } from './util.js';

export const COMBINE = {
  REPLACE: 'replace',
  ADD: 'add',
  SUBTRACT: 'subtract',
  INTERSECT: 'intersect',
};

export class Mask {
  constructor(width, height, data = null) {
    this.width = width;
    this.height = height;
    this.data = data || new Uint8ClampedArray(width * height);
  }

  static from(mask) {
    return new Mask(mask.width, mask.height, new Uint8ClampedArray(mask.data));
  }

  clone() {
    return Mask.from(this);
  }

  get length() {
    return this.data.length;
  }

  copyFrom(other) {
    this.data.set(other.data);
    return this;
  }

  clear() {
    this.data.fill(0);
    return this;
  }

  fillAll() {
    this.data.fill(255);
    return this;
  }

  isEmpty() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i] > 2) return false;
    return true;
  }

  /** Number of fully-or-partly selected pixels, and coverage in whole pixels. */
  stats() {
    const d = this.data;
    let touched = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] > 2) {
        touched++;
        sum += d[i];
      }
    }
    return { touched, coverage: sum / 255 };
  }

  /** Tight bounding box of everything above `threshold`, or null if empty. */
  bbox(threshold = 2) {
    const { width: w, height: h, data: d } = this;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[row + x] > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  invert() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return this;
  }

  /**
   * Merge an 8-bit stamp (same dimensions) into this mask.
   * This is where "add to selection" / "subtract from selection" live.
   */
  combine(stamp, mode = COMBINE.REPLACE) {
    const a = this.data;
    const b = stamp;
    switch (mode) {
      case COMBINE.ADD:
        for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
        break;
      case COMBINE.SUBTRACT:
        for (let i = 0; i < a.length; i++) if (b[i]) a[i] = (a[i] * (255 - b[i])) / 255;
        break;
      case COMBINE.INTERSECT:
        for (let i = 0; i < a.length; i++) a[i] = (a[i] * b[i]) / 255;
        break;
      default:
        a.set(b);
    }
    return this;
  }

  /**
   * Run an expensive whole-buffer operation over only the part of the image
   * the selection can reach: its bounding box grown by `margin`. Outside that
   * the mask is empty and stays empty, so the result is identical to running
   * over the whole image — just proportionally faster on a big photo with a
   * small selection.
   */
  #inRegion(margin, operate) {
    const { width: w, height: h, data } = this;
    const box = this.bbox(0);
    if (!box) return this;

    const x0 = Math.max(0, box.x - margin);
    const y0 = Math.max(0, box.y - margin);
    const x1 = Math.min(w, box.x + box.width + margin);
    const y1 = Math.min(h, box.y + box.height + margin);
    const sw = x1 - x0;
    const sh = y1 - y0;

    if (sw === w && sh === h) {
      operate(data, w, h);
      return this;
    }

    const sub = new Uint8ClampedArray(sw * sh);
    for (let y = 0; y < sh; y++) sub.set(data.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * sw);
    operate(sub, sw, sh);
    data.fill(0);
    for (let y = 0; y < sh; y++) data.set(sub.subarray(y * sw, (y + 1) * sw), (y0 + y) * w + x0);
    return this;
  }

  /** Separable box blur, run three times — a fast, very close Gaussian. */
  feather(radius) {
    const r = Math.round(radius);
    if (r < 1) return this;
    // Three box passes of radius r reach at most 3r+1 pixels.
    return this.#inRegion(3 * r + 2, (data, w, h) => {
      const tmp = new Uint8ClampedArray(data.length);
      for (let pass = 0; pass < 3; pass++) {
        boxBlurH(data, tmp, w, h, r);
        boxBlurV(tmp, data, w, h, r);
      }
    });
  }

  /**
   * Grow (r > 0) or shrink (r < 0) the selection by r pixels, measured as true
   * Euclidean distance so corners stay round instead of turning into squares.
   * Keeps a one-pixel soft edge so the result still antialiases.
   */
  offset(r) {
    const amount = Math.round(r);
    if (amount === 0) return this;
    // Growing reaches at most `amount` pixels beyond the current edge.
    return this.#inRegion(Math.abs(amount) + 2, (d, w, h) => {
      const n = d.length;
      const inside = new Float32Array(n);
      const outside = new Float32Array(n);
      const INF = 1e20;
      for (let i = 0; i < n; i++) {
        const on = d[i] >= 128;
        inside[i] = on ? INF : 0;
        outside[i] = on ? 0 : INF;
      }
      edt(inside, w, h);
      edt(outside, w, h);

      for (let i = 0; i < n; i++) {
        // Signed distance: positive inside the selection, negative outside.
        const signed = d[i] >= 128 ? Math.sqrt(inside[i]) : -Math.sqrt(outside[i]);
        d[i] = clamp((signed + amount + 0.5) * 255, 0, 255);
      }
    });
  }

  /** Discard partial coverage — every pixel becomes fully in or fully out. */
  harden(threshold = 128) {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = d[i] >= threshold ? 255 : 0;
    return this;
  }

  /** Rasterize a Path2D (in image coordinates) into a fresh 8-bit stamp. */
  rasterizePath(path, { evenOdd = false } = {}) {
    const { width: w, height: h } = this;
    const canvas = scratch(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.fill(path, evenOdd ? 'evenodd' : 'nonzero');
    return alphaOf(ctx.getImageData(0, 0, w, h).data, w * h);
  }

  /** Rasterize a stroked Path2D (used by the brush) into a fresh 8-bit stamp. */
  rasterizeStroke(path, width) {
    const { width: w, height: h } = this;
    const canvas = scratch(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, width);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
    return alphaOf(ctx.getImageData(0, 0, w, h).data, w * h);
  }

  /** The mask as an RGBA ImageData, white where selected (for debugging/overlay). */
  toImageData() {
    const out = new ImageData(this.width, this.height);
    const px = out.data;
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      px[i * 4] = 255;
      px[i * 4 + 1] = 255;
      px[i * 4 + 2] = 255;
      px[i * 4 + 3] = d[i];
    }
    return out;
  }
}

function alphaOf(rgba, count) {
  const out = new Uint8ClampedArray(count);
  for (let i = 0; i < count; i++) out[i] = rgba[i * 4 + 3];
  return out;
}

let scratchCanvas = null;
/** One reusable offscreen canvas, so dragging a lasso does not churn memory. */
function scratch(w, h) {
  if (!scratchCanvas) scratchCanvas = makeCanvas(w, h);
  if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas.width = w;
    scratchCanvas.height = h;
  }
  return scratchCanvas;
}

function boxBlurH(src, dst, w, h, r) {
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = src[row] * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[row + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / span;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const span = r * 2 + 1;
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1);
    for (let i = 1; i <= r; i++) sum += src[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / span;
      sum += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
    }
  }
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher),
 * run as two 1-D passes. Input holds 0 at seed pixels and a large value
 * elsewhere; output holds squared distance to the nearest seed.
 */
function edt(f, w, h) {
  const maxDim = Math.max(w, h);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  // The 1-D passes keep full precision; only the stored grids are Float32.

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) d[y] = f[y * w + x];
    edt1d(d, h, v, z);
    for (let y = 0; y < h; y++) f[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) d[x] = f[row + x];
    edt1d(d, w, v, z);
    for (let x = 0; x < w; x++) f[row + x] = d[x];
  }
}

function edt1d(d, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (d[q] + q * q - (d[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (d[q] + q * q - (d[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  const src = d.slice(0, n);
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + src[v[k]];
  }
}
