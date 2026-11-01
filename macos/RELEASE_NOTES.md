Universal build of **Shapeshifter.app** for macOS 13 or newer — runs on both Apple silicon and Intel Macs.

## Install

1. Download `Shapeshifter-macOS.zip` below and unzip it.
2. Drag `Shapeshifter.app` into your **Applications** folder.
3. **Run this once in Terminal**, or macOS will refuse to open it:

```
xattr -dr com.apple.quarantine /Applications/Shapeshifter.app
```

Then open it normally from Launchpad or Applications.

That third step is needed because this app is ad-hoc signed rather than notarized
with a paid Apple Developer account. macOS quarantines anything downloaded from the
internet, and Gatekeeper blocks quarantined apps that are not notarized. The command
clears that flag. Building it yourself instead — `./macos/build.sh --install` — skips
this entirely, because locally built apps are never quarantined.

## What it does

Drag a JPEG, PNG, TIFF or WebP onto the window, outline any part of it with the lasso,
polygon, magic wand or brush, and export that shape. The exported PNG, WebP or SVG opens
as the shape you drew rather than as a rectangle, because everything outside your outline
is written as fully transparent and the file is cropped tight to the outline.

Nothing is uploaded and the app makes no network connections of any kind.
