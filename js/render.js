// Canvas rendering.
//
// Compositing happens at viewport resolution rather than image resolution, so
// previewing the cut-out of a 40-megapixel photo costs a screen's worth of
// memory instead of a photo's worth.

import { contoursToPath2D, traceContours } from './contour.js';
import { makeCanvas } from './util.js';

export const PREVIEW_MODES = {
  dim: 'Dim outside',
  overlay: 'Tint selection',
  cutout: 'Cut-out preview',
  none: 'Photo only',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.frame = makeCanvas(1, 1);
    this.frameCtx = this.frame.getContext('2d');
    this.maskCanvas = null;
    this.antsPath = null;
    this.antsOffset = 0;
    this.checker = null;
    this.dpr = 1;
  }

  /** Match the backing store to the element's size and the device pixel ratio. */
  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.frame.width = w;
      this.frame.height = h;
    }
    this.cssWidth = width;
    this.cssHeight = height;
  }

  /** Rebuild the image-resolution alpha stencil. Call when the mask changes. */
  updateMask(mask) {
    if (!this.maskCanvas || this.maskCanvas.width !== mask.width || this.maskCanvas.height !== mask.height) {
      this.maskCanvas = makeCanvas(mask.width, mask.height);
    }
    this.maskCanvas.getContext('2d').putImageData(mask.toImageData(), 0, 0);
  }

  /**
   * Retrace the marching-ants outline. Large masks are traced at reduced
   * resolution for display only — exports always trace at full resolution.
   */
  updateContours(mask) {
    const pixels = mask.width * mask.height;
    let traced;
    if (pixels > 4_000_000) {
      const step = Math.ceil(Math.sqrt(pixels / 4_000_000));
      const sw = Math.ceil(mask.width / step);
      const sh = Math.ceil(mask.height / step);
      const small = { width: sw, height: sh, data: new Uint8ClampedArray(sw * sh) };
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          small.data[y * sw + x] = mask.data[Math.min(mask.height - 1, y * step) * mask.width + Math.min(mask.width - 1, x * step)];
        }
      }
      traced = traceContours(small, { tolerance: 0.5 }).map((loop) =>
        loop.map((p) => ({ x: p.x * step, y: p.y * step })),
      );
    } else {
      traced = traceContours(mask, { tolerance: 0.5 });
    }
    this.antsPath = traced.length ? contoursToPath2D(traced) : null;
    this.loopCount = traced.length;
  }

  draw({ source, view, mode = 'dim', showAnts = true, tool = null, editor = null }) {
    const { ctx, frameCtx: fctx, dpr } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!source) return;

    const sx = view.x * dpr;
    const sy = view.y * dpr;
    const sw = source.width * view.scale * dpr;
    const sh = source.height * view.scale * dpr;

    // Checkerboard under the photo, so transparency is visible as transparency.
    ctx.save();
    ctx.fillStyle = this.#checkerPattern(ctx);
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();

    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, W, H);
    fctx.imageSmoothingEnabled = view.scale < 1;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(source, sx, sy, sw, sh);

    if (mode === 'cutout' && this.maskCanvas) {
      // Exactly what the exported file will contain.
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(this.maskCanvas, sx, sy, sw, sh);
      fctx.globalCompositeOperation = 'source-over';
    } else if (mode === 'dim' && this.maskCanvas) {
      fctx.save();
      fctx.beginPath();
      fctx.rect(sx, sy, sw, sh);
      fctx.clip();
      fctx.globalCompositeOperation = 'source-over';
      fctx.fillStyle = 'rgba(8,10,14,.62)';
      fctx.fillRect(sx, sy, sw, sh);
      // Punch the selection back out of the shade.
      fctx.globalCompositeOperation = 'destination-out';
      fctx.drawImage(this.maskCanvas, sx, sy, sw, sh);
      fctx.globalCompositeOperation = 'source-over';
      fctx.restore();
      // Re-draw the photo underneath the remaining shade.
      ctx.drawImage(source, sx, sy, sw, sh);
    } else if (mode === 'overlay' && this.maskCanvas) {
      const tint = makeCanvas(this.maskCanvas.width, this.maskCanvas.height);
      const tctx = tint.getContext('2d');
      tctx.drawImage(this.maskCanvas, 0, 0);
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = 'rgba(94,234,212,.42)';
      tctx.fillRect(0, 0, tint.width, tint.height);
      fctx.drawImage(tint, sx, sy, sw, sh);
    }

    ctx.drawImage(this.frame, 0, 0);

    // Marching ants, drawn in image space so the outline tracks the zoom.
    if (showAnts && this.antsPath) {
      ctx.save();
      ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, sx, sy);
      const px = 1 / (view.scale * dpr);
      ctx.lineWidth = 1.6 * px * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.setLineDash([5 * px * dpr, 4 * px * dpr]);
      ctx.lineDashOffset = -this.antsOffset * px * dpr;
      ctx.stroke(this.antsPath);
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineDashOffset = (-this.antsOffset + 4.5) * px * dpr;
      ctx.stroke(this.antsPath);
      ctx.restore();
    }

    // A hairline around the photo's own edge.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    ctx.restore();

    if (tool?.preview && editor) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tool.preview(ctx, editor);
      ctx.restore();
    }
  }

  #checkerPattern(ctx) {
    if (!this.checker) {
      const size = 16;
      const tile = makeCanvas(size * 2, size * 2);
      const tctx = tile.getContext('2d');
      tctx.fillStyle = '#2a2f3a';
      tctx.fillRect(0, 0, size * 2, size * 2);
      tctx.fillStyle = '#21252e';
      tctx.fillRect(0, 0, size, size);
      tctx.fillRect(size, size, size, size);
      this.checker = ctx.createPattern(tile, 'repeat');
    }
    return this.checker;
  }
}
