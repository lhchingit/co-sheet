import zlib from 'node:zlib';

/**
 * @file png.js
 * @description Minimal decoder for the PNGs a Chromium screenshot produces: 8-bit,
 * non-interlaced, RGB or RGBA. Enough to ask "what colour is this pixel", which is
 * the only question a rendering check can actually settle — and the question the
 * rest of the suite cannot ask, since it has no browser and asserts on models and
 * stylesheet text instead.
 *
 * Written rather than pulled in: a full image library is a large dependency for
 * ~60 lines of the PNG spec, and this only ever reads what Chromium writes.
 */

/**
 * @param {Buffer} buf A PNG file.
 * @returns {{ width: number, height: number, channels: number, data: Buffer }}
 *   `data` is row-major, `channels` bytes per pixel.
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (body[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (colorType !== 6 && colorType !== 2) throw new Error(`unsupported color type ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec section 9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) {
        throw new Error(`bad scanline filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Perceived darkness of one pixel, 0 (white) to 255 (black). A single number is
 * enough to tell a black border from a #dadce0 gridline from the white background,
 * and it does not care about sub-pixel colour fringing the way an exact RGB match
 * would.
 * @param {{ width: number, channels: number, data: Buffer }} img
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function darkness(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
  return 255 - Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}
