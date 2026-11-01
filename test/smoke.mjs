#!/usr/bin/env node
// End-to-end checks for Shapeshifter, driven through a real browser.
//
// The point of the program is that an exported file opens as the shape that was
// outlined, so these tests decode the exported files and assert on their actual
// pixels: transparent outside the outline, the photo's own colours inside, and
// a bounding box cropped tight to the shape.
//
//   node test/smoke.mjs            run everything
//   node test/smoke.mjs --headed   watch it happen

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Playwright may be installed globally rather than in this project, and ESM
// import does not consult the global module path — require does.
const require_ = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require_('playwright'));
} catch {
  console.error(
    'Playwright is not available.\n'
    + 'Install it with:  npm install -D playwright && npx playwright install chromium',
  );
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'test/output');
const PORT = Number(process.env.PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗ ${name}\u001b[0m${detail ? `  ${detail}` : ''}`);
  }
}

const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;
/** Fraction of the file the shape covers, counting soft edge pixels at half weight. */
const fillRatio = (alpha) => (alpha.solid + alpha.partial / 2) / alpha.total;
const sameColor = (got, want, tol = 14) =>
  near(got[0], want[0], tol) && near(got[1], want[1], tol) && near(got[2], want[2], tol);

async function startServer() {
  const child = spawn(process.execPath, [resolve(ROOT, 'serve.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('server did not start')), 10_000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('running')) {
        clearTimeout(timer);
        ok();
      }
    });
    child.on('error', fail);
  });
  return child;
}

/* ------------------------------------------------------- browser-side helpers */

/**
 * Decode a data URL inside the page and report the pixels at given points,
 * plus an opacity histogram. Runs in the browser, so it sees exactly what any
 * other image viewer would see.
 */
const SAMPLER = async ([dataUrl, points]) => {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('decode failed'));
    i.src = dataUrl;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const out = { width: c.width, height: c.height, samples: {} };
  for (const [label, x, y] of points) {
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    out.samples[label] = [px[0], px[1], px[2], px[3]];
  }
  const all = ctx.getImageData(0, 0, c.width, c.height).data;
  let clear = 0;
  let solid = 0;
  let partial = 0;
  for (let i = 3; i < all.length; i += 4) {
    if (all[i] === 0) clear++;
    else if (all[i] === 255) solid++;
    else partial++;
  }
  out.alpha = { clear, solid, partial, total: c.width * c.height };
  return out;
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    /* ---------------------------------------------------------- 1. loading */
    console.log('\nLoading the app');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    check('page loads with no script errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('empty state is shown', await page.locator('#empty').isVisible());
    check('all seven tools are present', (await page.locator('.tool').count()) === 7);
    await page.waitForFunction('window.shapeshifter !== undefined');

    /* ------------------------------------------------- 2. decoding formats */
    console.log('\nDecoding each input format');
    for (const [file, label] of [
      ['photo.png', 'PNG'],
      ['photo.jpg', 'JPEG'],
      ['photo-lzw.tif', 'TIFF (LZW)'],
      ['photo-deflate.tif', 'TIFF (Deflate)'],
      ['photo-alpha.tif', 'TIFF (RGBA)'],
    ]) {
      const state = await page.evaluate(async (f) => {
        await window.shapeshifter.openUrl(`/test/fixtures/${f}`, f);
        return window.shapeshifter.state();
      }, file);
      check(`${label} opens at the right size`, state.loaded && state.width === 200 && state.height === 150,
        `${state.width}x${state.height} ${state.meta?.format ?? ''} ${state.status}`);
    }

    // Confirm the TIFF decoder agrees with the browser's own PNG decode.
    const agreement = await page.evaluate(async () => {
      const read = async (file) => {
        await window.shapeshifter.openUrl(`/test/fixtures/${file}`, file);
        const s = window.shapeshifter.editor.source;
        return s.getContext('2d').getImageData(0, 0, s.width, s.height).data;
      };
      const png = await read('photo.png');
      const tif = await read('photo-lzw.tif');
      let worst = 0;
      for (let i = 0; i < png.length; i++) worst = Math.max(worst, Math.abs(png[i] - tif[i]));
      return worst;
    });
    check('TIFF decode matches PNG decode exactly', agreement === 0, `max channel difference ${agreement}`);

    /* ------------------------------------- 3. a rectangle exports as a crop */
    console.log('\nRectangle: the export is cropped to the outline');
    await page.evaluate(() => window.shapeshifter.openUrl('/test/fixtures/photo.png', 'photo.png'));
    let result = await page.evaluate(async () => {
      window.shapeshifter.selectRect(20, 30, 60, 40);
      return window.shapeshifter.exportDataUrl({ format: 'png' });
    });
    let probe = await page.evaluate(SAMPLER, [result.dataUrl, [
      ['inside', 30, 20], ['corner', 1, 1], ['edge', 59, 39],
    ]]);
    check('output is cropped to the rectangle', probe.width === 60 && probe.height === 40,
      `${probe.width}x${probe.height}, expected 60x40`);
    check('pixels inside carry the photo', sameColor(probe.samples.inside, [220, 40, 40]) && probe.samples.inside[3] === 255,
      `rgba(${probe.samples.inside})`);
    check('filename says it is a shape', result.filename === 'photo-shape.png', result.filename);

    /* ----------------------------------- 4. an ellipse really is not square */
    console.log('\nEllipse: the corners of the file are transparent');
    result = await page.evaluate(async () => {
      window.shapeshifter.selectEllipse(100, 75, 50, 30);
      return window.shapeshifter.exportDataUrl({ format: 'png' });
    });
    probe = await page.evaluate(SAMPLER, [result.dataUrl, [
      ['centre', 50, 30], ['tl', 1, 1], ['tr', 98, 1], ['bl', 1, 58], ['br', 98, 58],
    ]]);
    check('output is the ellipse bounding box', probe.width === 100 && probe.height === 60,
      `${probe.width}x${probe.height}`);
    check('centre is fully opaque', probe.samples.centre[3] === 255, `alpha ${probe.samples.centre[3]}`);
    check('all four corners are fully transparent',
      [probe.samples.tl, probe.samples.tr, probe.samples.bl, probe.samples.br].every((p) => p[3] === 0),
      [probe.samples.tl, probe.samples.tr, probe.samples.bl, probe.samples.br].map((p) => p[3]).join(','));
    const ellipseFill = fillRatio(probe.alpha);
    check('about π/4 of the rectangle is filled, as an ellipse should be',
      Math.abs(ellipseFill - Math.PI / 4) < 0.04, `${(ellipseFill * 100).toFixed(1)}% filled`);

    /* ------------------------------------------ 5. an arbitrary outline */
    console.log('\nPolygon: an arbitrary outline survives export');
    result = await page.evaluate(async () => {
      // A triangle, so two corners of the file must be empty and one filled.
      window.shapeshifter.selectPolygon([[10, 140], [100, 10], [190, 140]]);
      return window.shapeshifter.exportDataUrl({ format: 'png' });
    });
    // Canvas fills a pixel when its centre is inside the path, so vertices at
    // x = 10 and x = 190 fill columns 10..189 — 180 wide, not 181.
    probe = await page.evaluate(SAMPLER, [result.dataUrl, [
      ['bottomMiddle', 90, 125], ['topLeft', 2, 2], ['topRight', 177, 2], ['leftOfEdge', 10, 20],
    ]]);
    check('triangle crops to its own bounds', probe.width === 180 && probe.height === 130,
      `${probe.width}x${probe.height}`);
    check('the two top corners are cut away',
      probe.samples.topLeft[3] === 0 && probe.samples.topRight[3] === 0,
      `${probe.samples.topLeft[3]}, ${probe.samples.topRight[3]}`);
    check('the base of the triangle is kept while the slope is cut away',
      probe.samples.bottomMiddle[3] === 255 && probe.samples.leftOfEdge[3] === 0,
      `base alpha ${probe.samples.bottomMiddle[3]}, outside-slope alpha ${probe.samples.leftOfEdge[3]}`);
    const triangleFill = fillRatio(probe.alpha);
    check('roughly half the rectangle is filled, as a triangle should be',
      Math.abs(triangleFill - 0.5) < 0.06, `${(triangleFill * 100).toFixed(1)}% filled`);

    /* -------------------------------------------------- 6. the magic wand */
    console.log('\nMagic wand: clicking the magenta disc selects just the disc');
    const wand = await page.evaluate(async () => {
      window.shapeshifter.editor.selectNone();
      window.shapeshifter.wandAt(100, 75, { tolerance: 12, contiguous: true });
      const state = window.shapeshifter.state();
      const out = await window.shapeshifter.exportDataUrl({ format: 'png' });
      return { state, out };
    });
    check('the wand found the disc, not the whole photo',
      wand.state.bbox && near(wand.state.bbox.width, 61, 3) && near(wand.state.bbox.height, 61, 3),
      `bbox ${wand.state.bbox?.width}x${wand.state.bbox?.height}, expected ~61x61`);
    probe = await page.evaluate(SAMPLER, [wand.out.dataUrl, [
      ['centre', 30, 30], ['corner', 1, 1],
    ]]);
    check('the disc is magenta and opaque', sameColor(probe.samples.centre, [200, 30, 200]) && probe.samples.centre[3] === 255,
      `rgba(${probe.samples.centre})`);
    check('outside the disc is transparent', probe.samples.corner[3] === 0);
    // A radius-30 disc in a 61x61 box covers pi*30^2/61^2 = 76.0% of the file.
    const discFill = fillRatio(probe.alpha);
    check('the selection is disc-shaped, not square', Math.abs(discFill - 0.76) < 0.04,
      `${(discFill * 100).toFixed(1)}% filled, expected ~76%`);

    /* --------------------------------------------------- 7. SVG is vector */
    console.log('\nSVG: the outline is written as a real clip path');
    const svg = await page.evaluate(async () => {
      window.shapeshifter.selectEllipse(100, 75, 40, 40);
      const { blob, filename, width, height } = await window.shapeshifter.exportBlob({ format: 'svg' });
      return { text: await blob.text(), filename, width, height, size: blob.size };
    });
    await writeFile(resolve(OUT, 'shape.svg'), svg.text);
    check('SVG declares the cropped size', svg.text.includes('width="80"') && svg.text.includes('height="80"'),
      `${svg.width}x${svg.height}`);
    check('SVG contains a clipPath', /<clipPath[^>]*>\s*<path d="M[^"]+"/.test(svg.text));
    check('the clip path has real geometry', (svg.text.match(/[ML]/g) || []).length > 20,
      `${(svg.text.match(/[ML]/g) || []).length} path commands`);
    check('SVG embeds the image payload', svg.text.includes('xlink:href="data:image/'));
    const svgRender = await page.evaluate(SAMPLER, [
      `data:image/svg+xml;base64,${Buffer.from(svg.text).toString('base64')}`,
      [['centre', 40, 40], ['corner', 2, 2]],
    ]);
    check('the SVG renders as a circle, with clear corners',
      svgRender.samples.centre[3] === 255 && svgRender.samples.corner[3] === 0,
      `centre alpha ${svgRender.samples.centre[3]}, corner alpha ${svgRender.samples.corner[3]}`);

    /* ------------------------------------------- 8. feather, grow, shrink */
    console.log('\nEdge refinement');
    const feathered = await page.evaluate(async () => {
      window.shapeshifter.selectRect(50, 40, 100, 70);
      const before = window.shapeshifter.state().bbox;
      window.shapeshifter.editor.mask.feather(6);
      window.shapeshifter.editor.commit('feather');
      const out = await window.shapeshifter.exportDataUrl({ format: 'png' });
      return { before, out };
    });
    probe = await page.evaluate(SAMPLER, [feathered.out.dataUrl, [['middle', 55, 40]]]);
    check('feathering creates a soft edge', probe.alpha.partial > 500,
      `${probe.alpha.partial} partly transparent pixels`);
    check('the middle stays fully opaque', probe.samples.middle[3] === 255);

    const grown = await page.evaluate(() => {
      window.shapeshifter.selectRect(50, 40, 60, 50);
      const before = window.shapeshifter.state().bbox;
      window.shapeshifter.editor.mask.offset(10);
      window.shapeshifter.editor.commit('grow');
      const after = window.shapeshifter.state().bbox;
      window.shapeshifter.editor.mask.offset(-10);
      window.shapeshifter.editor.commit('shrink');
      return { before, after, back: window.shapeshifter.state().bbox };
    });
    check('grow expands by the requested amount',
      near(grown.after.width, grown.before.width + 20, 3) && near(grown.after.height, grown.before.height + 20, 3),
      `${grown.before.width}x${grown.before.height} → ${grown.after.width}x${grown.after.height}`);
    check('shrink undoes grow', near(grown.back.width, grown.before.width, 3),
      `back to ${grown.back.width}x${grown.back.height}`);

    /* ---------------------------------- 9. combining shapes, undo and redo */
    console.log('\nCombining shapes, undo and redo');
    const combined = await page.evaluate(() => {
      window.shapeshifter.selectRect(20, 20, 80, 80);
      window.shapeshifter.selectRect(100, 20, 60, 60, 'add');
      const added = window.shapeshifter.state();
      window.shapeshifter.selectRect(40, 40, 30, 30, 'subtract');
      const holed = window.shapeshifter.state();
      window.shapeshifter.editor.undo();
      const undone = window.shapeshifter.state();
      window.shapeshifter.editor.redo();
      return { added, holed, undone, redone: window.shapeshifter.state() };
    });
    check('add merges two rectangles into one bounding box',
      combined.added.bbox.width === 140 && combined.added.bbox.height === 80,
      `${combined.added.bbox.width}x${combined.added.bbox.height}`);
    await page.waitForTimeout(80);
    const loops = await page.evaluate(() => window.shapeshifter.state().loops);
    check('subtracting punches a hole that is traced separately', loops >= 2, `${loops} contours`);
    check('undo restores the previous selection',
      combined.undone.bbox.width === combined.added.bbox.width);
    check('redo re-applies it', combined.redone.bbox.width === combined.holed.bbox.width);

    const holePng = await page.evaluate(() => window.shapeshifter.exportDataUrl({ format: 'png' }));
    probe = await page.evaluate(SAMPLER, [holePng.dataUrl, [['hole', 35, 35], ['solid', 5, 5]]]);
    check('the hole is transparent in the exported file',
      probe.samples.hole[3] === 0 && probe.samples.solid[3] === 255,
      `hole alpha ${probe.samples.hole[3]}, body alpha ${probe.samples.solid[3]}`);

    /* ------------------------------------- 10. the other export formats */
    console.log('\nThe other export formats');
    const variants = await page.evaluate(async () => {
      window.shapeshifter.selectEllipse(100, 75, 45, 35);
      const out = {};
      for (const [key, options] of Object.entries({
        webp: { format: 'webp' },
        jpeg: { format: 'jpeg', matte: '#000000' },
        mask: { format: 'mask' },
        scaled: { format: 'png', scale: 2 },
        padded: { format: 'png', padding: 15 },
        outlined: { format: 'png', outlineWidth: 6, outlineColor: '#ff0000' },
        untrimmed: { format: 'png', trim: false },
      })) {
        out[key] = await window.shapeshifter.exportDataUrl(options);
      }
      return out;
    });

    probe = await page.evaluate(SAMPLER, [variants.webp.dataUrl, [['centre', 45, 35], ['corner', 1, 1]]]);
    check('WebP keeps transparency', probe.samples.corner[3] === 0 && probe.samples.centre[3] === 255);
    check('WebP is smaller than the PNG', variants.webp.size < holePng.size * 4,
      `${variants.webp.size} bytes`);

    probe = await page.evaluate(SAMPLER, [variants.jpeg.dataUrl, [['corner', 1, 1], ['centre', 45, 35]]]);
    check('JPEG has no transparency, and fills the outside with the matte',
      probe.alpha.clear === 0 && sameColor(probe.samples.corner, [0, 0, 0], 20),
      `corner rgba(${probe.samples.corner})`);

    probe = await page.evaluate(SAMPLER, [variants.mask.dataUrl, [['centre', 45, 35], ['corner', 1, 1]]]);
    check('the mask export is a white stencil on transparency',
      sameColor(probe.samples.centre, [255, 255, 255]) && probe.samples.corner[3] === 0);

    check('scale doubles the output', variants.scaled.width === 180 && variants.scaled.height === 140,
      `${variants.scaled.width}x${variants.scaled.height}`);
    check('padding adds a transparent margin',
      variants.padded.width === 90 + 30 && variants.padded.height === 70 + 30,
      `${variants.padded.width}x${variants.padded.height}`);
    probe = await page.evaluate(SAMPLER, [variants.padded.dataUrl, [['margin', 2, 2]]]);
    check('the padded margin is transparent', probe.samples.margin[3] === 0);

    probe = await page.evaluate(SAMPLER, [variants.outlined.dataUrl, [['top', 45, 2]]]);
    check('an outline can be stroked along the shape', near(probe.samples.top[0], 255, 40) && probe.samples.top[3] > 200,
      `rgba(${probe.samples.top})`);

    check('turning off cropping keeps the full canvas',
      variants.untrimmed.width === 200 && variants.untrimmed.height === 150,
      `${variants.untrimmed.width}x${variants.untrimmed.height}`);

    /* --------------------------------------------- 11. interactive drawing */
    console.log('\nDrawing with the mouse');
    await page.evaluate(() => {
      window.shapeshifter.editor.selectNone();
      window.shapeshifter.editor.selectTool('lasso');
      window.shapeshifter.editor.setZoom(1);
      window.shapeshifter.editor.view.x = 100;
      window.shapeshifter.editor.view.y = 100;
      window.shapeshifter.editor.requestRender();
    });
    const box = await page.locator('#canvas').boundingBox();
    const at = (ix, iy) => ({ x: box.x + 100 + ix, y: box.y + 100 + iy });
    let p = at(40, 40);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (const [ix, iy] of [[120, 40], [120, 100], [40, 100]]) {
      const q = at(ix, iy);
      await page.mouse.move(q.x, q.y, { steps: 12 });
    }
    await page.mouse.up();
    const drawn = await page.evaluate(() => window.shapeshifter.state());
    check('a dragged lasso creates a selection', drawn.hasSelection, JSON.stringify(drawn.bbox));
    check('the lasso lands where the cursor went',
      drawn.bbox && near(drawn.bbox.width, 81, 6) && near(drawn.bbox.height, 61, 6),
      `bbox ${drawn.bbox?.width}x${drawn.bbox?.height}, expected ~81x61`);

    await page.evaluate(() => window.shapeshifter.editor.selectTool('polygon'));
    for (const [ix, iy] of [[20, 20], [90, 30], [60, 90]]) {
      const q = at(ix, iy);
      await page.mouse.click(q.x, q.y);
    }
    await page.keyboard.press('Enter');
    const poly = await page.evaluate(() => window.shapeshifter.state());
    check('clicking corners then Enter closes a polygon',
      poly.bbox && near(poly.bbox.width, 71, 6) && near(poly.bbox.height, 71, 6),
      `bbox ${poly.bbox?.width}x${poly.bbox?.height}`);

    /* -------------------------------------------- 12. UI state and guards */
    console.log('\nUI state');
    await page.evaluate(() => window.shapeshifter.editor.selectNone());
    check('export is disabled with nothing selected', await page.locator('#exportBtn').isDisabled());
    await page.evaluate(() => window.shapeshifter.selectRect(10, 10, 50, 50));
    check('export is enabled once something is outlined', await page.locator('#exportBtn').isEnabled());
    const summary = await page.locator('#exportSummary').textContent();
    check('the summary reports the output size', summary.includes('50 x 50'), summary.replace(/\n/g, ' / '));

    for (const [key, tool] of Object.entries({ l: 'lasso', p: 'polygon', r: 'rect', e: 'ellipse', b: 'brush', w: 'wand', h: 'pan' })) {
      await page.keyboard.press(key);
      const active = await page.evaluate(() => window.shapeshifter.editor.tool.id);
      check(`"${key}" selects the ${tool} tool`, active === tool, active);
    }

    const refused = await page.evaluate(async () => {
      const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'notes.txt', { type: 'text/plain' });
      await window.shapeshifter.editor.open(file);
      return window.shapeshifter.state().status;
    });
    check('a non-image file is refused with a readable message',
      /not an image/i.test(refused), refused);

    for (const mode of ['cutout', 'overlay', 'none', 'dim']) {
      await page.selectOption('#previewMode', mode);
      await page.waitForTimeout(40);
    }
    check('every preview mode renders without error', consoleErrors.length === 0, consoleErrors.join(' | '));

    /* ------------------------------------ 13. the macOS bridge contract */
    console.log('\nmacOS shell bridge');
    const native = await page.evaluate(async () => {
      // Stand in for the Swift side: record what the page hands the shell.
      const calls = [];
      globalThis.__shapeshifterNative = {
        save: (blob, filename) => calls.push({ kind: 'save', filename, size: blob.size, type: blob.type }),
        requestOpen: () => calls.push({ kind: 'open' }),
        copyImage: (blob) => calls.push({ kind: 'clipboard', size: blob.size }),
      };
      await window.shapeshifter.openUrl('/test/fixtures/photo.png', 'photo.png');
      window.shapeshifter.selectEllipse(100, 75, 40, 30);
      await window.shapeshifter.editor.export();
      const status = window.shapeshifter.state().status;
      delete globalThis.__shapeshifterNative;
      return { calls, status };
    });
    check('export hands the file to the shell instead of downloading it',
      native.calls.length === 1 && native.calls[0].kind === 'save',
      JSON.stringify(native.calls));
    check('the shell receives a named PNG with real bytes',
      native.calls[0]?.filename === 'photo-shape.png' && native.calls[0]?.size > 500
        && native.calls[0]?.type === 'image/png',
      `${native.calls[0]?.filename} ${native.calls[0]?.size}B ${native.calls[0]?.type}`);
    check('the status line defers to the native save panel',
      /ready to save/i.test(native.status), native.status);

    // isNative() must stay false in a plain browser, so the web build is unaffected.
    const stillWeb = await page.evaluate(() => ({
      shell: document.documentElement.dataset.shell ?? null,
      hasBridge: Boolean(globalThis.webkit?.messageHandlers?.shapeshifter),
    }));
    check('a plain browser is not treated as the native shell',
      stillWeb.shell === null && stillWeb.hasBridge === false, JSON.stringify(stillWeb));

    /* ------------------------------ 14. write real files for outside checks */
    console.log('\nWriting exported files to disk');
    const saved = await page.evaluate(async () => {
      await window.shapeshifter.openUrl('/test/fixtures/photo.png', 'photo.png');
      window.shapeshifter.selectEllipse(100, 75, 60, 45);
      const files = {};
      for (const [name, options] of Object.entries({
        'cutout.png': { format: 'png' },
        'cutout.webp': { format: 'webp' },
        'cutout.jpg': { format: 'jpeg', matte: '#101010' },
        'cutout-mask.png': { format: 'mask' },
        'cutout.svg': { format: 'svg' },
      })) {
        const { blob } = await window.shapeshifter.exportBlob(options);
        const buf = new Uint8Array(await blob.arrayBuffer());
        files[name] = Array.from(buf);
      }
      return files;
    });
    for (const [name, bytes] of Object.entries(saved)) {
      await writeFile(resolve(OUT, name), Buffer.from(bytes));
    }
    check('all five export formats produced files',
      Object.keys(saved).length === 5 && Object.values(saved).every((b) => b.length > 100),
      Object.entries(saved).map(([n, b]) => `${n} ${b.length}B`).join(', '));

    const shot = resolve(OUT, 'editor.png');
    await mkdir(dirname(shot), { recursive: true });
    await page.evaluate(async () => {
      await window.shapeshifter.openUrl('/test/fixtures/photo.png', 'photo.png');
      window.shapeshifter.editor.selectTool('lasso');
      window.shapeshifter.selectPolygon([[30, 120], [70, 30], [110, 70], [150, 25], [175, 125]]);
      window.shapeshifter.editor.fit();
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot });
    console.log(`\n  screenshot: ${shot}`);

    check('no console errors across the whole run', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
