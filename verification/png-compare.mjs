/**
 * Tolerant screenshot comparison.
 *
 * PNG bytes are non-deterministic across renders (font rasterisation, animation
 * frame timing, CDN load order), so a raw hash is not a meaningful parity
 * signal. This decodes both PNGs and compares pixel data with a small
 * per-channel tolerance, reporting the fraction of differing pixels.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a non-interlaced 8-bit RGBA/RGB PNG to {width,height,pixels}. */
export function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = r & 0xFF;
    }
  }
  return { width, height, channels, pixels: out };
}

/**
 * Compare two PNGs.
 * @returns {{same:boolean, total:number, diff:number, ratio:number, note:string}}
 */
export function comparePNG(aPath, bPath, { tolerance = 12 } = {}) {
  const a = decodePNG(aPath);
  const b = decodePNG(bPath);

  if (a.width !== b.width || a.height !== b.height) {
    return {
      same: false, total: 0, diff: 0, ratio: 1,
      note: `dimensions differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    };
  }

  const total = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < total; i++) {
    const o = i * a.channels;
    let bad = false;
    for (let c = 0; c < Math.min(3, a.channels); c++) {
      if (Math.abs(a.pixels[o + c] - b.pixels[o + c]) > tolerance) { bad = true; break; }
    }
    if (bad) diff++;
  }
  const ratio = diff / total;
  return {
    same: ratio < 0.001,
    total, diff, ratio,
    note: `${diff}/${total} pixels differ (${(ratio * 100).toFixed(4)}%)`,
  };
}

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const r = comparePNG(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(r, null, 2));
}
