#!/usr/bin/env node
/* =========================================================================
   build/gen-icon.js — generates the app icon. Zero dependencies.

   Draws the brand tile programmatically (indigo→violet rounded square,
   white document sheet, amber margin-note bar, text lines) with a small
   signed-distance-field rasteriser, then encodes PNG and ICO buffers with
   Node's zlib. Re-run after changing the design:

       node build/gen-icon.js

   Outputs:  build/icon.png   (1024² master, used by electron-builder)
             build/icon.ico   (256², Windows)
             desktop/icon.png (256², window icon, packaged)
             desktop/icon.ico (256², window icon, packaged)
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------- PNG codec */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------- ICO codec */

function encodeIco(png256) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;             // 256px is encoded as 0
  entry[2] = 0; entry[3] = 0;             // palette / reserved
  entry.writeUInt16LE(1, 4);              // planes
  entry.writeUInt16LE(32, 6);             // bits per pixel
  entry.writeUInt32LE(png256.length, 8);  // bytes of embedded PNG
  entry.writeUInt32LE(22, 12);            // offset: 6 + 16
  return Buffer.concat([head, entry, png256]);
}

/* ------------------------------------------------------------ geometry */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const mixc = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Signed distance to a rounded rectangle (u, v in normalised units). */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a round-capped segment. */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Anti-aliased coverage of a signed distance (aa ≈ one sample pixel). */
function cov(d, aa) {
  const t = clamp(0.5 - d / (2 * aa), 0, 1);
  return t * t * (3 - 2 * t);
}

/* --------------------------------------------------------------- palette */

const I500  = [99, 102, 241];    // indigo-500   (theme --a-500)
const V500  = [139, 92, 246];    // violet-500
const WHITE = [255, 255, 255];
const AMBER = [251, 191, 36];    // margin-note highlight
const LINE  = [71, 85, 105];     // slate-600 "text" lines

/**
 * Colour of one normalised point: gradient tile, white sheet, amber margin
 * bar, three text lines. Returns [r, g, b, a] with a in 0..255.
 */
function shade(u, v) {
  const aa = 0.0016;

  const aTile = cov(sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225), aa);
  const t = clamp(0.1 + 0.8 * (0.35 * u + 0.65 * v), 0, 1);
  let c = mixc(I500, V500, t);

  const aSheet = cov(sdRoundRect(u, v, 0.5, 0.505, 0.27, 0.365, 0.05), aa) * aTile;
  c = mixc(c, WHITE, aSheet);

  const aBar = cov(sdRoundRect(u, v, 0.322, 0.5, 0.021, 0.265, 0.021), aa) * aSheet;
  c = mixc(c, AMBER, aBar);

  const d1 = sdSegment(u, v, 0.395, 0.345, 0.685, 0.345, 0.018);
  const d2 = sdSegment(u, v, 0.395, 0.460, 0.685, 0.460, 0.018);
  const d3 = sdSegment(u, v, 0.395, 0.575, 0.530, 0.575, 0.018);
  const aLine = cov(Math.min(d1, d2, d3), aa) * aSheet;
  c = mixc(c, LINE, aLine);

  return [c[0], c[1], c[2], aTile * 255];
}

/** Render at `size` with `ss`×`ss` supersampling; returns Float64 RGBA. */
function renderMaster(size, ss) {
  const W = size * ss;
  const acc = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x * ss + sx + 0.5) / W, (y * ss + sy + 0.5) / W);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      acc[i] = r / n; acc[i + 1] = g / n; acc[i + 2] = b / n; acc[i + 3] = a / n;
    }
  }
  return acc;
}

function toBuffer(acc) {
  const n = acc.length / 4;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4]     = Math.round(clamp(acc[i * 4], 0, 255));
    out[i * 4 + 1] = Math.round(clamp(acc[i * 4 + 1], 0, 255));
    out[i * 4 + 2] = Math.round(clamp(acc[i * 4 + 2], 0, 255));
    out[i * 4 + 3] = Math.round(clamp(acc[i * 4 + 3], 0, 255));
  }
  return out;
}

/** Premultiplied area downscale — no halos at transparent edges. */
function downscale(buf, from, to) {
  const f = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.floor((x + 1) * f));
      const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.floor((y + 1) * f));
      for (let yy = y0; yy < y1 && yy < from; yy++) {
        for (let xx = x0; xx < x1 && xx < from; xx++) {
          const i = (yy * from + xx) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al;
        }
      }
      const cnt = (x1 - x0) * (y1 - y0);
      const av = a / cnt;
      const o = (y * to + x) * 4;
      if (a > 0.0001) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(av * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ main */

function writeIcons() {
  const MASTER = 1024;
  const SMALL = 256;

  console.log('Rendering %d×%d icon…', MASTER, MASTER);
  const master = toBuffer(renderMaster(MASTER, 3));
  const small = downscale(master, MASTER, SMALL);

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'desktop'), { recursive: true });

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), encodePng(MASTER, master));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), encodeIco(encodePng(SMALL, small)));
  fs.writeFileSync(path.join(ROOT, 'desktop', 'icon.png'), encodePng(SMALL, small));
  fs.writeFileSync(path.join(ROOT, 'desktop', 'icon.ico'), encodeIco(encodePng(SMALL, small)));

  console.log('Wrote build/icon.png, build/icon.ico, desktop/icon.png, desktop/icon.ico');
}

if (require.main === module) writeIcons();

module.exports = {
  crc32,
  chunk,
  encodePng,
  encodeIco,
  sdRoundRect,
  sdSegment,
  cov,
  shade,
  renderMaster,
  toBuffer,
  downscale,
  writeIcons
};
