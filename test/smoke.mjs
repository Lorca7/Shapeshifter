#!/usr/bin/env node
// End-to-end checks, driven through a real browser with real mouse input.
//
// What matters is that the saved file is the shape that was traced, so these
// open the PNG that actually gets downloaded and look at its pixels.
//
//   node test/smoke.mjs                     Chromium
//   BROWSER=webkit node test/smoke.mjs      WebKit, the engine the Mac app uses
//   node test/smoke.mjs --headed            watch it happen

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
const BROWSER = process.env.BROWSER || 'chromium';
let engine;
try {
  engine = require_('playwright')[BROWSER];
  if (!engine) throw new Error(`unknown browser "${BROWSER}"`);
} catch (error) {
  console.error(`Playwright is not available (${error.message}).\n`
    + 'Install it with:  npm install -D playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'test/output');
const PORT = Number(process.env.PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

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

/** Decode a PNG data URL in the page and report pixels, plus an opacity tally. */
const SAMPLE = async ([dataUrl, points]) => {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('could not decode the saved file'));
    i.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const samples = {};
  for (const [label, x, y] of points) {
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    samples[label] = [px[0], px[1], px[2], px[3]];
  }
  const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let clear = 0;
  let solid = 0;
  let soft = 0;
  for (let i = 3; i < all.length; i += 4) {
    if (all[i] === 0) clear++;
    else if (all[i] === 255) solid++;
    else soft++;
  }
  return { width: canvas.width, height: canvas.height, samples, clear, solid, soft, total: canvas.width * canvas.height };
};

/** Wait until the page has painted, so screenshots and pixel reads see the latest drawing. */
const painted = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** The colour actually on screen where an image coordinate sits. */
const onScreen = (page, x, y) => page.evaluate(([ix, iy]) => {
  const e = window.shapeshifter;
  const at = e.view.toScreen(ix, iy);
  const dpr = e.renderer.dpr;
  const d = e.canvas.getContext('2d').getImageData(Math.round(at.x * dpr), Math.round(at.y * dpr), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [x, y]);

const bytesToDataUrl = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

/** A regular polygon, as [x, y] pairs. */
const ring = (cx, cy, r, sides) =>
  Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  const browser = await engine.launch({
    headless: !HEADED,
    ...(BROWSER === 'chromium' ? { args: ['--no-sandbox'] } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const state = () => page.evaluate(() => window.shapeshifter.state());
  const clickImage = async (x, y) => {
    const at = await page.evaluate(([px, py]) => window.shapeshifter.toClient(px, py), [x, y]);
    await page.mouse.click(at.x, at.y);
  };
  const open = (file) => page.evaluate((f) => window.shapeshifter.openUrl(`/test/fixtures/${f}`, f), file);

  console.log(`\nEngine: ${BROWSER}`);

  try {
    /* ------------------------------------------------------------ 1. start */
    console.log('\nStarting out');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    check('the page loads without errors', errors.length === 0, errors.join(' | '));
    check('it invites you to drop or choose a photo', await page.locator('#chooseBtn').isVisible());
    check('nothing else is on screen yet',
      !(await page.locator('#primaryBtn').isVisible()) && !(await page.locator('#undoBtn').isVisible()));

    /* ------------------------------------------------------ 2. input formats */
    console.log('\nOpening photos');
    for (const [file, label] of [
      ['photo.png', 'PNG'], ['photo.jpg', 'JPEG'], ['photo-lzw.tif', 'TIFF (LZW)'],
      ['photo-deflate.tif', 'TIFF (Deflate)'], ['photo-alpha.tif', 'TIFF with transparency'],
    ]) {
      await open(file);
      const s = await state();
      check(`${label} opens`, s.loaded && s.width === 200 && s.height === 150, `${s.width}x${s.height}`);
    }
    const worst = await page.evaluate(async () => {
      const read = async (f) => {
        await window.shapeshifter.openUrl(`/test/fixtures/${f}`, f);
        const p = window.shapeshifter.photo;
        return p.getContext('2d').getImageData(0, 0, p.width, p.height).data;
      };
      const png = await read('photo.png');
      const tif = await read('photo-lzw.tif');
      return png.reduce((m, v, i) => Math.max(m, Math.abs(v - tif[i])), 0);
    });
    check('TIFF pixels match the PNG exactly', worst === 0, `max difference ${worst}`);

    await open('photo.png');
    check('the toolbar appears once a photo is open', await page.locator('#primaryBtn').isVisible());
    check('there is nothing to finish yet', await page.locator('#primaryBtn').isDisabled());

    /* ------------------------------------------- 3. trace with the mouse */
    console.log('\nTracing with the mouse');
    const octagon = ring(100, 75, 36, 12);
    for (const [i, [x, y]] of octagon.entries()) {
      await clickImage(x, y);
      const s = await state();
      if (i === 1) check('two points are not yet an outline', s.points.length === 2 && await page.locator('#primaryBtn').isDisabled());
      if (i === 2) check('three points can be finished', s.points.length === 3 && await page.locator('#primaryBtn').isEnabled());
      if (!s.closed && s.points.length !== i + 1) {
        check(`click ${i + 1} adds exactly one point`, false, `have ${s.points.length}`);
      }
    }
    let s = await state();
    await painted(page);
    let seen = await onScreen(page, 20, 20);
    check('while tracing, the whole photo stays visible',
      near(seen[0], 220, 20) && near(seen[1], 40, 20), `top-left of the photo shows rgb(${seen.slice(0, 3)})`);
    check('every click dropped a point', s.points.length === 12 && !s.closed, `${s.points.length} points`);
    check('the hint points at the first point', /first point/i.test(s.hint), s.hint);

    await clickImage(...octagon[0]);
    s = await state();
    check('clicking the first point closes the outline', s.closed && s.points.length === 12);
    check('the main button now saves', s.primary === 'Save cutout', s.primary);
    check('the outline is bounded around the object',
      s.region && near(s.region.width, 72, 2) && near(s.region.height, 72, 2), JSON.stringify(s.region));

    await painted(page);
    seen = await onScreen(page, 100, 75);
    check('closing keeps the traced object on screen', near(seen[0], 200, 12) && near(seen[1], 30, 12) && near(seen[2], 200, 12),
      `the object shows rgb(${seen.slice(0, 3)})`);
    seen = await onScreen(page, 20, 20);
    check('and erases the rest, leaving a transparency checkerboard',
      seen[1] > 150 && seen[2] > 150, `where the photo was, the screen shows rgb(${seen.slice(0, 3)})`);
    await page.screenshot({ path: resolve(OUT, 'closed.png') });

    /* ----------------------------------------------- 4. save via the button */
    console.log('\nSaving');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#primaryBtn').click(),
    ]);
    const savedPath = resolve(OUT, 'cutout.png');
    await download.saveAs(savedPath);
    check('it saves a PNG named after the photo', download.suggestedFilename() === 'photo-cutout.png',
      download.suggestedFilename());
    const saved = bytesToDataUrl(await readFile(savedPath));
    let px = await page.evaluate(SAMPLE, [saved, [['centre', 36, 36], ['topLeft', 1, 1], ['topRight', 70, 1], ['bottomLeft', 1, 70], ['bottomRight', 70, 70]]]);
    check('the file is cropped to the outline', near(px.width, 72, 2) && near(px.height, 72, 2), `${px.width}x${px.height}`);
    check('the traced object is kept, in its own colours',
      px.samples.centre[3] === 255 && near(px.samples.centre[0], 200, 8) && near(px.samples.centre[1], 30, 8) && near(px.samples.centre[2], 200, 8),
      `rgba(${px.samples.centre})`);
    check('everything outside the outline is fully transparent',
      ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].every((k) => px.samples[k][3] === 0),
      ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((k) => px.samples[k][3]).join(','));
    const fill = (px.solid + px.soft / 2) / px.total;
    // A 12-sided shape in a circle of radius r covers 3r^2 of the 4r^2 box around it.
    check('the shape is round, not a filled rectangle', near(fill, 0.75, 0.04), `${(fill * 100).toFixed(1)}% of the file is filled`);
    check('the edge is smooth, not stair-stepped', px.soft > 40, `${px.soft} partly transparent edge pixels`);

    /* ----------------------------------------------------- 5. precision */
    console.log('\nPrecision');
    await page.evaluate(() => { window.shapeshifter.startOver(); window.shapeshifter.fit(); });
    await page.evaluate(() => window.shapeshifter.zoomBy(8));
    const zoom = (await state()).scale;
    await clickImage(103.5, 78.25);
    s = await state();
    const err = Math.hypot(s.points[0].x - 103.5, s.points[0].y - 78.25);
    check('zoomed in, a click lands within a fraction of a pixel',
      err < 0.5 / zoom + 0.05, `off by ${err.toFixed(3)} photo px at ${zoom.toFixed(1)}x`);
    await page.evaluate(() => window.shapeshifter.fit());

    /* ------------------------------------------------ 6. adjusting points */
    console.log('\nAdjusting the outline');
    await page.evaluate((pts) => window.shapeshifter.trace(pts), ring(100, 75, 40, 8));
    s = await state();
    const before = s.points[0];
    const scale = s.scale;
    const grab = await page.evaluate(([x, y]) => window.shapeshifter.toClient(x, y), [before.x, before.y]);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x - 15, grab.y - 9, { steps: 6 });
    await page.mouse.up();
    s = await state();
    check('dragging a point moves it by exactly how far you dragged',
      near(s.points[0].x, before.x - 15 / scale, 0.3) && near(s.points[0].y, before.y - 9 / scale, 0.3),
      `moved ${(before.x - s.points[0].x).toFixed(2)}, ${(before.y - s.points[0].y).toFixed(2)} (expected ${(15 / scale).toFixed(2)}, ${(9 / scale).toFixed(2)})`);
    check('moving a point does not add or remove any', s.points.length === 8 && s.closed);

    const a = s.points[2];
    const b = s.points[3];
    const mid = await page.evaluate(([x, y]) => window.shapeshifter.toClient(x, y), [(a.x + b.x) / 2, (a.y + b.y) / 2]);
    await page.mouse.click(mid.x, mid.y);
    s = await state();
    check('clicking an edge adds a point there', s.points.length === 9, `${s.points.length} points`);
    const inserted = s.points[3];
    const onLine = Math.abs((b.x - a.x) * (a.y - inserted.y) - (a.x - inserted.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);
    check('the new point sits on the edge it was added to', onLine < 0.3, `${onLine.toFixed(3)} photo px off the line`);

    const target = await page.evaluate(([x, y]) => window.shapeshifter.toClient(x, y), [s.points[5].x, s.points[5].y]);
    await page.mouse.move(target.x, target.y);
    await page.keyboard.press('Backspace');
    s = await state();
    check('Delete removes the point under the cursor', s.points.length === 8, `${s.points.length} points`);

    await page.evaluate((pts) => window.shapeshifter.trace(pts), ring(100, 75, 40, 3));
    const corner = (await state()).points[1];
    const hit = await page.evaluate(([x, y]) => window.shapeshifter.toClient(x, y), [corner.x, corner.y]);
    await page.mouse.move(hit.x, hit.y);
    await page.keyboard.press('Backspace');
    s = await state();
    check('an outline cannot shrink below three points', s.points.length === 3 && s.hintKind === 'error', s.hint);

    /* ------------------------------------------------------- 7. undo/redo */
    console.log('\nUndo');
    await page.evaluate(() => window.shapeshifter.startOver());
    await clickImage(40, 40);
    await clickImage(120, 40);
    await clickImage(80, 110);
    check('three clicks make three points', (await state()).points.length === 3);
    await page.keyboard.press('Control+z');
    check('Undo removes the last point', (await state()).points.length === 2);
    await page.keyboard.press('Control+Shift+z');
    check('Redo puts it back', (await state()).points.length === 3);
    await page.locator('#undoBtn').click();
    check('the Undo button works too', (await state()).points.length === 2);
    await page.locator('#resetBtn').click();
    check('Start over clears the outline', (await state()).points.length === 0);
    await page.keyboard.press('Control+z');
    check('and even that can be undone', (await state()).points.length === 2);

    /* ------------------------------------------------------------- 8. pan */
    console.log('\nMoving around');
    await page.evaluate(() => { window.shapeshifter.startOver(); window.shapeshifter.fit(); });
    const v0 = await state();
    const box = await page.locator('#canvas').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 70, { steps: 5 });
    await page.mouse.up();
    const v1 = await state();
    check('dragging empty space moves the photo', near(v1.viewX - v0.viewX, 60, 2) && near(v1.viewY - v0.viewY, 40, 2),
      `moved ${(v1.viewX - v0.viewX).toFixed(0)}, ${(v1.viewY - v0.viewY).toFixed(0)}`);
    check('and does not drop a stray point', v1.points.length === 0);

    /* ---------------------------------------------- 9. a different shape */
    console.log('\nAny shape works');
    await page.evaluate(() => window.shapeshifter.fit());
    const tri = await page.evaluate(async () => {
      window.shapeshifter.trace([[10, 140], [100, 10], [190, 140]]);
      return window.shapeshifter.exportDataUrl();
    });
    px = await page.evaluate(SAMPLE, [tri.dataUrl, [['apex', 90, 2], ['baseMid', 90, 125], ['topLeft', 3, 3], ['topRight', 175, 3]]]);
    check('a triangle comes out triangular',
      px.samples.baseMid[3] === 255 && px.samples.topLeft[3] === 0 && px.samples.topRight[3] === 0,
      `base ${px.samples.baseMid[3]}, corners ${px.samples.topLeft[3]}/${px.samples.topRight[3]}`);
    check('it is cropped to the triangle, and half of that box is filled',
      near(px.width, 180, 1) && near(px.height, 130, 1) && near((px.solid + px.soft / 2) / px.total, 0.5, 0.04),
      `${px.width}x${px.height}, ${(((px.solid + px.soft / 2) / px.total) * 100).toFixed(0)}% filled`);

    const outside = await page.evaluate(async () => {
      window.shapeshifter.trace([[-30, -30], [60, -30], [60, 50]]);
      return window.shapeshifter.state().points;
    });
    check('points outside the photo are held to its edge',
      outside.every((p) => p.x >= 0 && p.y >= 0), JSON.stringify(outside[0]));

    /* -------------------------------------------------------- 10. refusals */
    console.log('\nWhen something is wrong');
    await page.evaluate(() => window.shapeshifter.trace([[10, 10], [60, 10], [60, 60]]));
    const kept = await page.evaluate(async () => {
      await window.shapeshifter.open(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'notes.txt', { type: 'text/plain' }));
      return window.shapeshifter.state();
    });
    check('a file that is not a photo is refused plainly', kept.hintKind === 'error' && /does not look like an image/i.test(kept.hint), kept.hint);
    check('and your work is left alone', kept.loaded && kept.points.length === 3);

    check('no errors anywhere in this run', errors.length === 0, errors.join(' | '));
    await painted(page);
    await page.screenshot({ path: resolve(OUT, 'editor.png') });

    /* --------------------------------------------- 11. the Mac app bridge */
    console.log('\nInside the Mac app');
    const mac = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await mac.addInitScript(() => {
      window.__posted = [];
      window.webkit = { messageHandlers: { shapeshifter: { postMessage: (m) => window.__posted.push(m) } } };
    });
    const app = await mac.newPage();
    await app.goto(BASE, { waitUntil: 'networkidle' });
    await app.locator('#chooseBtn').click();
    let posted = await app.evaluate(() => window.__posted);
    check('choosing a photo asks the app for its open panel', posted.some((m) => m.type === 'open'), JSON.stringify(posted));

    await app.evaluate(async () => {
      await window.shapeshifter.openUrl('/test/fixtures/photo.png', 'beach.png');
      window.shapeshifter.trace([[40, 30], [160, 40], [120, 120]]);
    });
    await app.locator('#primaryBtn').click();
    await app.waitForFunction(() => window.__posted.some((m) => m.type === 'save'));
    posted = await app.evaluate(() => window.__posted);
    const save = posted.find((m) => m.type === 'save');
    const bytes = Buffer.from(save.data, 'base64');
    check('saving hands a PNG to the app, named after the photo',
      save.filename === 'beach-cutout.png' && bytes.subarray(1, 4).toString() === 'PNG', `${save.filename}, ${bytes.length} bytes`);
    check('the app is left to ask where to save it', /choose where/i.test((await app.evaluate(() => window.shapeshifter.state())).hint));
    await app.keyboard.press('Control+z');
    check('the menu bar, not the page, owns command shortcuts there',
      (await app.evaluate(() => window.shapeshifter.state())).points.length === 3);
    check('the app stays quiet when nothing is wrong',
      !posted.some((m) => m.type === 'log'), JSON.stringify(posted.filter((m) => m.type === 'log')));
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
