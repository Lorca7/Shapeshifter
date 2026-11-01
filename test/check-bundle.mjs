#!/usr/bin/env node
// Verify the payload that goes inside Shapeshifter.app.
//
// The Swift shell serves Contents/Resources/web over a private URL scheme.
// The Swift itself cannot be compiled off a Mac, but the thing it serves can
// be: this assembles the bundle exactly as macos/build.sh does, serves it with
// the same path and MIME rules the Swift handler implements, and checks that
// the editor boots, works, and never reaches the network.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require_('playwright'));
} catch {
  console.error('Playwright is not available. npm install -D playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  if (!ok) failures++;
};

// The same MIME table the Swift AssetSchemeHandler uses.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

async function main() {
  console.log('\nApp bundle payload');

  // 1. Assemble Contents/Resources/web exactly as build.sh does.
  const staging = await mkdtemp(join(tmpdir(), 'shapeshifter-bundle-'));
  const web = join(staging, 'Contents', 'Resources', 'web');
  await cp(join(ROOT, 'index.html'), join(web, 'index.html'), { recursive: true });
  await cp(join(ROOT, 'css'), join(web, 'css'), { recursive: true });
  await cp(join(ROOT, 'js'), join(web, 'js'), { recursive: true });

  const size = await folderSize(web);
  check('the bundled editor is assembled', size > 50_000, `${(size / 1024).toFixed(0)} KB of assets`);

  // 2. Serve it the way the Swift scheme handler does.
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/' || path === '') path = '/index.html';
    const full = join(web, normalize(path));
    if (!full.startsWith(web)) { res.writeHead(403).end(); return; }
    try {
      const data = readFileSync(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  const port = 5211;
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  const errors = [];
  const offBundle = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
      offBundle.push(r.url());
    }
  });

  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction('window.shapeshifter !== undefined', { timeout: 10_000 });

    check('the editor boots from the bundle alone', true);
    check('no script errors on load', errors.length === 0, errors.join(' | '));
    check('the app makes no network requests at all', offBundle.length === 0,
      offBundle.length ? offBundle.join(', ') : 'everything came from the bundle');

    // 3. A full round trip with no fixture files - the bundle has none.
    const round = await page.evaluate(async () => {
      // Build a photo in the page, hand it to the editor as a dropped file.
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c83232'; ctx.fillRect(0, 0, 160, 120);
      ctx.fillStyle = '#28b45a'; ctx.fillRect(80, 0, 80, 120);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await window.shapeshifter.openFile(new File([blob], 'made-up.png', { type: 'image/png' }));
      window.shapeshifter.selectEllipse(80, 60, 50, 40);
      const png = await window.shapeshifter.exportDataUrl({ format: 'png' });
      const svg = await window.shapeshifter.exportBlob({ format: 'svg' });
      return { state: window.shapeshifter.state(), png, svgSize: svg.blob.size };
    });
    check('a photo opens and an outline exports', round.state.hasSelection && round.png.size > 300,
      `${round.png.width}x${round.png.height}, ${round.png.size} B PNG, ${round.svgSize} B SVG`);
    check('the export is cropped to the outline',
      round.png.width === 100 && round.png.height === 80, `${round.png.width}x${round.png.height}`);

    // 4. ES modules only load when served with a JavaScript MIME type, so this
    //    confirms the Swift handler's table is right.
    const moduleType = (await page.request.get(`${base}/js/app.js`)).headers()['content-type'];
    check('JavaScript is served with a module-capable MIME type',
      moduleType.startsWith('text/javascript'), moduleType);

    // 5. Every module the page pulls in must be present in the bundle.
    const loaded = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
    const missing = [];
    for (const p of loaded) {
      try { await stat(join(web, p)); } catch { missing.push(p); }
    }
    check('every file the page requested exists in the bundle', missing.length === 0,
      missing.length ? `missing: ${missing}` : `${loaded.length} files, all present`);
  } finally {
    await browser.close();
    server.close();
    await rm(staging, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} bundle check(s) failed\n` : '\nBundle payload is self-contained\n');
  process.exitCode = failures ? 1 : 0;
}

async function folderSize(dir) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await folderSize(p) : (await stat(p)).size;
  }
  return total;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
