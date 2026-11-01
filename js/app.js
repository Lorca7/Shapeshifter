// Shapeshifter: trace an object, erase everything else, save the shape.
//
// One gesture vocabulary, no modes:
//   click the photo ......... drop a point along the edge you are tracing
//   click the first point ... close the outline
//   drag a point ............ move it
//   click an edge ........... add a point there (once the outline is closed)
//   drag empty space ........ move around the photo
//   pinch / scroll .......... zoom / move around

import { loadImageFile } from './decode/image.js';
import { exportCutout, cutoutRegion } from './export.js';
import { distanceToSegment } from './geometry.js';
import { inApp, requestOpen, saveFile } from './native.js';
import { Renderer } from './render.js';
import { View } from './view.js';
import { $, baseName, clamp, formatBytes } from './util.js';

const POINT_GRAB = 8;   // screen px: how close counts as "on" a point
const EDGE_GRAB = 6;    // screen px: how close counts as "on" an edge
const DRAG_SLOP = 4;    // screen px a press must travel before it is a drag
const MAX_UNDO = 300;

class Shapeshifter {
  constructor() {
    this.app = $('#app');
    this.canvas = $('#canvas');
    this.stage = $('#stage');
    this.fileInput = $('#fileInput');
    this.renderer = new Renderer(this.canvas);
    this.view = new View();

    this.photo = null;
    this.name = 'photo';
    this.points = [];
    this.closed = false;
    this.undoStack = [];
    this.redoStack = [];

    this.hover = null;
    this.cursor = null;
    this.pointer = null;
    this.gesture = null;
    this.spaceHeld = false;
    this.message = null;
    this.frame = 0;

    this.bind();
    this.refresh();
  }

  /* --------------------------------------------------------------- state */

  snapshot() {
    return { points: this.points.map((p) => ({ x: p.x, y: p.y })), closed: this.closed };
  }

  restore(snapshot) {
    this.points = snapshot.points.map((p) => ({ x: p.x, y: p.y }));
    this.closed = snapshot.closed;
  }

  /** Record `before` as an undo step. Call after an edit has been made. */
  remember(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Something about the outline changed. */
  changed() {
    this.message = null;
    this.updateHover();
    this.refresh();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.changed();
  }

  startOver() {
    if (!this.points.length) return;
    const before = this.snapshot();
    this.points = [];
    this.closed = false;
    this.remember(before);
    this.changed();
  }

  /** Close the outline, which is what erases everything outside it. */
  finish() {
    if (!this.photo || this.closed) return;
    if (this.points.length < 3) {
      this.setHint('Place at least three points first.', 'error');
      return;
    }
    const before = this.snapshot();
    this.closed = true;
    this.remember(before);
    this.changed();
  }

  /** Replace the outline wholesale. Used by tests and the app's self-check. */
  trace(points) {
    if (!this.photo) return;
    const before = this.snapshot();
    this.points = points.map(([x, y]) => this.clampToPhoto({ x, y }));
    this.closed = this.points.length >= 3;
    this.remember(before);
    this.changed();
  }

  /** Remove the point under the cursor, or else the last one placed. */
  removePoint() {
    let index = -1;
    if (this.hover?.kind === 'point') index = this.hover.index;
    else if (!this.closed && this.points.length) index = this.points.length - 1;
    if (index < 0) return;
    if (this.closed && this.points.length <= 3) {
      this.setHint('An outline needs at least three points.', 'error');
      return;
    }
    const before = this.snapshot();
    this.points.splice(index, 1);
    this.remember(before);
    this.changed();
  }

  clampToPhoto(p) {
    return { x: clamp(p.x, 0, this.photo.width), y: clamp(p.y, 0, this.photo.height) };
  }

  /* ------------------------------------------------------ opening a photo */

  requestOpen() {
    requestOpen(this.fileInput);
  }

  async open(file) {
    this.setHint(`Opening ${file.name || 'photo'}…`);
    try {
      const loaded = await loadImageFile(file);
      this.photo = loaded.canvas;
      this.name = loaded.name;
      this.points = [];
      this.closed = false;
      this.undoStack = [];
      this.redoStack = [];
      this.hover = null;
      this.message = null;
      this.fit();
      this.refresh();
      return true;
    } catch (error) {
      // A refused file is ordinary feedback for the user, not a fault.
      console.warn(error);
      this.setHint(error.message || 'Could not open that file.', 'error');
      return false;
    }
  }

  /* -------------------------------------------------------------- saving */

  async save() {
    if (!this.photo) return;
    if (!this.closed) {
      if (this.points.length >= 3) this.finish();
      else this.setHint('Trace around the object first.', 'error');
      return;
    }
    try {
      const result = await exportCutout(this.photo, this.points, baseName(this.name));
      const how = await saveFile(result.blob, result.filename);
      this.setHint(
        how === 'app'
          ? `Choose where to save ${result.filename}…`
          : `Saved ${result.filename} — ${result.width} × ${result.height}, ${formatBytes(result.blob.size)}.`,
      );
    } catch (error) {
      console.error(error);
      this.setHint(error.message || 'Could not save the file.', 'error');
    }
  }

  /* ---------------------------------------------------------- hit testing */

  hitTest(sx, sy) {
    const near = (i) => {
      const s = this.view.toScreen(this.points[i].x, this.points[i].y);
      return Math.hypot(s.x - sx, s.y - sy) <= POINT_GRAB;
    };

    // When the shape can be closed, the first point wins even if the last
    // point sits right next to it.
    if (!this.closed && this.points.length >= 3 && near(0)) return { kind: 'point', index: 0 };
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (near(i)) return { kind: 'point', index: i };
    }

    if (this.closed) {
      let best = null;
      for (let i = 0; i < this.points.length; i++) {
        const a = this.points[i];
        const b = this.points[(i + 1) % this.points.length];
        const sa = this.view.toScreen(a.x, a.y);
        const sb = this.view.toScreen(b.x, b.y);
        const { distance, t } = distanceToSegment(sx, sy, sa.x, sa.y, sb.x, sb.y);
        if (distance <= EDGE_GRAB && (!best || distance < best.distance)) {
          best = { kind: 'edge', index: i, distance, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
      }
      if (best) return best;
    }
    return null;
  }

  updateHover() {
    this.hover = this.photo && this.pointer && !this.gesture
      ? this.hitTest(this.pointer.sx, this.pointer.sy)
      : null;
    this.updateCursorStyle();
    this.draw();
  }

  updateCursorStyle() {
    let style = 'default';
    if (this.gesture?.type === 'pan' || this.gesture?.panning) style = 'grabbing';
    else if (this.spaceHeld) style = 'grab';
    else if (this.gesture?.type === 'move') style = 'grabbing';
    else if (this.hover?.kind === 'point') style = 'pointer';
    else if (this.hover?.kind === 'edge') style = 'copy';
    else if (this.photo) style = 'crosshair';
    this.canvas.style.cursor = style;
  }

  /* ----------------------------------------------------------- pointer input */

  local(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top };
  }

  onPointerDown(event) {
    if (!this.photo || (event.button !== 0 && event.button !== 1)) return;
    const { sx, sy } = this.local(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.pointer = { sx, sy };

    if (event.button === 1 || this.spaceHeld) {
      this.gesture = { type: 'pan', x: event.clientX, y: event.clientY };
      this.updateCursorStyle();
      return;
    }

    const hit = this.hitTest(sx, sy);
    if (hit?.kind === 'point') {
      const at = this.view.toScreen(this.points[hit.index].x, this.points[hit.index].y);
      this.gesture = {
        type: 'move', index: hit.index, before: this.snapshot(), sx, sy, moved: false,
        // Keep the point where it was under the cursor instead of snapping it
        // to the cursor, so grabbing a point never nudges it.
        grabX: at.x - sx, grabY: at.y - sy,
        closeOnClick: hit.index === 0 && !this.closed && this.points.length >= 3,
      };
    } else if (hit?.kind === 'edge') {
      const before = this.snapshot();
      this.points.splice(hit.index + 1, 0, { x: hit.x, y: hit.y });
      const at = this.view.toScreen(hit.x, hit.y);
      this.gesture = {
        type: 'move', index: hit.index + 1, before, sx, sy, moved: true,
        grabX: at.x - sx, grabY: at.y - sy,
      };
      this.hover = null;
      this.draw();
    } else {
      this.gesture = { type: 'press', sx, sy, x: event.clientX, y: event.clientY, panning: false };
    }
    this.updateCursorStyle();
  }

  onPointerMove(event) {
    if (!this.photo) return;
    const { sx, sy } = this.local(event);
    this.pointer = { sx, sy };
    this.cursor = this.view.toImage(sx, sy);
    const g = this.gesture;

    if (!g) {
      this.updateHover();
      return;
    }

    if (g.type === 'pan' || (g.type === 'press' && (g.panning || Math.hypot(sx - g.sx, sy - g.sy) > DRAG_SLOP))) {
      if (g.type === 'press') g.panning = true;
      this.view.pan(event.clientX - g.x, event.clientY - g.y);
      g.x = event.clientX;
      g.y = event.clientY;
      this.updateCursorStyle();
      this.draw();
    } else if (g.type === 'move') {
      if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) <= DRAG_SLOP) return;
      g.moved = true;
      this.points[g.index] = this.clampToPhoto(this.view.toImage(sx + g.grabX, sy + g.grabY));
      this.draw();
    }
  }

  onPointerUp(event) {
    const g = this.gesture;
    this.gesture = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (!g) return;

    if (g.type === 'move') {
      if (g.moved) {
        this.remember(g.before);
        this.changed();
      } else if (g.closeOnClick) {
        this.closed = true;
        this.remember(g.before);
        this.changed();
      }
    } else if (g.type === 'press' && !g.panning && !this.closed) {
      const { sx, sy } = this.local(event);
      const before = this.snapshot();
      this.points.push(this.clampToPhoto(this.view.toImage(sx, sy)));
      this.remember(before);
      this.changed();
    }
    this.updateHover();
  }

  onPointerCancel() {
    const g = this.gesture;
    this.gesture = null;
    if (g?.type === 'move' && g.moved) this.restore(g.before);
    this.changed();
  }

  onWheel(event) {
    if (!this.photo) return;
    event.preventDefault();
    const { sx, sy } = this.local(event);
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel in most browsers.
      this.view.zoomAt(sx, sy, Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.004)));
    } else {
      this.view.pan(-event.deltaX, -event.deltaY);
    }
    this.updateHover();
  }

  /* ------------------------------------------------------------------ view */

  fit() {
    if (!this.photo) return;
    this.view.fit(this.photo.width, this.photo.height, this.renderer.width, this.renderer.height);
    this.updateHover();
  }

  zoomBy(factor) {
    if (!this.photo) return;
    this.view.zoomAt(this.renderer.width / 2, this.renderer.height / 2, factor);
    this.updateHover();
  }

  /* -------------------------------------------------------------- interface */

  setHint(text, kind = '') {
    this.message = { text, kind };
    this.refresh();
  }

  defaultHint() {
    const n = this.points.length;
    if (!this.photo) return 'Drop a photo anywhere, or choose one.';
    if (this.closed) return 'Everything outside your outline is erased. Drag a point to fine-tune it, or click an edge to add one. Save when it looks right.';
    if (n === 0) return 'Click along the edge of the object to drop points. Zoom in for precision.';
    if (n < 3) return 'Keep clicking around the object. Drag any point to adjust it.';
    return 'Click the first point — the large green one — to close the outline.';
  }

  refresh() {
    const n = this.points.length;
    this.app.dataset.state = this.photo ? 'ready' : 'empty';

    const hint = $('#hint');
    hint.textContent = this.message?.text ?? this.defaultHint();
    hint.dataset.kind = this.message?.kind ?? '';

    const primary = $('#primaryBtn');
    primary.textContent = this.closed ? 'Save cutout' : 'Finish outline';
    primary.disabled = !this.photo || (!this.closed && n < 3);
    $('#undoBtn').disabled = !this.undoStack.length;
    $('#resetBtn').disabled = n === 0;
    this.draw();
  }

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.draw({
        photo: this.photo,
        view: this.view,
        points: this.points,
        closed: this.closed,
        hover: this.hover,
        cursor: this.closed || this.gesture ? null : this.cursor,
      });
    });
  }

  /* ----------------------------------------------------------- wiring it up */

  bind() {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.onPointerCancel());
    canvas.addEventListener('pointerleave', () => {
      if (this.gesture) return;
      this.pointer = null;
      this.cursor = null;
      this.updateHover();
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Safari reports a trackpad pinch as gesture events rather than ctrl+wheel.
    let pinchStart = 1;
    canvas.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      pinchStart = this.view.scale;
    });
    canvas.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (!this.photo) return;
      const { sx, sy } = this.local(e);
      this.view.zoomAt(sx, sy, (pinchStart * e.scale) / this.view.scale);
      this.updateHover();
    });

    new ResizeObserver(() => {
      const rect = this.stage.getBoundingClientRect();
      this.renderer.resize(rect.width, rect.height);
      this.draw();
    }).observe(this.stage);

    // Buttons. They give up focus right away so a later Space or Enter
    // keypress is never mistaken for a click on them.
    const press = (selector, action) =>
      $(selector).addEventListener('click', (e) => {
        e.currentTarget.blur();
        action();
      });
    press('#chooseBtn', () => this.requestOpen());
    press('#openBtn', () => this.requestOpen());
    press('#undoBtn', () => this.undo());
    press('#resetBtn', () => this.startOver());
    press('#zoomInBtn', () => this.zoomBy(1.4));
    press('#zoomOutBtn', () => this.zoomBy(1 / 1.4));
    press('#fitBtn', () => this.fit());
    press('#primaryBtn', () => (this.closed ? this.save() : this.finish()));

    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files?.[0]) this.open(this.fileInput.files[0]);
      this.fileInput.value = '';
    });

    // Dropping a photo anywhere on the window.
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      this.app.classList.add('dragging');
    });
    addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.app.classList.remove('dragging');
    });
    addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.app.classList.remove('dragging');
      const file = e.dataTransfer?.files?.[0];
      if (file) this.open(file);
    });

    addEventListener('keydown', (e) => this.onKeyDown(e));
    addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      this.spaceHeld = false;
      this.updateCursorStyle();
    });
    addEventListener('blur', () => {
      this.spaceHeld = false;
      this.updateCursorStyle();
    });
  }

  onKeyDown(event) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;

    if (event.code === 'Space') {
      event.preventDefault();
      this.spaceHeld = true;
      this.updateCursorStyle();
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      // In the Mac app the menu bar owns the command shortcuts.
      if (inApp) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (key === 'y') {
        event.preventDefault();
        this.redo();
      } else if (key === 's') {
        event.preventDefault();
        this.save();
      } else if (key === 'o') {
        event.preventDefault();
        this.requestOpen();
      }
      return;
    }

    switch (event.key) {
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        this.removePoint();
        break;
      case 'Enter':
        this.finish();
        break;
      case '+':
      case '=':
        this.zoomBy(1.4);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / 1.4);
        break;
      case '0':
        this.fit();
        break;
      default:
    }
  }

  /* ----------------------------------------- hooks for the tests and the app */

  /** Where an image coordinate currently sits on the page. */
  toClient(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const s = this.view.toScreen(x, y);
    return { x: rect.left + s.x, y: rect.top + s.y };
  }

  async openUrl(url, name = 'photo') {
    const blob = await (await fetch(url)).blob();
    await this.open(new File([blob], name, { type: blob.type }));
  }

  async exportDataUrl() {
    const result = await exportCutout(this.photo, this.points, baseName(this.name));
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(result.blob);
    });
    return { dataUrl, filename: result.filename, width: result.width, height: result.height, size: result.blob.size };
  }

  state() {
    return {
      loaded: Boolean(this.photo),
      width: this.photo?.width ?? 0,
      height: this.photo?.height ?? 0,
      points: this.points.map((p) => ({ x: p.x, y: p.y })),
      closed: this.closed,
      region: cutoutRegion(this.points, this.photo?.width ?? 0, this.photo?.height ?? 0),
      scale: this.view.scale,
      viewX: this.view.x,
      viewY: this.view.y,
      hint: $('#hint').textContent,
      hintKind: $('#hint').dataset.kind,
      primary: $('#primaryBtn').textContent,
      canUndo: this.undoStack.length > 0,
    };
  }
}

const editor = new Shapeshifter();
window.shapeshifter = editor;

// The Mac app calls this once the user has picked a photo, dropped one on the
// Dock icon, or used "Open With". The photo arrives as base64 text and any
// error is reported back to the app rather than lost.
window.__openPhoto = async (base64, name, type) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!(await editor.open(new File([bytes], name, { type })))) throw new Error(editor.state().hint);
};
