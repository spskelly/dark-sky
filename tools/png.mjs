// just enough png to read a pixel out of a map tile.
//
// node ships zlib, and a png is a zlib stream plus five per-row filters, so
// decoding one here costs about eighty lines and no dependencies. that matters
// more than it sounds: every other tool in this repo runs on a bare node
// install, and pulling in a headless browser to read three tiles would make
// this the one that does not.
//
// handles what map tiles are actually made of: bit depth 8 (and 16, taking the
// high byte), colour types 0/2/3/4/6, non-interlaced. an interlaced tile would
// throw rather than return quiet nonsense.
import zlib from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, hdr = null, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;                                   // length + type + data + crc
    if (type === 'IHDR') hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!hdr) throw new Error('png has no IHDR');
  if (hdr.interlace) throw new Error('interlaced png not supported');
  const ch = CHANNELS[hdr.color];
  if (!ch) throw new Error(`png colour type ${hdr.color} not supported`);
  if (![1, 2, 4, 8, 16].includes(hdr.depth)) throw new Error(`png bit depth ${hdr.depth} not supported`);
  if (hdr.color === 3 && !plte) throw new Error('indexed png with no palette');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(hdr.w * ch * hdr.depth / 8);
  // filtering works on whole bytes, and on at least one byte even when a pixel
  // is narrower than that
  const bpp = Math.max(1, Math.ceil(ch * hdr.depth / 8));
  const out = Buffer.alloc(stride * hdr.h);

  let o = 0;
  for (let y = 0; y < hdr.h; y++) {
    const ft = raw[o++];
    const row = y * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[o + i];
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y ? out[prev + i] : 0;
      const c = y && i >= bpp ? out[prev + i - bpp] : 0;
      out[row + i] =
        ft === 0 ? x :
        ft === 1 ? x + a :
        ft === 2 ? x + b :
        ft === 3 ? x + ((a + b) >> 1) :
        ft === 4 ? x + paeth(a, b, c) :
        (() => { throw new Error(`png filter ${ft} is not a filter`); })();
    }
    o += stride;
  }

  // one sample, whatever width it was stored at, as 0-255
  const sample = (row, index) => {
    if (hdr.depth === 16) return out[row + index * 2];
    if (hdr.depth === 8) return out[row + index];
    const per = 8 / hdr.depth;                       // samples packed per byte
    const byte = out[row + Math.floor(index / per)];
    const shift = 8 - hdr.depth * (index % per + 1);
    const max = (1 << hdr.depth) - 1;
    const v = (byte >> shift) & max;
    return hdr.color === 3 ? v : Math.round(v * 255 / max);   // an index is not a level
  };

  return {
    width: hdr.w, height: hdr.h, depth: hdr.depth, color: hdr.color,
    // red, green, blue, alpha at a pixel, 0-255
    rgba(x, y) {
      if (x < 0 || y < 0 || x >= hdr.w || y >= hdr.h) return null;
      const row = y * stride, at = x * ch;
      if (hdr.color === 3) {
        const i = sample(row, at);
        return [plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], trns && i < trns.length ? trns[i] : 255];
      }
      if (hdr.color === 0) { const g = sample(row, at); return [g, g, g, 255]; }
      if (hdr.color === 4) { const g = sample(row, at); return [g, g, g, sample(row, at + 1)]; }
      const r = sample(row, at), g = sample(row, at + 1), b = sample(row, at + 2);
      return [r, g, b, hdr.color === 6 ? sample(row, at + 3) : 255];
    },
  };
}
