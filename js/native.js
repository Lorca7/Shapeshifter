// The one place that knows whether Shapeshifter is running as the Mac app or
// in a plain browser. In the Mac app, opening and saving go through the real
// macOS panels; in a browser they fall back to a file picker and a download.

const bridge = globalThis.webkit?.messageHandlers?.shapeshifter ?? null;

export const inApp = bridge !== null;

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the image to save it.'));
    reader.readAsDataURL(blob);
  });
}

/** Ask for a photo: the Mac open panel in the app, the browser's picker otherwise. */
export function requestOpen(fileInput) {
  if (bridge) bridge.postMessage({ type: 'open' });
  else fileInput.click();
}

/** Hand the finished file to the user. Returns 'app' or 'download'. */
export async function saveFile(blob, filename) {
  if (bridge) {
    bridge.postMessage({ type: 'save', filename, data: await toBase64(blob) });
    return 'app';
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'download';
}

// Surface script errors to the app, so a failure is visible instead of silent.
if (bridge) {
  const log = (message) => bridge.postMessage({ type: 'log', message: String(message) });
  addEventListener('error', (e) => log(`error: ${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => log(`rejected: ${e.reason?.message ?? e.reason}`));
}
