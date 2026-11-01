// Bridge to the macOS app shell.
//
// Shapeshifter runs unchanged in a browser; when it is running inside the
// native Mac app, these hooks route opening, saving and copying through real
// AppKit panels instead of the browser's download folder. Everything here is
// feature-detected, so the same files work in both places.

const bridge = globalThis.webkit?.messageHandlers?.shapeshifter ?? null;

/**
 * One source of truth for "is a native shell present": the hooks object below,
 * which only gets installed when the Mac app's message handler exists. Keeping
 * it to a single global means saving, opening and the wording of status
 * messages can never disagree about which shell they are in.
 */
export const isNative = () => Boolean(globalThis.__shapeshifterNative);

function post(payload) {
  bridge.postMessage(payload);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the exported file.'));
    reader.readAsDataURL(blob);
  });
}

if (bridge) {
  document.documentElement.dataset.shell = 'macos';

  globalThis.__shapeshifterNative = {
    /** Hand a finished export to the native save panel. */
    async save(blob, filename) {
      post({ type: 'save', filename, data: await blobToBase64(blob) });
    },
    /** Ask the app to show its Open panel. */
    requestOpen() {
      post({ type: 'open' });
    },
    /** Put a cut-out on the system pasteboard as a transparent PNG. */
    async copyImage(blob) {
      post({ type: 'clipboard', data: await blobToBase64(blob) });
    },
  };

  /**
   * Called from Swift once a file has been chosen, dropped on the Dock icon,
   * or opened with "Open With". The bytes are fetched from the app's own URL
   * scheme rather than passed as a string, so a large photo does not have to
   * cross the bridge base64-encoded.
   */
  globalThis.__shapeshifterOpenTransfer = async (id, name, mime) => {
    const response = await fetch(`/__transfer/${id}`);
    if (!response.ok) throw new Error(`Could not read “${name}”.`);
    const blob = await response.blob();
    await globalThis.shapeshifter.openFile(new File([blob], name, { type: mime || blob.type }));
  };
}
