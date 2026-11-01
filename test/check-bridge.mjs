#!/usr/bin/env node
// Cross-check the Mac shell against the page it drives.
//
// The Swift calls JavaScript by name and reads messages the page posts, and
// neither language notices a rename on the other side. The Swift also cannot be
// compiled off a Mac, so this checks the contract directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const swift = read('macos/Sources/main.swift');
const native = read('js/native.js');
const app = read('js/app.js');
const build = read('macos/build.sh');
const plist = read('macos/Info.plist');
const workflow = read('.github/workflows/macos-app.yml');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  if (!ok) failures++;
};

console.log('\nMac shell <-> page contract');

const handler = swift.match(/userContentController\.add\(self, name: (\w+)\)/)?.[1];
const handlerName = swift.match(new RegExp(`let ${handler} = "([^"]+)"`))?.[1];
check('Swift and the page use the same message handler name',
  handlerName === 'shapeshifter' && /messageHandlers\?\.shapeshifter/.test(native), `"${handlerName}"`);

const sent = [...native.matchAll(/postMessage\(\{\s*type:\s*'([a-z]+)'/g)].map((m) => m[1])
  .concat([...native.matchAll(/log = \(message\) => bridge\.postMessage\(\{ type: '([a-z]+)'/g)].map((m) => m[1]));
const handled = [...swift.matchAll(/^\s*case "([a-z]+)":/gm)].map((m) => m[1]);
check('every message the page sends is handled in Swift',
  sent.length >= 3 && sent.every((t) => handled.includes(t)), `page sends [${[...new Set(sent)]}]`);
check('Swift reads the fields a save message carries',
  /body\["filename"\]/.test(swift) && /body\["data"\]/.test(swift) && /type: 'save', filename, data/.test(native));

const called = [...new Set([...swift.matchAll(/window\.shapeshifter\.(\w+)\(/g)].map((m) => m[1]))];
const defined = new Set([...app.matchAll(/^ {2}(?:async\s+)?(\w+)\s*\(/gm)].map((m) => m[1]));
const missing = called.filter((m) => !defined.has(m));
check('every page method Swift calls exists', missing.length === 0,
  missing.length ? `missing: ${missing}` : `${called.length}: ${called.join(', ')}`);

check('Swift hands photos over through the entry point the page defines',
  swift.includes('window.__openTransfer(') && app.includes('window.__openTransfer ='));
check('both sides agree on the /__transfer/ path',
  swift.includes('"/__transfer/"') && app.includes('/__transfer/'));

console.log('\nBuild and packaging');
check('the build copies index.html, css and js into the app',
  ['index.html', 'css', 'js'].every((f) => build.includes(`$ROOT/${f}`)));
check('the app name and icon agree across the plist and build script',
  /<key>CFBundleExecutable<\/key>\s*<string>Shapeshifter<\/string>/.test(plist)
    && build.includes('APP_NAME="Shapeshifter"')
    && /<string>AppIcon<\/string>/.test(plist) && build.includes('AppIcon.icns'));

console.log('\nSelf-test');
const envNames = [...swift.matchAll(/environment\["(SHAPESHIFTER_SELFTEST_\w+)"\]/g)].map((m) => m[1]);
check('the workflow sets exactly the variables the app reads',
  envNames.length === 2 && envNames.every((n) => workflow.includes(n)), envNames.join(', '));
check('the workflow checks the file the app saves',
  workflow.includes('verify-cutout.py') && /SELFTEST PASS/.test(swift));

console.log(failures ? `\n${failures} contract check(s) failed\n` : '\nContract is consistent\n');
process.exitCode = failures ? 1 : 0;
