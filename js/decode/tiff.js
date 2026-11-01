// Baseline TIFF decoder.
//
// Browsers decode JPEG, PNG and WebP natively but not TIFF, so this reads the
// format directly. Covers what real-world TIFFs actually use: little- and
// big-endian, strips and tiles, 1/8/16 bits per sample, grayscale, palette,
// RGB, RGBA and CMYK, with no compression, LZW, PackBits or Deflate, and
// horizontal differencing prediction.

const T = {
  IMAGE_WIDTH: 256,
  IMAGE_LENGTH: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  PHOTOMETRIC: 262,
  STRIP_OFFSETS: 273,
  SAMPLES_PER_PIXEL: 277,
  ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279,
  PLANAR_CONFIG: 284,
  PREDICTOR: 317,
  COLOR_MAP: 320,
  TILE_WIDTH: 322,
  TILE_LENGTH: 323,
  TILE_OFFSETS: 324,
  TILE_BYTE_COUNTS: 325,
  EXTRA_SAMPLES: 338,
  SAMPLE_FORMAT: 339,
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const COMPRESSION_NAMES = {
  1: 'uncompressed',
  2: 'CCITT Group 3 1-D',
  3: 'CCITT T.4',
  4: 'CCITT T.6',
  5: 'LZW',
  6: 'old-style JPEG',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
};

export function isTiff(buffer) {
  if (buffer.byteLength < 4) return false;
  const v = new DataView(buffer);
  const magic = v.getUint16(0, false);
  if (magic === 0x4949) return v.getUint16(2, true) === 42;
  if (magic === 0x4d4d) return v.getUint16(2, false) === 42;
  return false;
}

/**
 * Decode the first image in a TIFF file.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{width:number, height:number, data:Uint8ClampedArray, meta:object}>}
 */
export async function decodeTiff(buffer) {
  const view = new DataView(buffer);
  const magic = view.getUint16(0, false);
  if (magic !== 0x4949 && magic !== 0x4d4d) throw new Error('Not a TIFF file.');
  const le = magic === 0x4949;
  if (view.getUint16(2, le) !== 42) throw new Error('Unsupported TIFF variant (BigTIFF is not supported).');

  const ifd = readIfd(view, view.getUint32(4, le), le);

  const width = num(ifd, T.IMAGE_WIDTH);
  const height = num(ifd, T.IMAGE_LENGTH);
  if (!width || !height) throw new Error('TIFF is missing its image dimensions.');

  const samplesPerPixel = num(ifd, T.SAMPLES_PER_PIXEL, 1);
  // The TIFF spec's default for BitsPerSample is 1, and real bilevel files do
  // omit the tag. Multi-channel files that omit it mean 8.
  const bitsArr = arr(ifd, T.BITS_PER_SAMPLE, [samplesPerPixel === 1 ? 1 : 8]);
  const bits = bitsArr[0] || 8;
  if (bitsArr.some((b) => b !== bits)) throw new Error('TIFFs with mixed bit depths per channel are not supported.');
  if (![1, 8, 16].includes(bits)) throw new Error(`Unsupported TIFF bit depth: ${bits} bits per sample.`);

  const compression = num(ifd, T.COMPRESSION, 1);
  const photometric = num(ifd, T.PHOTOMETRIC, samplesPerPixel >= 3 ? 2 : 1);
  const planar = num(ifd, T.PLANAR_CONFIG, 1);
  const predictor = num(ifd, T.PREDICTOR, 1);
  const sampleFormat = arr(ifd, T.SAMPLE_FORMAT, [1])[0];
  const extraSamples = arr(ifd, T.EXTRA_SAMPLES, []);
  const colorMap = arr(ifd, T.COLOR_MAP, null);

  if (sampleFormat === 3) throw new Error('Floating-point TIFFs are not supported.');
  if (!(compression in COMPRESSION_NAMES) || [2, 3, 4, 6, 7].includes(compression)) {
    const name = COMPRESSION_NAMES[compression] || `type ${compression}`;
    throw new Error(`This TIFF uses ${name} compression, which is not supported. Re-save it as uncompressed, LZW or Deflate TIFF — or as a PNG.`);
  }

  const tiled = has(ifd, T.TILE_OFFSETS);
  const tileWidth = tiled ? num(ifd, T.TILE_WIDTH) : width;
  const tileHeight = tiled ? num(ifd, T.TILE_LENGTH) : num(ifd, T.ROWS_PER_STRIP, height);
  const offsets = arr(ifd, tiled ? T.TILE_OFFSETS : T.STRIP_OFFSETS, []);
  const byteCounts = arr(ifd, tiled ? T.TILE_BYTE_COUNTS : T.STRIP_BYTE_COUNTS, []);
  if (!offsets.length) throw new Error('TIFF has no image data.');

  const planeCount = planar === 2 ? samplesPerPixel : 1;
  const samplesPerChunk = planar === 2 ? 1 : samplesPerPixel;
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);

  // Decoded samples, interleaved, normalized to 8 bits per sample.
  const planes = [];
  for (let p = 0; p < planeCount; p++) planes.push(new Uint8ClampedArray(width * height * samplesPerChunk));

  const rowBytes = (w, spp) => Math.ceil((w * spp * bits) / 8);

  for (let p = 0; p < planeCount; p++) {
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        const index = p * tilesAcross * tilesDown + ty * tilesAcross + tx;
        if (index >= offsets.length) continue;
        const start = offsets[index];
        const length = byteCounts[index] ?? buffer.byteLength - start;
        const raw = new Uint8Array(buffer, start, Math.min(length, buffer.byteLength - start));

        // Tiles are always padded to the full tile size; the last strip is not.
        const chunkWidth = tiled ? tileWidth : width;
        const chunkHeight = tiled ? tileHeight : Math.min(tileHeight, height - ty * tileHeight);
        const expected = rowBytes(chunkWidth, samplesPerChunk) * chunkHeight;
        let bytes = await decompress(raw, compression, expected);

        if (predictor === 2) {
          undoHorizontalPredictor(bytes, chunkWidth, chunkHeight, samplesPerChunk, bits, le);
        }

        copyChunk({
          bytes, plane: planes[p], bits, le,
          chunkWidth, chunkHeight, samplesPerChunk,
          originX: tx * tileWidth, originY: ty * tileHeight,
          width, height,
        });
      }
    }
  }

  const samples = planar === 2 ? interleavePlanes(planes, width * height) : planes[0];
  const data = toRgba({ samples, width, height, samplesPerPixel, photometric, colorMap, extraSamples, bits });

  return {
    width,
    height,
    data,
    meta: {
      format: 'TIFF',
      bitDepth: bits,
      channels: samplesPerPixel,
      compression: COMPRESSION_NAMES[compression] || String(compression),
      photometric: ['white-is-zero', 'black-is-zero', 'RGB', 'palette', 'mask', 'CMYK'][photometric] ?? String(photometric),
      layout: tiled ? 'tiled' : 'stripped',
      hadAlpha: samplesPerPixel === 4 && photometric === 2,
    },
  };
}

function readIfd(view, offset, le) {
  const count = view.getUint16(offset, le);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const base = offset + 2 + i * 12;
    const tag = view.getUint16(base, le);
    const type = view.getUint16(base + 2, le);
    const length = view.getUint32(base + 4, le);
    const size = TYPE_SIZE[type] || 1;
    const total = size * length;
    const valueOffset = total <= 4 ? base + 8 : view.getUint32(base + 8, le);
    entries.set(tag, { type, length, valueOffset, view, le });
  }
  return entries;
}

function values(entry) {
  const { type, length, valueOffset, view, le } = entry;
  const out = [];
  for (let i = 0; i < length; i++) {
    const at = valueOffset + i * (TYPE_SIZE[type] || 1);
    switch (type) {
      case 1: case 2: case 7: out.push(view.getUint8(at)); break;
      case 3: out.push(view.getUint16(at, le)); break;
      case 4: out.push(view.getUint32(at, le)); break;
      case 5: out.push(view.getUint32(at, le) / (view.getUint32(at + 4, le) || 1)); break;
      case 6: out.push(view.getInt8(at)); break;
      case 8: out.push(view.getInt16(at, le)); break;
      case 9: out.push(view.getInt32(at, le)); break;
      case 11: out.push(view.getFloat32(at, le)); break;
      case 12: out.push(view.getFloat64(at, le)); break;
      default: out.push(view.getUint8(at));
    }
  }
  return out;
}

const has = (ifd, tag) => ifd.has(tag);
const arr = (ifd, tag, fallback) => (ifd.has(tag) ? values(ifd.get(tag)) : fallback);
const num = (ifd, tag, fallback = 0) => (ifd.has(tag) ? values(ifd.get(tag))[0] : fallback);

async function decompress(raw, compression, expected) {
  switch (compression) {
    case 1:
      return raw;
    case 5:
      return lzwDecode(raw, expected);
    case 32773:
      return packBitsDecode(raw, expected);
    case 8:
    case 32946:
      return inflate(raw);
    default:
      throw new Error(`Unsupported TIFF compression: ${compression}`);
  }
}

async function inflate(raw) {
  // Compression 8 and 32946 are zlib-wrapped; fall back to raw deflate just in
  // case an encoder omitted the header.
  const copy = raw.slice();
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* try the next format */
    }
  }
  throw new Error('Could not inflate Deflate-compressed TIFF data.');
}

/** TIFF-flavoured LZW: MSB-first codes, 9 bits growing to 12, with early change. */
export function lzwDecode(input, expected = 0) {
  const CLEAR = 256;
  const EOI = 257;
  const out = expected ? new Uint8Array(expected) : new Uint8Array(input.length * 4);
  let outLen = 0;
  let buffer = out;

  const push = (bytes) => {
    if (outLen + bytes.length > buffer.length) {
      const grown = new Uint8Array(Math.max(buffer.length * 2, outLen + bytes.length));
      grown.set(buffer.subarray(0, outLen));
      buffer = grown;
    }
    buffer.set(bytes, outLen);
    outLen += bytes.length;
  };

  let dict = [];
  const resetDict = () => {
    dict = new Array(258);
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
  };
  resetDict();

  let bitPos = 0;
  let codeWidth = 9;
  const totalBits = input.length * 8;

  const readCode = () => {
    if (bitPos + codeWidth > totalBits) return EOI;
    let value = 0;
    for (let i = 0; i < codeWidth; i++) {
      const bit = (input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1;
      value = (value << 1) | bit;
    }
    bitPos += codeWidth;
    return value;
  };

  let previous = null;
  for (;;) {
    const code = readCode();
    if (code === EOI) break;
    if (code === CLEAR) {
      resetDict();
      codeWidth = 9;
      previous = null;
      continue;
    }
    let entry;
    if (code < dict.length && dict[code]) {
      entry = dict[code];
      if (previous) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous);
        added[previous.length] = entry[0];
        dict.push(added);
      }
    } else if (previous) {
      entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0];
      dict.push(entry);
    } else {
      break; // Corrupt stream.
    }
    push(entry);
    previous = entry;
    // "Early change": widen one code before the table is actually full.
    if (dict.length + 1 >= 1 << codeWidth && codeWidth < 12) codeWidth++;
    if (expected && outLen >= expected) break;
  }
  return buffer.subarray(0, outLen);
}

export function packBitsDecode(input, expected = 0) {
  const out = new Uint8Array(expected || input.length * 3);
  let o = 0;
  let i = 0;
  const ensure = (n) => o + n <= out.length;
  while (i < input.length) {
    const header = (input[i++] << 24) >> 24; // sign-extend
    if (header >= 0) {
      const count = header + 1;
      if (!ensure(count)) break;
      for (let k = 0; k < count && i < input.length; k++) out[o++] = input[i++];
    } else if (header !== -128) {
      const count = 1 - header;
      if (!ensure(count)) break;
      const byte = input[i++];
      for (let k = 0; k < count; k++) out[o++] = byte;
    }
  }
  return out.subarray(0, o);
}

function undoHorizontalPredictor(bytes, width, height, samples, bits, le) {
  if (bits === 8) {
    const stride = width * samples;
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = samples; x < stride; x++) bytes[row + x] = (bytes[row + x] + bytes[row + x - samples]) & 0xff;
    }
  } else if (bits === 16) {
    const stride = width * samples;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let y = 0; y < height; y++) {
      const row = y * stride * 2;
      for (let x = samples; x < stride; x++) {
        const at = row + x * 2;
        if (at + 1 >= bytes.byteLength) break;
        const value = (view.getUint16(at, le) + view.getUint16(at - samples * 2, le)) & 0xffff;
        view.setUint16(at, value, le);
      }
    }
  }
}

function copyChunk({ bytes, plane, bits, le, chunkWidth, chunkHeight, samplesPerChunk, originX, originY, width, height }) {
  const rowBytes = Math.ceil((chunkWidth * samplesPerChunk * bits) / 8);
  const view = bits === 16 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;

  for (let y = 0; y < chunkHeight; y++) {
    const imageY = originY + y;
    if (imageY >= height) break;
    const rowStart = y * rowBytes;
    for (let x = 0; x < chunkWidth; x++) {
      const imageX = originX + x;
      if (imageX >= width) continue;
      const target = (imageY * width + imageX) * samplesPerChunk;
      for (let s = 0; s < samplesPerChunk; s++) {
        const sampleIndex = x * samplesPerChunk + s;
        let value;
        if (bits === 8) {
          value = bytes[rowStart + sampleIndex] ?? 0;
        } else if (bits === 16) {
          const at = rowStart + sampleIndex * 2;
          value = at + 1 < bytes.byteLength ? view.getUint16(at, le) >> 8 : 0;
        } else {
          const bitIndex = rowStart * 8 + sampleIndex;
          const byte = bytes[bitIndex >> 3] ?? 0;
          value = ((byte >> (7 - (bitIndex & 7))) & 1) * 255;
        }
        plane[target + s] = value;
      }
    }
  }
}

function interleavePlanes(planes, pixelCount) {
  const spp = planes.length;
  const out = new Uint8ClampedArray(pixelCount * spp);
  for (let p = 0; p < spp; p++) {
    const src = planes[p];
    for (let i = 0; i < pixelCount; i++) out[i * spp + p] = src[i];
  }
  return out;
}

function toRgba({ samples, width, height, samplesPerPixel, photometric, colorMap, extraSamples, bits }) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const hasAlpha = samplesPerPixel === 4 && photometric === 2 && extraSamples.length > 0
    ? true
    : samplesPerPixel === 4 && photometric === 2;
  const premultiplied = extraSamples[0] === 1;

  for (let i = 0; i < count; i++) {
    const s = i * samplesPerPixel;
    const o = i * 4;
    let r;
    let g;
    let b;
    let a = 255;

    switch (photometric) {
      case 0: { // white is zero
        const v = 255 - samples[s];
        r = g = b = v;
        break;
      }
      case 3: { // palette
        const index = bits === 1 ? (samples[s] ? 1 : 0) : samples[s];
        if (colorMap) {
          const n = colorMap.length / 3;
          r = (colorMap[index] ?? 0) >> 8;
          g = (colorMap[n + index] ?? 0) >> 8;
          b = (colorMap[2 * n + index] ?? 0) >> 8;
        } else {
          r = g = b = index;
        }
        break;
      }
      case 5: { // CMYK
        const c = samples[s] / 255;
        const m = samples[s + 1] / 255;
        const y = samples[s + 2] / 255;
        const k = samples[s + 3] / 255;
        r = 255 * (1 - Math.min(1, c + k));
        g = 255 * (1 - Math.min(1, m + k));
        b = 255 * (1 - Math.min(1, y + k));
        break;
      }
      case 2: { // RGB
        r = samples[s];
        g = samples[s + 1];
        b = samples[s + 2];
        if (hasAlpha) a = samples[s + 3];
        break;
      }
      default: { // 1 = black is zero, grayscale
        r = g = b = samples[s];
        if (samplesPerPixel === 2) a = samples[s + 1];
      }
    }

    if (premultiplied && a > 0 && a < 255) {
      const scale = 255 / a;
      r *= scale;
      g *= scale;
      b *= scale;
    }

    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}
