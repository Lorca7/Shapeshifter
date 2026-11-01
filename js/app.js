// Shapeshifter — application wiring.

import { COMBINE, Mask } from './mask.js';
import { History } from './history.js';
import { PREVIEW_MODES, Renderer } from './render.js';
import { TOOLS, TOOL_BY_ID } from './tools.js';
import { View } from './view.js';
import { ACCEPTED_EXTENSIONS, loadImageFile } from './decode/image.js';
import { DEFAULT_OPTIONS, FORMATS, exportCutout, exportRegion } from './export.js';
import { $, baseName, clamp, debounce, downloadBlob, el, formatBytes } from './util.js';

const ICONS = {
  lasso: '<path d="M10.5 3.2C5.8 3.2 2 5.9 2 9.2c0 2.2 1.8 4.2 4.5 5.2.3 1.1-.2 2-.9 2.6 1.4.1 2.6-.6 3.2-1.8h1.7c4.7 0 8.5-2.7 8.5-6S15.2 3.2 10.5 3.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.4" stroke-linejoin="round"/>',
  polygon: '<path d="M4 7.5 10.5 3l7 4.5-2.5 8.5H6.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="4" cy="7.5" r="1.9" fill="currentColor"/><circle cx="10.5" cy="3" r="1.9" fill="currentColor"/><circle cx="17.5" cy="7.5" r="1.9" fill="currentColor"/>',
  rect: '<rect x="3.2" y="5" width="14.6" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.4"/>',
  ellipse: '<ellipse cx="10.5" cy="10.5" rx="7.4" ry="5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.4"/>',
  brush: '<path d="M15.8 3.6c1 1 1 2.5 0 3.5l-6 6-3.5-3.5 6-6c1-1 2.5-1 3.5 0Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.3 9.6 3 17l7.4-3.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  wand: '<path d="M4 17 13.5 7.5M15 3v3M18 6.5h-3M16.8 10.5l-2-1.4M11.6 4.6l-1.4-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m12 6 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  pan: '<path d="M10.5 3v9M3 10.5h15M7 6.5 10.5 3 14 6.5M7 14.5l3.5 3.5 3.5-3.5M6.5 7 3 10.5 6.5 14M14.5 7l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};

const TOOL_KEYS = { l: 'lasso', p: 'polygon', r: 'rect', e: 'ellipse', b: 'brush', w: 'wand', h: 'pan' };

class Shapeshifter {
  constructor() {
    this.app = $('#app');
    this.stage = $('#stage');
    this.canvas = $('#canvas');
    this.renderer = new Renderer(this.canvas);
    this.view = new View();
    this.history = new History();

    this.source = null;        // HTMLCanvasElement holding the photo
    this.mask = null;          // Mask, same dimensions as the photo
    this.fileName = 'image';
    this.meta = null;
    this._sourceData = null;   // lazily cached ImageData, for the magic wand

    this.tool = TOOL_BY_ID.lasso;
    this.combineMode = COMBINE.REPLACE;
    this.previewMode = 'dim';
    this.showAnts = true;
    this.spaceHeld = false;
    this.pointerActive = false;

    this.settings = { brushSize: 40, tolerance: 15, contiguous: true, antialias: true };
    this.exportOptions = { ...DEFAULT_OPTIONS };

    this.needsDraw = true;
    this.buildUi();
    this.bindEvents();
    this.loop();
    this.setStatus('Drop a photo, or press O to choose a file.');
  }

  /* ------------------------------------------------------------- interface */

  get sourceData() {
    if (!this._sourceData && this.source) {
      this._sourceData = this.source
        .getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, this.source.width, this.source.height);
    }
    return this._sourceData;
  }

  requestRender() {
    this.needsDraw = true;
  }

  /** Merge a stamp into the selection and record it for undo. */
  stamp(stampData, mode, label) {
    if (!this.mask) return;
    this.mask.combine(stampData, mode);
    this.commit(label);
  }

  commit(label) {
    this.history.push(this.mask, label);
    this.afterMaskChange();
  }

  afterMaskChange() {
    this.renderer.updateMask(this.mask);
    this.refreshContours();
    this.updateStats();
    this.requestRender();
  }

  setStatus(message, kind = '') {
    $('#statusMsg').textContent = message;
    const bar = $('.statusbar');
    bar.classList.toggle('error', kind === 'error');
    bar.classList.toggle('busy', kind === 'busy');
  }

  setHoverColor(pt) {
    if (!this.source) return;
    const x = Math.floor(pt.x);
    const y = Math.floor(pt.y);
    if (x < 0 || y < 0 || x >= this.source.width || y >= this.source.height) {
      $('#cursorInfo').textContent = '';
      return;
    }
    $('#cursorInfo').textContent = `${x}, ${y}`;
  }

  /* -------------------------------------------------------------------- UI */

  buildUi() {
    const rail = $('#toolrail');
    for (const tool of TOOLS) {
      const key = Object.entries(TOOL_KEYS).find(([, id]) => id === tool.id)?.[0] ?? '';
      const button = el('button', {
        class: 'tool',
        type: 'button',
        'data-tool': tool.id,
        'aria-pressed': String(tool === this.tool),
        title: `${tool.label} (${key.toUpperCase()})`,
        onclick: () => this.selectTool(tool.id),
      });
      button.innerHTML = `<svg viewBox="0 0 21 21" aria-hidden="true">${ICONS[tool.id]}</svg>
        <span>${tool.short ?? tool.label}</span><kbd>${key.toUpperCase()}</kbd>`;
      rail.append(button);
    }

    const previewSelect = $('#previewMode');
    for (const [value, label] of Object.entries(PREVIEW_MODES)) {
      previewSelect.append(el('option', { value, text: label, selected: value === this.previewMode ? '' : null }));
    }

    const formatSelect = $('#format');
    for (const [value, spec] of Object.entries(FORMATS)) {
      formatSelect.append(el('option', { value, text: spec.label }));
    }
    formatSelect.value = this.exportOptions.format;

    this.selectTool(this.tool.id);
    this.updateFormatUi();
  }

  selectTool(id) {
    const next = TOOL_BY_ID[id];
    if (!next) return;
    if (this.tool !== next) this.tool?.cancel?.(this);
    this.tool = next;
    for (const button of document.querySelectorAll('.tool')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === id));
    }
    $('#toolTitle').textContent = next.label;
    $('#toolHint').textContent = next.hint;
    for (const field of document.querySelectorAll('.tool-only')) {
      field.classList.toggle('visible', field.dataset.tools.split(' ').includes(id));
    }
    this.canvas.style.cursor = next.cursor;
    this.requestRender();
  }

  setCombineMode(mode) {
    this.combineMode = mode;
    for (const button of document.querySelectorAll('#modeGroup button')) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
  }

  /* ---------------------------------------------------------------- events */

  bindEvents() {
    const stage = this.stage;

    // --- Opening files -----------------------------------------------------
    const input = $('#fileInput');
    const pick = () => input.click();
    $('#openBtn').addEventListener('click', pick);
    $('#emptyOpenBtn').addEventListener('click', pick);
    input.addEventListener('change', () => {
      if (input.files?.[0]) this.open(input.files[0]);
      input.value = '';
    });

    let dragDepth = 0;
    const onDragEnter = (event) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
      event.preventDefault();
      dragDepth++;
      this.app.classList.add('dragging');
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', (event) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) this.app.classList.remove('dragging');
    });
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      this.app.classList.remove('dragging');
      const file = event.dataTransfer?.files?.[0];
      if (file) this.open(file);
    });
    window.addEventListener('paste', (event) => {
      const file = Array.from(event.clipboardData?.files ?? [])[0];
      if (file) this.open(file);
    });

    // --- Pointer input on the canvas --------------------------------------
    const toImage = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      return this.view.toImage(event.clientX - rect.left, event.clientY - rect.top);
    };
    const activeTool = (event) =>
      this.spaceHeld || event.button === 1 ? TOOL_BY_ID.pan : this.tool;

    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.source || (event.button !== 0 && event.button !== 1)) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.pointerActive = activeTool(event);
      this.pointerActive.down?.(this, toImage(event), event);
      this.requestRender();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.source) return;
      const pt = toImage(event);
      this.setHoverColor(pt);
      (this.pointerActive || this.tool).move?.(this, pt, event);
    });
    const finish = (event) => {
      if (!this.pointerActive) return;
      const tool = this.pointerActive;
      this.pointerActive = false;
      tool.up?.(this, toImage(event), event);
      this.requestRender();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', (event) => {
      if (this.pointerActive) {
        this.pointerActive.cancel?.(this);
        this.pointerActive = false;
      }
      this.requestRender();
    });
    this.canvas.addEventListener('dblclick', (event) => {
      this.tool.dblclick?.(this, toImage(event), event);
    });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.canvas.addEventListener('wheel', (event) => {
      if (!this.source) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0022));
        this.view.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
        this.updateZoomLabel();
      } else {
        this.view.pan(-event.deltaX, -event.deltaY);
      }
      this.requestRender();
    }, { passive: false });

    // --- Keyboard ---------------------------------------------------------
    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceHeld = false;
        this.canvas.style.cursor = this.tool.cursor;
      }
    });
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
    });

    // --- Viewport ---------------------------------------------------------
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      this.renderer.resize(rect.width, rect.height);
      this.requestRender();
    };
    new ResizeObserver(resize).observe(stage);
    resize();

    $('#zoomInBtn').addEventListener('click', () => this.zoomBy(1.25));
    $('#zoomOutBtn').addEventListener('click', () => this.zoomBy(1 / 1.25));
    $('#zoomLabel').addEventListener('click', () => this.setZoom(1));
    $('#fitBtn').addEventListener('click', () => this.fit());

    // --- Undo / redo ------------------------------------------------------
    $('#undoBtn').addEventListener('click', () => this.undo());
    $('#redoBtn').addEventListener('click', () => this.redo());
    this.history.onChange((h) => {
      $('#undoBtn').disabled = !h.canUndo;
      $('#redoBtn').disabled = !h.canRedo;
    });

    // --- Tool options -----------------------------------------------------
    for (const button of document.querySelectorAll('#modeGroup button')) {
      button.addEventListener('click', () => this.setCombineMode(button.dataset.mode));
    }
    bindRange('#brushSize', '#brushSizeOut', (v) => `${v} px`, (v) => {
      this.settings.brushSize = v;
      this.requestRender();
    });
    bindRange('#tolerance', '#toleranceOut', (v) => String(v), (v) => {
      this.settings.tolerance = v;
    });
    $('#contiguous').addEventListener('change', (e) => {
      this.settings.contiguous = e.target.checked;
    });
    $('#antialias').addEventListener('change', (e) => {
      this.settings.antialias = e.target.checked;
    });

    // --- Selection operations --------------------------------------------
    $('#selectAllBtn').addEventListener('click', () => this.selectAll());
    $('#selectNoneBtn').addEventListener('click', () => this.selectNone());
    $('#invertBtn').addEventListener('click', () => this.invert());

    bindRange('#feather', '#featherOut', (v) => `${v} px`);
    bindRange('#offset', '#offsetOut', (v) => `${v > 0 ? '+' : ''}${v} px`);
    $('#featherApply').addEventListener('click', () => {
      const radius = Number($('#feather').value);
      if (!this.mask || radius <= 0) return;
      this.mask.feather(radius);
      this.commit(`feather ${radius}px`);
      this.setStatus(`Feathered the edge by ${radius} px.`);
    });
    $('#offsetApply').addEventListener('click', () => {
      const amount = Number($('#offset').value);
      if (!this.mask || amount === 0) return;
      this.mask.offset(amount);
      this.commit(`${amount > 0 ? 'grow' : 'shrink'} ${Math.abs(amount)}px`);
      this.setStatus(`${amount > 0 ? 'Grew' : 'Shrank'} the selection by ${Math.abs(amount)} px.`);
    });

    // --- View options -----------------------------------------------------
    $('#previewMode').addEventListener('change', (e) => {
      this.previewMode = e.target.value;
      this.requestRender();
    });
    $('#showAnts').addEventListener('change', (e) => {
      this.showAnts = e.target.checked;
      this.requestRender();
    });

    // --- Export options ---------------------------------------------------
    $('#format').addEventListener('change', (e) => {
      this.exportOptions.format = e.target.value;
      this.updateFormatUi();
      this.updateExportSummary();
    });
    bindRange('#scalePct', '#scaleOut', (v) => `${v}%`, (v) => {
      this.exportOptions.scale = v / 100;
      this.updateExportSummary();
    });
    bindRange('#padding', '#paddingOut', (v) => `${v} px`, (v) => {
      this.exportOptions.padding = v;
      this.updateExportSummary();
    });
    bindRange('#quality', '#qualityOut', (v) => `${v}%`, (v) => {
      this.exportOptions.quality = v / 100;
    });
    bindRange('#outlineWidth', '#outlineOut', (v) => (v ? `${v} px` : 'off'), (v) => {
      this.exportOptions.outlineWidth = v;
    });
    $('#outlineColor').addEventListener('input', (e) => {
      this.exportOptions.outlineColor = e.target.value;
    });
    $('#useMatte').addEventListener('change', (e) => {
      $('#matteRow').hidden = !e.target.checked;
      this.exportOptions.matte = e.target.checked ? $('#matteColor').value : null;
      this.updateExportSummary();
    });
    $('#matteColor').addEventListener('input', (e) => {
      if ($('#useMatte').checked) this.exportOptions.matte = e.target.value;
    });
    $('#trim').addEventListener('change', (e) => {
      this.exportOptions.trim = e.target.checked;
      this.updateExportSummary();
    });
    $('#exportBtn').addEventListener('click', () => this.export());
    $('#copyBtn').addEventListener('click', () => this.copyToClipboard());

    $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  }

  onKeyDown(event) {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
    const mod = event.ctrlKey || event.metaKey;

    if (event.code === 'Space' && !typing) {
      this.spaceHeld = true;
      this.canvas.style.cursor = 'grab';
      event.preventDefault();
      return;
    }
    // Only let a tool claim a key when focus is not in a form control, so
    // pressing Enter on a slider does not close a polygon behind your back.
    if (!typing && this.tool.key?.(this, event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      this.tool.cancel?.(this);
      return;
    }

    if (mod) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        event.shiftKey ? this.redo() : this.undo();
      } else if (key === 'y') {
        event.preventDefault();
        this.redo();
      } else if (key === 'a') {
        event.preventDefault();
        this.selectAll();
      } else if (key === 'd') {
        event.preventDefault();
        this.selectNone();
      } else if (key === 'i') {
        event.preventDefault();
        this.invert();
      } else if (key === 'e') {
        event.preventDefault();
        this.export();
      } else if (key === 'c' && this.hasSelection()) {
        event.preventDefault();
        this.copyToClipboard();
      }
      return;
    }
    if (typing) return;

    const key = event.key.toLowerCase();
    if (TOOL_KEYS[key]) {
      this.selectTool(TOOL_KEYS[key]);
    } else if (key === 'o') {
      $('#fileInput').click();
    } else if (key === '?') {
      $('#helpDialog').showModal();
    } else if (key === '[') {
      this.setBrushSize(this.settings.brushSize - Math.max(1, Math.round(this.settings.brushSize * 0.15)));
    } else if (key === ']') {
      this.setBrushSize(this.settings.brushSize + Math.max(1, Math.round(this.settings.brushSize * 0.15)));
    } else if (key === '0') {
      this.fit();
    } else if (key === '1') {
      this.setZoom(1);
    } else if (key === '+' || key === '=') {
      this.zoomBy(1.25);
    } else if (key === '-') {
      this.zoomBy(1 / 1.25);
    }
  }

  setBrushSize(size) {
    this.settings.brushSize = clamp(Math.round(size), 1, 400);
    $('#brushSize').value = this.settings.brushSize;
    $('#brushSizeOut').textContent = `${this.settings.brushSize} px`;
    this.requestRender();
  }

  /* -------------------------------------------------------- file lifecycle */

  async open(file) {
    const name = file.name || 'image';
    const looksRight = /^image\//.test(file.type)
      || ACCEPTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
    if (!looksRight) {
      this.setStatus(`“${name}” is not an image file Shapeshifter can read.`, 'error');
      return;
    }
    this.setStatus(`Opening ${name}…`, 'busy');
    try {
      const { canvas, width, height, meta } = await loadImageFile(file);
      this.source = canvas;
      this._sourceData = null;
      this.mask = new Mask(width, height);
      this.fileName = name;
      this.meta = meta;

      this.renderer.updateMask(this.mask);
      this.renderer.antsPath = null;
      this.history.reset(this.mask, 'open');
      this.app.dataset.state = 'loaded';
      $('#fileInfo').hidden = false;
      $('#fileName').textContent = name;
      $('#fileMeta').textContent = [
        `${width}x${height}`,
        meta.format,
        meta.bitDepth ? `${meta.bitDepth}-bit` : null,
        meta.compression && meta.compression !== 'uncompressed' ? meta.compression : null,
        formatBytes(meta.bytes),
      ].filter(Boolean).join(' · ');
      $('#imageInfo').textContent = `${width} x ${height}`;

      this.fit();
      this.updateStats();
      this.setStatus(`Opened ${name}. Outline the part you want to keep.`);
    } catch (error) {
      console.error(error);
      this.setStatus(error.message || 'Could not open that file.', 'error');
    }
  }

  /* ----------------------------------------------------- selection actions */

  hasSelection() {
    return Boolean(this.mask) && !this.mask.isEmpty();
  }

  selectAll() {
    if (!this.mask) return;
    this.mask.fillAll();
    this.commit('select all');
    this.setStatus('Selected the whole photo.');
  }

  selectNone() {
    if (!this.mask) return;
    this.mask.clear();
    this.commit('deselect');
    this.setStatus('Selection cleared.');
  }

  invert() {
    if (!this.mask) return;
    this.mask.invert();
    this.commit('invert');
    this.setStatus('Selection inverted.');
  }

  undo() {
    const data = this.history.undo();
    if (!data) return;
    this.mask.data.set(data);
    this.afterMaskChange();
    this.setStatus(`Undid ${this.history.label || 'the last step'}.`);
  }

  redo() {
    const data = this.history.redo();
    if (!data) return;
    this.mask.data.set(data);
    this.afterMaskChange();
    this.setStatus(`Redid ${this.history.label}.`);
  }

  /* ---------------------------------------------------------------- export */

  async export() {
    if (!this.hasSelection()) {
      this.setStatus('Outline something first — there is no shape to export yet.', 'error');
      return;
    }
    const spec = FORMATS[this.exportOptions.format];
    this.setStatus(`Building the ${spec.label}…`, 'busy');
    try {
      const result = await exportCutout(this.source, this.mask, baseName(this.fileName), this.exportOptions);
      downloadBlob(result.blob, result.filename);
      this.setStatus(
        `Exported ${result.filename} — ${result.width} x ${result.height}, ${formatBytes(result.blob.size)}.`,
      );
    } catch (error) {
      console.error(error);
      this.setStatus(error.message || 'Export failed.', 'error');
    }
  }

  async copyToClipboard() {
    if (!this.hasSelection()) return;
    try {
      const { blob } = await exportCutout(this.source, this.mask, 'cutout', {
        ...this.exportOptions,
        format: 'png',
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.setStatus('Copied the cut-out to the clipboard as a transparent PNG.');
    } catch (error) {
      this.setStatus(`Could not copy to the clipboard: ${error.message}`, 'error');
    }
  }

  updateFormatUi() {
    const spec = FORMATS[this.exportOptions.format];
    $('#formatNote').textContent = spec.note;
    $('#qualityField').hidden = !spec.quality;
    const matte = $('#useMatte');
    if (!spec.alpha) {
      matte.checked = true;
      matte.disabled = true;
      $('#matteRow').hidden = false;
      this.exportOptions.matte = $('#matteColor').value;
    } else {
      matte.disabled = false;
      $('#matteRow').hidden = !matte.checked;
      this.exportOptions.matte = matte.checked ? $('#matteColor').value : null;
    }
  }

  updateExportSummary() {
    const summary = $('#exportSummary');
    const button = $('#exportBtn');
    const copy = $('#copyBtn');
    if (!this.mask || !this.hasSelection()) {
      summary.textContent = 'Outline something to export it.';
      button.disabled = true;
      copy.disabled = true;
      return;
    }
    const region = exportRegion(this.mask, this.exportOptions);
    const w = Math.max(1, Math.round(region.width * this.exportOptions.scale));
    const h = Math.max(1, Math.round(region.height * this.exportOptions.scale));
    const spec = FORMATS[this.exportOptions.format];
    const shaped = spec.alpha && !this.exportOptions.matte;
    summary.textContent =
      `${spec.label}  ${w} x ${h} px\n`
      + (shaped
        ? 'Transparent outside your outline.'
        : this.exportOptions.format === 'mask'
          ? 'The outline as a stencil.'
          : `Filled with ${this.exportOptions.matte} outside the shape.`);
    button.disabled = false;
    copy.disabled = false;
  }

  updateStats() {
    if (!this.mask) return;
    const box = this.mask.bbox(0);
    const { coverage } = this.mask.stats();
    const total = this.mask.width * this.mask.height;
    $('#statShape').textContent = box ? `${box.width} x ${box.height}` : '—';
    $('#statCoverage').textContent = box
      ? `${((coverage / total) * 100).toFixed(1)}% · ${Math.round(coverage).toLocaleString()} px`
      : '—';
    $('#statLoops').textContent = this.renderer.loopCount ? String(this.renderer.loopCount) : '—';
    this.updateExportSummary();
  }

  /* ------------------------------------------------------------------ view */

  fit() {
    if (!this.source) return;
    const rect = this.stage.getBoundingClientRect();
    this.view.fit(this.source.width, this.source.height, rect.width, rect.height);
    this.updateZoomLabel();
    this.requestRender();
  }

  setZoom(scale) {
    if (!this.source) return;
    const rect = this.stage.getBoundingClientRect();
    this.view.setZoom(scale, rect.width, rect.height);
    this.updateZoomLabel();
    this.requestRender();
  }

  zoomBy(factor) {
    if (!this.source) return;
    const rect = this.stage.getBoundingClientRect();
    this.view.zoomAt(rect.width / 2, rect.height / 2, factor);
    this.updateZoomLabel();
    this.requestRender();
  }

  updateZoomLabel() {
    $('#zoomLabel').textContent = `${Math.round(this.view.scale * 100)}%`;
  }

  /* ------------------------------------------------------------- main loop */

  loop() {
    const step = () => {
      if (this.showAnts && this.renderer.antsPath) {
        this.renderer.antsOffset = (this.renderer.antsOffset + 0.35) % 9;
        this.needsDraw = true;
      }
      if (this.needsDraw) {
        this.needsDraw = false;
        this.renderer.draw({
          source: this.source,
          view: this.view,
          mode: this.previewMode,
          showAnts: this.showAnts,
          tool: this.pointerActive || this.tool,
          editor: this,
        });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/** Retracing the outline is the slowest step, so it runs just behind the edit. */
Shapeshifter.prototype.refreshContours = function refreshContours() {
  if (!this._debouncedTrace) {
    this._debouncedTrace = debounce(() => {
      if (!this.mask) return;
      this.renderer.updateContours(this.mask);
      $('#statLoops').textContent = this.renderer.loopCount ? String(this.renderer.loopCount) : '—';
      this.requestRender();
    }, 16);
  }
  this._debouncedTrace();
};

function bindRange(selector, outputSelector, format, onChange) {
  const input = $(selector);
  const output = $(outputSelector);
  const apply = () => {
    const value = Number(input.value);
    if (output) output.textContent = format(value);
    onChange?.(value);
  };
  input.addEventListener('input', apply);
  apply();
}

const editor = new Shapeshifter();

// A deliberate automation surface: used by the test suite, and handy for
// scripting the editor from the browser console.
window.shapeshifter = {
  editor,
  async openFile(file) {
    await editor.open(file);
  },
  async openUrl(url, name = 'image') {
    const blob = await (await fetch(url)).blob();
    await editor.open(new File([blob], name, { type: blob.type }));
  },
  selectRect(x, y, w, h, mode = COMBINE.REPLACE) {
    const path = new Path2D();
    path.rect(x, y, w, h);
    editor.stamp(editor.mask.rasterizePath(path), mode, 'rect');
  },
  selectEllipse(cx, cy, rx, ry, mode = COMBINE.REPLACE) {
    const path = new Path2D();
    path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    editor.stamp(editor.mask.rasterizePath(path), mode, 'ellipse');
  },
  selectPolygon(points, mode = COMBINE.REPLACE) {
    const path = new Path2D();
    path.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) path.lineTo(x, y);
    path.closePath();
    editor.stamp(editor.mask.rasterizePath(path), mode, 'polygon');
  },
  wandAt(x, y, options = {}) {
    Object.assign(editor.settings, options);
    editor.selectTool('wand');
    TOOL_BY_ID.wand.down(editor, { x, y }, {});
  },
  setExportOptions(options) {
    Object.assign(editor.exportOptions, options);
    editor.updateExportSummary();
  },
  async exportBlob(options = {}) {
    const result = await exportCutout(
      editor.source,
      editor.mask,
      baseName(editor.fileName),
      { ...editor.exportOptions, ...options },
    );
    return result;
  },
  async exportDataUrl(options = {}) {
    const { blob, filename, width, height } = await this.exportBlob(options);
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, filename, width, height, size: blob.size };
  },
  state() {
    return {
      loaded: Boolean(editor.source),
      width: editor.source?.width ?? 0,
      height: editor.source?.height ?? 0,
      meta: editor.meta,
      bbox: editor.mask?.bbox(0) ?? null,
      hasSelection: editor.hasSelection(),
      loops: editor.renderer.loopCount ?? 0,
      status: $('#statusMsg').textContent,
    };
  },
};
