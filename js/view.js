// Zoom and pan: the mapping between screen pixels and image pixels.
// Every tool works in image coordinates, so this is the only place the
// conversion lives.

import { clamp } from './util.js';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

export class View {
  constructor() {
    this.scale = 1;
    this.x = 0; // image-space origin, in screen pixels
    this.y = 0;
  }

  /** Scale and centre the image so it fits inside the viewport. */
  fit(imageWidth, imageHeight, viewWidth, viewHeight, padding = 48) {
    const usableW = Math.max(16, viewWidth - padding);
    const usableH = Math.max(16, viewHeight - padding);
    // Fit enlarges a small image as well as shrinking a large one, but stops
    // short of a blur of giant pixels.
    this.scale = clamp(Math.min(usableW / imageWidth, usableH / imageHeight), MIN_ZOOM, 8);
    this.center(imageWidth, imageHeight, viewWidth, viewHeight);
    return this;
  }

  center(imageWidth, imageHeight, viewWidth, viewHeight) {
    this.x = (viewWidth - imageWidth * this.scale) / 2;
    this.y = (viewHeight - imageHeight * this.scale) / 2;
    return this;
  }

  /** Zoom by a factor, keeping the point under the cursor fixed. */
  zoomAt(screenX, screenY, factor) {
    const next = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM);
    const applied = next / this.scale;
    this.x = screenX - (screenX - this.x) * applied;
    this.y = screenY - (screenY - this.y) * applied;
    this.scale = next;
    return this;
  }

  setZoom(scale, viewWidth, viewHeight) {
    const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    this.zoomAt(viewWidth / 2, viewHeight / 2, next / this.scale);
    return this;
  }

  pan(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }

  toImage(screenX, screenY) {
    return { x: (screenX - this.x) / this.scale, y: (screenY - this.y) / this.scale };
  }

  toScreen(imageX, imageY) {
    return { x: imageX * this.scale + this.x, y: imageY * this.scale + this.y };
  }
}
