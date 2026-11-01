# Shapeshifter

Drag in a photo, outline any part of it, and export **that shape** — not a rectangle
containing it.

A photo file is always a rectangle of pixels. Shapeshifter crops that rectangle tight to
the outline you draw and writes every pixel outside the outline as fully transparent, so
the file opens as the shape you drew in Preview, Photoshop, Figma, Keynote, a browser, or
anything else that understands transparency. Export as SVG and the outline is written as a
real vector clip path as well, so the shape stays crisp at any size and can be edited as a
path.

Shapeshifter is a **native macOS app**. It has no dependencies, makes no network
connections of any kind, and your photo never leaves your Mac.

## Install on macOS

Needs macOS 13 or newer, and the Xcode Command Line Tools for the compiler. If you do
not already have them, macOS will offer to install them when you run this (full Xcode is
not required):

```bash
xcode-select --install
```

Then, from this folder:

```bash
./macos/build.sh --install
```

That compiles `Shapeshifter.app`, drops it in `/Applications`, and it shows up in
Launchpad. Build without installing with `./macos/build.sh`, or build and launch in one
step with `./macos/build.sh --run`.

The app is ad-hoc signed. Because you built it yourself rather than downloading it,
Gatekeeper will not get in the way and there is nothing to notarize.

Once installed you can open a photo by dragging it onto the window or the Dock icon, with
**⌘O**, or by right-clicking any image in Finder and choosing *Open With → Shapeshifter*.
Exports go through a normal macOS save panel, and **⇧⌘C** puts the cut-out on the
clipboard as a transparent PNG.

### If you would rather not build anything

Double-click `run-local.command`. It serves the same editor to your default browser from
your own machine — no compiler needed, though it does need Node or Python 3 installed.
Everything still stays local.

### Running it as a web page

```bash
npm start          # http://localhost:5173
```

(Or serve the folder any other way — `python3 -m http.server`. Opening `index.html`
directly off disk will *not* work, because ES modules are blocked on `file://`.)

## What it does

**Reads** JPEG, PNG, TIFF and WebP. Browsers cannot decode TIFF, so Shapeshifter ships its
own baseline TIFF decoder: little- and big-endian, strips and tiles, 1/8/16 bits per
sample, grayscale, palette, RGB, RGBA and CMYK, uncompressed, LZW, PackBits or Deflate,
with horizontal differencing prediction.

**Outlines** with seven tools, which all write into one shared alpha mask — so you can
rough something in with the magic wand, tidy the edge with the brush, and cut a hole out
with the polygon, and it is all one shape:

| Tool | Key | For |
| --- | --- | --- |
| Freehand lasso | <kbd>L</kbd> | Tracing around something by hand |
| Polygon | <kbd>P</kbd> | Straight-edged shapes, one corner per click |
| Rectangle / Ellipse | <kbd>R</kbd> / <kbd>E</kbd> | Regular shapes; hold <kbd>Shift</kbd> to constrain |
| Brush | <kbd>B</kbd> | Painting the selection in or out by hand |
| Magic wand | <kbd>W</kbd> | Clicking an object or a flat background to select it |
| Pan | <kbd>H</kbd> | Moving around; hold <kbd>Space</kbd> with any tool |

Hold <kbd>Shift</kbd> while drawing to add to the selection, <kbd>Alt</kbd> to subtract,
or both to intersect.

**Refines** the edge: feather it, grow or shrink it by a true Euclidean distance (so
corners stay round rather than turning square), invert it, undo and redo.

**Exports** as:

| Format | Shape comes from |
| --- | --- |
| **PNG** | Real alpha. The safest choice — opens as the shape everywhere. |
| **WebP** | Real alpha, much smaller files. |
| **SVG** | A vector `<clipPath>` traced from your outline, plus the cropped raster inside it. |
| **JPEG** | JPEG has no transparency, so the outside is filled with a matte colour you pick. |
| **Mask PNG** | The outline on its own, as a white-on-transparent stencil. |

…with options for scale, transparent padding, a stroked outline along the shape's edge, a
background fill, and whether to crop to the shape or keep the original canvas.

## How it works

```
macos/
  Sources/main.swift  the Mac app: window, menus, Open/Save panels, pasteboard
  build.sh            compiles Shapeshifter.app and bundles the editor into it
  Info.plist          bundle metadata, including the image types it can open
js/
  native.js         the bridge to the Mac shell; inert in a plain browser
  app.js            UI wiring, keyboard, file lifecycle, the scripting surface
  mask.js           the selection: one 8-bit alpha value per pixel, plus feather/grow/shrink
  contour.js        traces a mask back into closed vector paths (marching triangles + RDP)
  tools.js          the seven tools; each builds a shape and stamps it into the mask
  wand.js           scanline flood fill by colour distance
  export.js         crops, cuts, and writes the finished file
  render.js         canvas drawing, marching ants, live cut-out preview
  view.js           zoom and pan — the only screen/image coordinate conversion
  history.js        bounded undo/redo over mask snapshots
  decode/tiff.js    baseline TIFF decoder
  decode/image.js   format sniffing and loading
```

Two decisions carry most of the weight:

**One mask, not many shapes.** Every tool rasterizes into a single 8-bit buffer the size of
the photo. That is why tools combine freely, why feathering and growing are simple array
maths, and why the export is nearly free: the mask *is* the alpha channel the file needs.

**Contours are traced, not remembered.** For the on-screen outline and the SVG clip path,
the mask is re-traced into closed polygons by splitting each pixel cell into two triangles
and contouring those. Unlike marching squares it has no ambiguous saddle cases, so loops
always close — including holes, which come out as separate rings and render correctly under
the even-odd fill rule.

Compositing happens at viewport resolution rather than image resolution, so previewing the
cut-out of a 40-megapixel photo costs a screen's worth of memory instead of a photo's worth.

**The Mac app is a real app, not a wrapped website.** `main.swift` provides the window,
menu bar, `NSOpenPanel`/`NSSavePanel` and `NSPasteboard`; the editing engine runs in a
`WKWebView` and is served from inside the app bundle over a private `shapeshifter://` URL
scheme. Using a custom scheme rather than `file://` is what lets the engine's ES modules
load, and it means the app needs no local server and opens no sockets. Opening a photo
hands the bytes to the page through a one-shot transfer the scheme handler serves, so a
large TIFF never has to cross the bridge base64-encoded.

## Scripting it

The editor exposes `window.shapeshifter` for the console and for tests:

```js
await shapeshifter.openUrl('/test/fixtures/photo.png', 'photo.png');
shapeshifter.selectEllipse(100, 75, 60, 45);
shapeshifter.selectRect(80, 60, 30, 30, 'subtract');   // punch a hole
const { blob, filename } = await shapeshifter.exportBlob({ format: 'svg' });
```

Also available: `selectPolygon(points, mode)`, `wandAt(x, y, opts)`, `setExportOptions`,
`exportDataUrl`, and `state()`.

## Tests

```bash
npm test                      # all three suites
npm run test:editor           # 68 checks in a real browser
node test/smoke.mjs --headed  # watch them happen
```

`test/smoke.mjs` decodes the files Shapeshifter actually produces and asserts on their
pixels — that an exported ellipse has four transparent corners and covers π/4 of its file,
that a subtracted region is a transparent hole, that the TIFF decoder agrees with the
browser's own PNG decode to the byte, that padding adds transparent margin, that JPEG comes
out fully opaque. Outputs land in `test/output/` so you can open them yourself.

`test/check-bundle.mjs` assembles the payload that goes inside `Shapeshifter.app` exactly
as `build.sh` does, serves it with the same path and MIME rules the Swift implements, and
checks the editor boots from the bundle alone and makes no network requests at all.

`test/check-bridge.mjs` cross-checks the Swift against the page it drives. The shell calls
JavaScript by name and reads message fields the page posts, and neither language can catch
a rename on the other side, so this verifies the contract directly.

Requires Playwright (`npm install -D playwright && npx playwright install chromium`).

## Limitations

- TIFFs using JPEG or CCITT fax compression are rejected with a message saying so; re-save
  as uncompressed, LZW or Deflate. Floating-point and BigTIFF are not supported.
- Images above roughly 64 megapixels are refused rather than risking the tab's memory.
- The magic wand matches on colour distance alone. For a subject against a busy background,
  rough it in with the wand and clean up with the brush.
- Export is limited to PNG, JPEG and WebP encoding. There is no AVIF or TIFF output.
- The Mac app builds for the architecture of the Mac that builds it, which is what you want
  for your own machine but means the `.app` is not universal.

## Licence

MIT.
