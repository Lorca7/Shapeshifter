// Undo/redo over selection snapshots.
//
// A full-resolution mask is one byte per pixel, so snapshots are cheap compared
// with the image itself — but still bounded, so a long session on a large photo
// cannot grow without limit.

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_STEPS = 60;

export class History {
  constructor() {
    this.past = [];
    this.future = [];
    this.bytes = 0;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
  }

  get canUndo() {
    return this.past.length > 1;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Record the current state. Call before or after each committed edit. */
  push(mask, label = 'edit') {
    const snapshot = { label, data: new Uint8ClampedArray(mask.data) };
    this.past.push(snapshot);
    this.bytes += snapshot.data.length;
    this.future.length = 0;
    while (this.past.length > MAX_STEPS || (this.bytes > MAX_BYTES && this.past.length > 2)) {
      const dropped = this.past.shift();
      this.bytes -= dropped.data.length;
    }
    this.#notify();
  }

  reset(mask, label = 'open') {
    this.past = [];
    this.future = [];
    this.bytes = 0;
    this.push(mask, label);
  }

  /** @returns {Uint8ClampedArray|null} the state to restore, or null */
  undo() {
    if (!this.canUndo) return null;
    const current = this.past.pop();
    this.bytes -= current.data.length;
    this.future.push(current);
    const target = this.past[this.past.length - 1];
    this.#notify();
    return target.data;
  }

  redo() {
    if (!this.canRedo) return null;
    const next = this.future.pop();
    this.past.push(next);
    this.bytes += next.data.length;
    this.#notify();
    return next.data;
  }

  get label() {
    return this.past[this.past.length - 1]?.label ?? '';
  }
}
