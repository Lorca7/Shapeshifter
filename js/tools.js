// The outlining tools.
//
// Every tool does the same thing in the end: build a shape, rasterize it to an
// 8-bit stamp, and merge that stamp into the one selection mask. Drawing is
// previewed on screen and only rasterized on release, which keeps a freehand
// lasso smooth even on a 40-megapixel photo.

import { COMBINE } from './mask.js';
import { magicWand, softenEdge } from './wand.js';

/** Resolve the merge mode, letting Shift/Alt override the chosen one. */
export function effectiveMode(editor, event) {
  if (event?.shiftKey && !event?.altKey) return COMBINE.ADD;
  if (event?.altKey && !event?.shiftKey) return COMBINE.SUBTRACT;
  if (event?.altKey && event?.shiftKey) return COMBINE.INTERSECT;
  return editor.combineMode;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ------------------------------------------------------------------ lasso */

export const lassoTool = {
  id: 'lasso',
  short: 'Lasso',
  label: 'Freehand lasso',
  hint: 'Drag to trace around the part you want. Release to close the shape.',
  cursor: 'crosshair',
  points: null,

  down(editor, pt, event) {
    this.points = [pt];
    this.mode = effectiveMode(editor, event);
  },
  move(editor, pt) {
    if (!this.points) return;
    const last = this.points[this.points.length - 1];
    // Thin the stream so a slow drag does not pile up thousands of points.
    if (dist(last, pt) >= 0.75 / Math.max(editor.view.scale, 0.05)) this.points.push(pt);
    editor.requestRender();
  },
  up(editor) {
    const points = this.points;
    this.points = null;
    if (!points || points.length < 3) {
      editor.requestRender();
      return;
    }
    const path = new Path2D();
    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
    path.closePath();
    editor.stamp(editor.mask.rasterizePath(path), this.mode, 'lasso');
  },
  cancel(editor) {
    this.points = null;
    editor.requestRender();
  },
  preview(ctx, editor) {
    if (!this.points || this.points.length < 2) return;
    strokePreview(ctx, editor, this.points, true);
  },
};

/* ---------------------------------------------------------------- polygon */

export const polygonTool = {
  id: 'polygon',
  short: 'Polygon',
  label: 'Polygon',
  hint: 'Click to drop corners. Click the first point, double-click, or press Enter to close. Backspace removes the last corner.',
  cursor: 'crosshair',
  points: [],
  hover: null,

  down(editor, pt, event) {
    if (!this.points.length) this.mode = effectiveMode(editor, event);
    // Clicking back on the first point closes the shape.
    if (this.points.length > 2 && dist(pt, this.points[0]) * editor.view.scale < 12) {
      this.close(editor);
      return;
    }
    this.points.push(pt);
    editor.requestRender();
  },
  move(editor, pt) {
    this.hover = pt;
    if (this.points.length) editor.requestRender();
  },
  up() {},
  dblclick(editor) {
    this.close(editor);
  },
  key(editor, event) {
    if (event.key === 'Enter') {
      this.close(editor);
      return true;
    }
    if (event.key === 'Backspace' && this.points.length) {
      this.points.pop();
      editor.requestRender();
      return true;
    }
    if (event.key === 'Escape' && this.points.length) {
      this.cancel(editor);
      return true;
    }
    return false;
  },
  close(editor) {
    if (this.points.length < 3) return;
    const path = new Path2D();
    path.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) path.lineTo(this.points[i].x, this.points[i].y);
    path.closePath();
    const stamp = editor.mask.rasterizePath(path);
    this.points = [];
    editor.stamp(stamp, this.mode, 'polygon');
  },
  cancel(editor) {
    this.points = [];
    editor.requestRender();
  },
  preview(ctx, editor) {
    if (!this.points.length) return;
    const chain = this.hover ? [...this.points, this.hover] : this.points;
    strokePreview(ctx, editor, chain, false);
    // Handles, plus a ring on the first point to show where it closes.
    for (const [i, p] of this.points.entries()) {
      const s = editor.view.toScreen(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === 0 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#5eead4' : '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  },
};

/* ------------------------------------------------------ rectangle, ellipse */

function makeDragShape(id, label, hint, build) {
  return {
    id,
    short: label,
    label,
    hint,
    cursor: 'crosshair',
    start: null,
    current: null,

    down(editor, pt, event) {
      this.start = pt;
      this.current = pt;
      this.mode = effectiveMode(editor, event);
    },
    move(editor, pt, event) {
      if (!this.start) return;
      this.current = constrain(this.start, pt, event?.shiftKey);
      editor.requestRender();
    },
    up(editor) {
      const { start, current } = this;
      this.start = null;
      this.current = null;
      if (!start || !current || (Math.abs(current.x - start.x) < 1 && Math.abs(current.y - start.y) < 1)) {
        editor.requestRender();
        return;
      }
      editor.stamp(editor.mask.rasterizePath(build(start, current)), this.mode, id);
    },
    cancel(editor) {
      this.start = null;
      this.current = null;
      editor.requestRender();
    },
    preview(ctx, editor) {
      if (!this.start || !this.current) return;
      const path = build(this.start, this.current);
      ctx.save();
      ctx.setTransform(editor.view.scale, 0, 0, editor.view.scale, editor.view.x, editor.view.y);
      ctx.lineWidth = 1.5 / editor.view.scale;
      ctx.strokeStyle = '#5eead4';
      ctx.setLineDash([6 / editor.view.scale, 4 / editor.view.scale]);
      ctx.stroke(path);
      ctx.restore();
    },
  };
}

function constrain(start, pt, square) {
  if (!square) return pt;
  const dx = pt.x - start.x;
  const dy = pt.y - start.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
}

export const rectTool = makeDragShape('rect', 'Rectangle', 'Drag a rectangle. Hold Shift for a square.', (a, b) => {
  const path = new Path2D();
  path.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return path;
});

export const ellipseTool = makeDragShape('ellipse', 'Ellipse', 'Drag an ellipse. Hold Shift for a circle.', (a, b) => {
  const path = new Path2D();
  path.ellipse(
    (a.x + b.x) / 2,
    (a.y + b.y) / 2,
    Math.abs(b.x - a.x) / 2,
    Math.abs(b.y - a.y) / 2,
    0, 0, Math.PI * 2,
  );
  return path;
});

/* ------------------------------------------------------------------ brush */

export const brushTool = {
  id: 'brush',
  short: 'Brush',
  label: 'Brush',
  hint: 'Paint the selection by hand. Hold Alt to erase. [ and ] change the brush size.',
  cursor: 'none',
  points: null,
  hover: null,

  down(editor, pt, event) {
    this.points = [pt];
    this.mode = event?.altKey ? COMBINE.SUBTRACT : COMBINE.ADD;
  },
  move(editor, pt) {
    this.hover = pt;
    if (this.points) {
      const last = this.points[this.points.length - 1];
      if (dist(last, pt) >= 0.5 / Math.max(editor.view.scale, 0.05)) this.points.push(pt);
    }
    editor.requestRender();
  },
  up(editor) {
    const points = this.points;
    this.points = null;
    if (!points) return;
    const path = new Path2D();
    path.moveTo(points[0].x, points[0].y);
    if (points.length === 1) path.lineTo(points[0].x + 0.01, points[0].y);
    else for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
    editor.stamp(
      editor.mask.rasterizeStroke(path, editor.settings.brushSize),
      this.mode,
      this.mode === COMBINE.SUBTRACT ? 'erase' : 'brush',
    );
  },
  cancel(editor) {
    this.points = null;
    editor.requestRender();
  },
  preview(ctx, editor) {
    const { view, settings } = editor;
    if (this.points && this.points.length) {
      ctx.save();
      ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
      ctx.strokeStyle = this.mode === COMBINE.SUBTRACT ? 'rgba(248,113,113,.55)' : 'rgba(94,234,212,.55)';
      ctx.lineWidth = settings.brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this.points[0].x, this.points[0].y);
      for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
      ctx.stroke();
      ctx.restore();
    }
    if (this.hover) {
      const s = view.toScreen(this.hover.x, this.hover.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2, (settings.brushSize / 2) * view.scale), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(2, (settings.brushSize / 2) * view.scale) + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
};

/* ------------------------------------------------------------- magic wand */

export const wandTool = {
  id: 'wand',
  short: 'Wand',
  label: 'Magic wand',
  hint: 'Click a colour to select it. Tolerance controls how far the match spreads.',
  cursor: 'crosshair',

  down(editor, pt, event) {
    const mode = effectiveMode(editor, event);
    const { tolerance, contiguous, antialias } = editor.settings;
    let stamp = magicWand(editor.sourceData, pt.x, pt.y, { tolerance, contiguous });
    if (antialias) stamp = softenEdge(stamp, editor.mask.width, editor.mask.height);
    editor.stamp(stamp, mode, 'magic wand');
  },
  move(editor, pt) {
    editor.setHoverColor(pt);
  },
  up() {},
  cancel() {},
  preview() {},
};

/* -------------------------------------------------------------------- pan */

export const panTool = {
  id: 'pan',
  short: 'Pan',
  label: 'Pan',
  hint: 'Drag to move the photo. Scroll to zoom. (Hold Space with any tool.)',
  cursor: 'grab',
  last: null,

  down(editor, pt, event) {
    this.last = { x: event.clientX, y: event.clientY };
  },
  move(editor, pt, event) {
    if (!this.last) return;
    editor.view.pan(event.clientX - this.last.x, event.clientY - this.last.y);
    this.last = { x: event.clientX, y: event.clientY };
    editor.requestRender();
  },
  up() {
    this.last = null;
  },
  cancel() {
    this.last = null;
  },
  preview() {},
};

function strokePreview(ctx, editor, points, closed) {
  const { view } = editor;
  ctx.save();
  ctx.beginPath();
  const first = view.toScreen(points[0].x, points[0].y);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const s = view.toScreen(points[i].x, points[i].y);
    ctx.lineTo(s.x, s.y);
  }
  if (closed) ctx.closePath();
  ctx.fillStyle = 'rgba(94,234,212,.14)';
  if (closed) ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#5eead4';
  ctx.stroke();
  ctx.restore();
}

export const TOOLS = [lassoTool, polygonTool, rectTool, ellipseTool, brushTool, wandTool, panTool];
export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
