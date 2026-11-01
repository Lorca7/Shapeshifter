// Drawing. Everything is redrawn on demand, and nothing animates: the outline
// is a plain solid line, drawn with a dark edge under a bright core so it
// stays readable on any photo.

import { makeCanvas } from './util.js';

const ACCENT = '#5eead4';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.checker = null;
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.dpr = dpr;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  draw({ photo, view, points, closed, hover, cursor }) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!photo) return;

    const x = view.x;
    const y = view.y;
    const w = photo.width * view.scale;
    const h = photo.height * view.scale;
    const screen = points.map((p) => view.toScreen(p.x, p.y));

    // Zoomed in far enough to see pixels, show them crisp rather than blurred:
    // that is what makes placing a point on an exact pixel possible.
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.imageSmoothingQuality = 'high';

    if (closed && screen.length >= 3) {
      // The erased look: a transparency checkerboard, with only a faint ghost
      // of the original left outside the outline so you can still judge
      // whether an edge is in the right place while you adjust it.
      ctx.fillStyle = this.#checkerboard();
      ctx.fillRect(x, y, w, h);
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.drawImage(photo, x, y, w, h);
      ctx.restore();

      ctx.save();
      tracePath(ctx, screen, true);
      ctx.clip();
      ctx.drawImage(photo, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(photo, x, y, w, h);
    }

    // The outline.
    if (screen.length >= 2) {
      tracePath(ctx, screen, closed);
      stroke(ctx, 1);
    }

    // The line that follows the cursor, showing where the next segment would go.
    if (!closed && screen.length && cursor) {
      const last = screen[screen.length - 1];
      const here = view.toScreen(cursor.x, cursor.y);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(here.x, here.y);
      stroke(ctx, 0.55);
    }

    // A ghost point where a click would add one to an edge.
    if (hover?.kind === 'edge') {
      const at = view.toScreen(hover.x, hover.y);
      dot(ctx, at.x, at.y, 5, ACCENT);
    }

    // The points. The first one is larger once the shape can be closed.
    const closable = !closed && screen.length >= 3;
    screen.forEach((p, i) => {
      const hovered = hover?.kind === 'point' && hover.index === i;
      if (i === 0 && closable) dot(ctx, p.x, p.y, hovered ? 9 : 7, '#34d399');
      else dot(ctx, p.x, p.y, hovered ? 6 : 4, hovered ? ACCENT : '#ffffff');
    });
  }

  #checkerboard() {
    if (!this.checker) {
      const size = 10;
      const tile = makeCanvas(size * 2, size * 2);
      const t = tile.getContext('2d');
      t.fillStyle = '#d9dde3';
      t.fillRect(0, 0, size * 2, size * 2);
      t.fillStyle = '#b9bfc9';
      t.fillRect(0, 0, size, size);
      t.fillRect(size, size, size, size);
      this.checker = this.ctx.createPattern(tile, 'repeat');
    }
    return this.checker;
  }
}

function tracePath(ctx, points, closed) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  if (closed) ctx.closePath();
}

/** Stroke the current path: dark edge underneath, bright core on top. */
function stroke(ctx, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, x, y, radius, fill) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.stroke();
}
