#!/usr/bin/env node
// Cross-check the macOS shell against the editor it drives.
//
// The Swift app talks to the page by name: it calls JavaScript functions as
// strings and reads message fields the page posts. Nothing in either language
// can catch a rename on the other side, and the Swift cannot be compiled on a
// non-Mac machine — so this checks the contract directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const swift = read('macos/Sources/main.swift');
const native = read('js/native.js');
const app = read('js/app.js');
const util = read('js/util.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  if (!ok) failures++;
};

console.log('\nmacOS shell ↔ editor contract');

// 1. The message-handler name both sides use.
const handlerName = swift.match(/userContentController\.add\(self, name: (\w+)\)/)?.[1];
const bridgeValue = swift.match(/let kBridgeName = "([^"]+)"/)?.[1];
check('Swift registers the message handler as "shapeshifter"',
  handlerName === 'kBridgeName' && bridgeValue === 'shapeshifter',
  `${handlerName} = "${bridgeValue}"`);
check('the page looks for that same handler',
  /messageHandlers\?\.shapeshifter/.test(native));

// 2. Message types the page sends must all be handled in Swift.
const sent = [...native.matchAll(/post\(\{\s*type:\s*'([a-z]+)'/g)].map((m) => m[1]);
const handled = [...swift.matchAll(/^\s*case "([a-z]+)":/gm)].map((m) => m[1]);
check('every message the page sends is handled in Swift',
  sent.every((t) => handled.includes(t)),
  `page sends [${sent}], Swift handles [${handled.filter((h) => sent.includes(h))}]`);

// 3. Fields of the "save" message.
check('Swift reads the fields the save message carries',
  /body\["filename"\]/.test(swift) && /body\["data"\]/.test(swift)
    && /type: 'save', filename, data:/.test(native));

// 4. The transfer handoff used for opening a photo.
const transferFn = swift.match(/run\("window\.(__\w+)\(/)?.[1];
check('Swift calls the transfer entry point the page defines',
  transferFn === '__shapeshifterOpenTransfer'
    && native.includes('globalThis.__shapeshifterOpenTransfer'),
  transferFn);
check('both sides agree on the /__transfer/ path',
  swift.includes('"/__transfer/"') && native.includes('/__transfer/'));

// 5. The single native-detection global.
check('the shell installs the global that isNative() tests',
  /globalThis\.__shapeshifterNative = \{/.test(native)
    && /isNative = \(\) => Boolean\(globalThis\.__shapeshifterNative\)/.test(native));
check('downloadBlob defers to that same global',
  /globalThis\.__shapeshifterNative;/.test(util) && /native\?\.save/.test(util));

// 6. Every editor method Swift invokes must exist on the class.
const invoked = [...swift.matchAll(/window\.shapeshifter\.editor\.(\w+)\(/g)].map((m) => m[1]);
const unique = [...new Set(invoked)];
const defined = new Set([...app.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*\(/gm)].map((m) => m[1]));
const missing = unique.filter((m) => !defined.has(m));
check('every editor method the menus call exists',
  missing.length === 0,
  missing.length ? `missing: ${missing}` : `${unique.length} checked: ${unique.join(', ')}`);

// 7. DOM ids Swift reaches for.
const ids = [...swift.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]);
const html = read('index.html');
check('DOM ids used from Swift exist in the page',
  ids.every((id) => html.includes(`id="${id}"`)),
  ids.join(', ') || 'none');

// 8. Bundle layout: build.sh must ship everything index.html asks for.
const build = read('macos/build.sh');
const assets = [...html.matchAll(/(?:src|href)="(?!data:|https?:)([^"]+)"/g)].map((m) => m[1]);
const topLevel = [...new Set(assets.map((a) => a.split('/')[0]))];
check('build.sh copies every folder the page loads from',
  topLevel.every((dir) => build.includes(`/${dir}`) || build.includes(`"$ROOT/${dir}"`)),
  topLevel.join(', '));
check('build.sh copies index.html itself', build.includes('index.html'));

// 9. Info.plist and the build script agree on names.
const plist = read('macos/Info.plist');
check('Info.plist executable name matches what build.sh writes',
  /<key>CFBundleExecutable<\/key>\s*<string>Shapeshifter<\/string>/.test(plist)
    && build.includes('APP_NAME="Shapeshifter"'));
check('Info.plist icon name matches the generated icns',
  /<string>AppIcon<\/string>/.test(plist) && build.includes('AppIcon.icns'));

console.log(failures ? `\n${failures} contract check(s) failed\n` : '\nContract is consistent\n');
process.exitCode = failures ? 1 : 0;
