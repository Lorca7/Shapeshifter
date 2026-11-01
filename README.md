# Shapeshifter

Trace an object in a photo, erase everything else, and save it in its own shape.

A picture file is always a rectangle of pixels. Shapeshifter crops that rectangle tight
around your outline and makes every pixel outside it fully transparent, so the saved PNG
opens as the shape you traced, in Preview, Keynote, Figma, a browser, or anything else that
understands transparency.

Nothing is uploaded. The Mac app makes no network connections at all.

## Install on a Mac

**[Download Shapeshifter.dmg](https://github.com/Lorca7/Shapeshifter/releases/latest/download/Shapeshifter.dmg)**
(macOS 13 or newer, Apple silicon or Intel).

1. Double-click the downloaded `Shapeshifter.dmg`.
2. Drag **Shapeshifter** onto the **Applications** folder.
3. The first time only: in Applications, **right-click Shapeshifter › Open**, then click **Open**.
   (The app isn't notarized with a paid Apple Developer account, so macOS asks you to confirm
   it once. If you double-clicked it and got a "cannot be opened" message, go to
   **System Settings › Privacy & Security** and click **Open Anyway**.)

To uninstall, drag Shapeshifter from Applications to the Trash.

## Using it

1. Drop a photo on the window. JPEG, PNG and TIFF work.
2. **Click along the edge** of the object to drop points. Zoom in as far as you like for precision.
3. **Click the first point** (it turns large and green) to close the outline. Everything outside it is erased.
4. **Drag a point** to fine-tune it, or **click an edge** to add a point there. **Delete** removes the point under the cursor.
5. **Save cutout.**

| To do this | Do this |
| --- | --- |
| Zoom | Pinch, or the **+** / **−** buttons, or the **+** / **−** keys |
| Move around | Two-finger scroll, or drag empty space, or hold **Space** and drag |
| Fit the photo in the window | **Fit**, or **0** |
| Undo / redo | **⌘Z** / **⇧⌘Z** |
| Start over | **Start over** (this can be undone too) |

Points can be dragged right to the photo's edge, and clicks outside the photo are held to it.

## Building it yourself

You only need this to change the app. It needs the Xcode Command Line Tools
(`xcode-select --install`; full Xcode isn't required):

```bash
./macos/build.sh --install
```

To try the editor in a browser instead, run `npm start` and open http://localhost:5173.

## How it works

```
js/app.js          the editor: placing, dragging and removing points, zoom and pan, undo
js/render.js       drawing the photo, the outline and the erased look
js/export.js       cropping to the outline and writing the PNG
js/native.js       the one place that knows if it is the Mac app or a web page
js/decode/         loading JPEG, PNG and TIFF (TIFF is decoded by hand)
macos/             the Mac app: window, menus, Open and Save panels
```

The outline is applied as a clipping path at the photo's full resolution, so the saved edge is
smooth and antialiased rather than a stair-step of pixels. The Mac app is a native AppKit window
hosting the same editor in a `WKWebView`, served from inside the app over a private URL scheme.

## Tests

```bash
npm test                          # contract + bundle checks, then the editor in Chromium
BROWSER=webkit node test/smoke.mjs   # the editor in WebKit, the engine the Mac app uses
```

The editor tests use real mouse clicks and drags, then open the PNG that gets saved and check
its pixels: cropped to the outline, transparent outside it, colours untouched inside it.

Every push also builds the Mac app on GitHub's macOS machines, installs it from the disk image,
and runs the installed app against a test photo. The app opens the photo, traces an outline, saves
through the same path as the Save panel, and the result is checked from outside the app.

Requires Playwright (`npm install -D playwright && npx playwright install chromium`).

## Licence

MIT.
