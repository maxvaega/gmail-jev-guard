#!/usr/bin/env node
/**
 * JevGuard — icon generator.
 *
 * Writes icons/icon16.png, icon48.png, icon128.png with zero dependencies:
 * there is no ImageMagick and no PIL on this machine, so this file contains a
 * tiny PNG encoder (IHDR + IDAT deflated over filter-0 scanlines + IEND, RGBA8)
 * and draws the artwork procedurally.
 *
 * Artwork: a rounded shield silhouette on a transparent background, filled with
 * the same green -> red ramp used by the risk bar (hue 120 at the top-left, hue 0
 * at the bottom-right), with a small white vertical bar in the centre.
 * Edges are anti-aliased by supersampling 4x and box-averaging in premultiplied
 * alpha, so the shield outline stays clean at 16 px.
 *
 * Run:  node tools/make-icons.mjs
 */

import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(HERE, "..", "icons");
const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** length + type + data + crc(type+data). */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** RGBA8 pixels (width*height*4) -> a complete PNG file. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------- drawing ---- */

/** hsl (h in degrees, s and l in 0..1) -> [r, g, b] in 0..255. */
function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round(Math.min(Math.max(v + m, 0), 1) * 255));
}

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

/**
 * Shield geometry, in pixels of the supersampled canvas.
 * Flat top with rounded corners down to the shoulder, then an elliptical taper
 * to a rounded tip — no sub-pixel spike at the bottom.
 */
function shieldGeometry(size) {
  const top = 0.08 * size;
  const bottom = 0.95 * size;
  return {
    cx: 0.5 * size,
    top,
    bottom,
    height: bottom - top,
    halfWidth: 0.40 * size,
    cornerRadius: 0.20 * size,
    shoulderY: top + 0.46 * (bottom - top)
  };
}

function insideShield(x, y, g) {
  if (y < g.top || y > g.bottom) return false;
  const dx = Math.abs(x - g.cx);
  if (y <= g.shoulderY) {
    let halfWidth = g.halfWidth;
    const cornerCentreY = g.top + g.cornerRadius;
    if (y < cornerCentreY) {
      const dy = cornerCentreY - y;
      const inner = g.cornerRadius * g.cornerRadius - dy * dy;
      if (inner <= 0) return false;
      halfWidth = g.halfWidth - g.cornerRadius + Math.sqrt(inner);
    }
    return dx <= halfWidth;
  }
  const t = (y - g.shoulderY) / (g.bottom - g.shoulderY);
  const halfWidth = g.halfWidth * Math.pow(Math.max(0, 1 - t * t), 0.62);
  return dx <= halfWidth;
}

/** The white motif: one vertical capsule in the centre of the shield mass. */
function insideBar(x, y, g) {
  const barHalfWidth = Math.max(0.5, 0.115 * g.halfWidth);
  const barHalfHeight = Math.max(barHalfWidth, 0.21 * g.height);
  const centreY = g.top + 0.42 * g.height;
  const dx = Math.abs(x - g.cx);
  const dy = Math.abs(y - centreY);
  const qy = Math.max(dy - (barHalfHeight - barHalfWidth), 0);
  return Math.hypot(dx, qy) <= barHalfWidth;
}

/**
 * Colour of one subsample: [r, g, b, a] with a either 0 or 255.
 * The diagonal ramp is normalised over the shield's own box and then stretched
 * over the range the silhouette actually occupies, so the tip really reaches red.
 */
function sample(x, y, g) {
  if (!insideShield(x, y, g)) return [0, 0, 0, 0];
  if (insideBar(x, y, g)) return [255, 255, 255, 255];
  const tx = (x - (g.cx - g.halfWidth)) / (2 * g.halfWidth);
  const ty = (y - g.top) / g.height;
  const t = clamp01(((tx + ty) / 2 - 0.06) / 0.72);
  const [r, gr, b] = hslToRgb(120 * (1 - t), 0.7, 0.45);
  return [r, gr, b, 255];
}

/** Render one icon at `size` px, anti-aliased by box-averaging SUPERSAMPLE^2 samples. */
function renderIcon(size) {
  const big = size * SUPERSAMPLE;
  const g = shieldGeometry(big);
  const out = Buffer.alloc(size * size * 4);
  const perPixel = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px * SUPERSAMPLE + sx + 0.5;
          const y = py * SUPERSAMPLE + sy + 0.5;
          const [r, gr, b, a] = sample(x, y, g);
          // Premultiplied accumulation: straight averaging would darken the edges.
          sumR += r * a;
          sumG += gr * a;
          sumB += b * a;
          sumA += a;
        }
      }
      const offset = (py * size + px) * 4;
      const alpha = Math.round(sumA / perPixel);
      if (alpha > 0 && sumA > 0) {
        out[offset] = Math.round(sumR / sumA);
        out[offset + 1] = Math.round(sumG / sumA);
        out[offset + 2] = Math.round(sumB / sumA);
      }
      out[offset + 3] = alpha;
    }
  }
  return out;
}

/* --------------------------------------------------------- verification ---- */

/** Re-read the written file and prove it decodes: signature, IHDR, inflated IDAT size. */
function verifyPng(path, expectedSize) {
  const file = readFileSync(path);
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${path}: bad PNG signature`);

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  let sawEnd = false;

  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = file.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (declaredCrc !== actualCrc) throw new Error(`${path}: CRC mismatch in chunk ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      sawEnd = true;
    }
    offset += 12 + length;
  }

  if (!sawEnd) throw new Error(`${path}: missing IEND`);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${path}: IHDR says ${width}x${height}, expected ${expectedSize}`);
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const expectedBytes = height * (1 + width * 4);
  if (inflated.length !== expectedBytes) {
    throw new Error(`${path}: inflated ${inflated.length} bytes, expected ${expectedBytes}`);
  }
  if (file.length < 100) throw new Error(`${path}: suspiciously small (${file.length} bytes)`);
  return { bytes: file.length, width, height };
}

/* ---------------------------------------------------------------- main ----- */

function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  for (const size of SIZES) {
    const path = join(ICONS_DIR, `icon${size}.png`);
    writeFileSync(path, encodePng(size, size, renderIcon(size)));
    const info = verifyPng(path, size);
    console.log(`ok  ${path}  ${info.width}x${info.height}  ${info.bytes} bytes`);
  }
}

main();
