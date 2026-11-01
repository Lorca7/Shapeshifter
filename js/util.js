// Small shared helpers.

export const $ = (selector, root = document) => root.querySelector(selector);

export const clamp = (value, low, high) => (value < low ? low : value > high ? high : value);

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width | 0);
  canvas.height = Math.max(1, height | 0);
  return canvas;
}

export function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image file.'))), type);
  });
}

/** Strip the extension from a filename, keeping any dots inside the name. */
export function baseName(name = 'photo') {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) || 'photo';
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
