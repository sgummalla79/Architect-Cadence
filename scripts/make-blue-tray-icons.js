// Rewrites tray-32.png and tray-16.png with blue (#2563EB) instead of black.
// Run once: node scripts/make-blue-tray-icons.js
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE_R = 37, BLUE_G = 99, BLUE_B = 235; // #2563EB

// ── CRC32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf  = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── PNG un-filter ─────────────────────────────────────────────────────────────

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const src  = y * (stride + 1) + 1;
    const dest = y * stride;
    const prev = y === 0 ? null : pixels.slice((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x++) {
      const filt = raw[src + x];
      const a    = x >= bpp ? pixels[dest + x - bpp] : 0;
      const b    = prev     ? prev[x]                 : 0;
      const c    = (prev && x >= bpp) ? prev[x - bpp] : 0;

      switch (filterType) {
        case 0: pixels[dest + x] = filt;                             break;
        case 1: pixels[dest + x] = (filt + a) & 0xFF;               break;
        case 2: pixels[dest + x] = (filt + b) & 0xFF;               break;
        case 3: pixels[dest + x] = (filt + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: pixels[dest + x] = (filt + paethPredictor(a, b, c)) & 0xFF; break;
        default: throw new Error(`Unknown PNG filter type: ${filterType}`);
      }
    }
  }
  return pixels;
}

// ── Main recolor ──────────────────────────────────────────────────────────────

function recolorTray(inputPath, outputPath) {
  const buf = fs.readFileSync(inputPath);

  let offset = 8; // skip PNG signature
  let ihdrData;
  const idatChunks = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type   = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data   = buf.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') ihdrData = data;
    if (type === 'IDAT') idatChunks.push(data);
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const width     = ihdrData.readUInt32BE(0);
  const height    = ihdrData.readUInt32BE(4);
  const colorType = ihdrData[9];
  const bpp       = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;

  const raw    = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = unfilter(raw, width, height, bpp);

  // Replace every visible pixel's colour with blue, preserve alpha.
  for (let i = 0; i < width * height; i++) {
    const base  = i * bpp;
    const alpha = bpp === 4 ? pixels[base + 3] : 255;
    if (alpha > 0) {
      pixels[base]     = BLUE_R;
      pixels[base + 1] = BLUE_G;
      pixels[base + 2] = BLUE_B;
    }
  }

  // Re-encode using filter type 0 (None) — simplest, lossless for our purposes.
  const stride  = width * bpp;
  const rawOut  = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawOut[y * (stride + 1)] = 0; // filter type None
    pixels.copy(rawOut, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(rawOut, { level: 9 });

  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(outputPath, out);
  console.log(`Written: ${outputPath}`);
}

const iconsDir = path.join(__dirname, '../build/icons');
recolorTray(path.join(iconsDir, 'tray-32.png'), path.join(iconsDir, 'tray-32.png'));
recolorTray(path.join(iconsDir, 'tray-16.png'), path.join(iconsDir, 'tray-16.png'));
