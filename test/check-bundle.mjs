#!/usr/bin/env node
// Verify the payload that goes inside Shapeshifter.app.
//
// The Swift shell serves Contents/Resources/web. This assembles that folder the
// way macos/build.sh does, serves it with the same path and MIME rules the Swift
// implements, and checks the editor boots from it alone and never touches the
// network.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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

// The same table the Swift AssetSchemeHandler uses.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp',
};

async function folderSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await folderSize(p) : (await stat(p)).size;
  }
  return total;
}

console.log('\nApp bundle payload');
const staging = await mkdtemp(join(tmpdir(), 'shapeshifter-bundle-'));
const web = join(staging, 'Contents', 'Resources', 'web');
await cp(join(ROOT, 'index.html'), join(web, 'index.html'));
await cp(join(ROOT, 'css'), join(web, 'css'), { recursive: true });
await cp(join(ROOT, 'js'), join(web, 'js'), { recursive: true });
check('the editor is assembled', (await folderSize(web)) > 20_000, `${((await folderSize(web)) / 1024).toFixed(0)} KB`);

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const full = join(web, normalize(path));
  try {
    if (!full.startsWith(web)) throw new Error('outside the bundle');
    const data = readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(5211, '127.0.0.1', ok));
const base = 'http://127.0.0.1:5211';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
const outside = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) outside.push(u);
});

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.shapeshifter !== undefined', { timeout: 10_000 });
  check('the editor boots from the bundle alone', true);
  check('no script errors on load', errors.length === 0, errors.join(' | '));
  check('the app makes no network requests', outside.length === 0, outside.join(', ') || 'everything came from the bundle');

  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 120;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c83232';
    ctx.fillRect(0, 0, 160, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await window.shapeshifter.open(new File([blob], 'made-up.png', { type: 'image/png' }));
    window.shapeshifter.trace([[30, 20], [130, 30], [80, 100]]);
    return window.shapeshifter.exportDataUrl();
  });
  check('a photo opens and an outline saves', result.size > 200, `${result.width}x${result.height}, ${result.size} bytes`);

  const type = (await page.request.get(`${base}/js/app.js`)).headers()['content-type'];
  check('scripts are served with a module-capable MIME type', type.startsWith('text/javascript'), type);

  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
  const gone = [];
  for (const p of loaded) {
    try { await stat(join(web, p)); } catch { gone.push(p); }
  }
  check('every file the page asked for is in the bundle', gone.length === 0, gone.length ? gone.join(', ') : `${loaded.length} files`);
} finally {
  await browser.close();
  server.close();
  await rm(staging, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} bundle check(s) failed\n` : '\nBundle payload is self-contained\n');
process.exitCode = failures ? 1 : 0;
