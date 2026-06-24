// Dev-only icon generator. Run: `node tools/make-icons.mjs`
//
// Produces icons/{green,grey}-{16,32,48,128}.png — a circular two-arrow "recycle"
// glyph in green (ON) and grey (OFF). Uses ONLY Node built-ins (zlib) so there is
// no dependency to install. The glyph is rendered with 4x supersampling for clean
// anti-aliased edges, then encoded as 8-bit RGBA PNG.
//
// This file is NOT part of the extension runtime; Chrome never loads it.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- PNG encoding (built-in zlib only) ----------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Glyph geometry ------------------------------------------------------------

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const DEG = Math.PI / 180;

// Returns true if the supersample point (x, y) is inside the glyph drawn on an SxS canvas.
function inGlyph(x, y, S) {
  const cx = S / 2;
  const cy = S / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);

  const rOuter = 0.45 * S;
  const rInner = 0.22 * S;
  const rMid = (rOuter + rInner) / 2;

  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (a < 0) a += 360;

  // Two arcs (annulus segments), rotationally symmetric by 180°.
  const a1s = 25;
  const a1e = 150;
  const a2s = a1s + 180;
  const a2e = a1e + 180;
  const inAnnulus = r >= rInner && r <= rOuter;
  const inArc = (lo, hi) => a >= lo && a <= hi;
  if (inAnnulus && (inArc(a1s, a1e) || inArc(a2s, a2e))) return true;

  // Arrowhead at the leading (increasing-angle) end of each arc.
  const tipAhead = 28; // degrees beyond the arc end for the tip
  const overhang = 0.12 * S; // base extends beyond the ring thickness
  const arrow = (angEnd) => {
    const baseAng = angEnd * DEG;
    const tipAng = (angEnd + tipAhead) * DEG;
    const ax = cx + (rOuter + overhang) * Math.cos(baseAng);
    const ay = cy + (rOuter + overhang) * Math.sin(baseAng);
    const bx = cx + (rInner - overhang) * Math.cos(baseAng);
    const by = cy + (rInner - overhang) * Math.sin(baseAng);
    const tx = cx + rMid * Math.cos(tipAng);
    const ty = cy + rMid * Math.sin(tipAng);
    return inTriangle(x, y, ax, ay, bx, by, tx, ty);
  };
  return arrow(a1e) || arrow(a2e);
}

function drawIcon(size, rgb) {
  const SS = 4;
  const S = size * SS;
  const cov = new Float32Array(size * size);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inGlyph(x + 0.5, y + 0.5, S)) {
        cov[((y / SS) | 0) * size + ((x / SS) | 0)] += 1;
      }
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  const inv = 1 / (SS * SS);
  for (let i = 0; i < size * size; i++) {
    const alpha = Math.min(1, cov[i] * inv);
    rgba[i * 4 + 0] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = Math.round(alpha * 255);
  }
  return rgba;
}

// ---- Main ----------------------------------------------------------------------

// Acts on the current extension directory: writes icons into ./src/icons.
const outDir = join(process.cwd(), 'src', 'icons');
mkdirSync(outDir, { recursive: true });

const COLORS = { green: [67, 160, 71], grey: [158, 158, 158] };
const SIZES = [16, 32, 48, 128];

for (const [name, rgb] of Object.entries(COLORS)) {
  for (const size of SIZES) {
    const png = encodePNG(size, size, drawIcon(size, rgb));
    writeFileSync(join(outDir, `${name}-${size}.png`), png);
    console.log(`wrote icons/${name}-${size}.png (${png.length} bytes)`);
  }
}
