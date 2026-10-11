"use strict";

// TEMPORARY analysis helper (not a test). Decodes a PNG with zlib and prints
// colour statistics for regions of a screen capture, so "is the sidebar
// actually translucent" can be answered without a human eye.
//
//   node integration/tmp-png-stats.js <file.png> <x0,y0,x1,y1> [label]

const fs = require("node:fs");
const zlib = require("node:zlib");

function decodePng(buf) {
  let pos = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels || bitDepth !== 8) throw new Error(`unsupported png: colorType=${colorType} bitDepth=${bitDepth}`);
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (filter !== 0) throw new Error(`bad filter ${filter}`);
      cur[i] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function stats(img, x0, y0, x1, y1) {
  const { width, height, channels, data } = img;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(width, x1); y1 = Math.min(height, y1);
  let n = 0, sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0;
  let minL = 255, maxL = 0;
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let rowSum = 0, rowN = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sr += r; sg += g; sb += b; sr2 += r * r; sg2 += g * g; sb2 += b * b; n++;
      const l = (r + g + b) / 3;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      rowSum += l; rowN++;
    }
    if (y % 40 === 0) rows.push(Number((rowSum / rowN).toFixed(1)));
  }
  const sd = (s, s2) => Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  return {
    region: [x0, y0, x1, y1], pixels: n,
    mean: [sr / n, sg / n, sb / n].map((v) => Number(v.toFixed(1))),
    sd: [sd(sr, sr2), sd(sg, sg2), sd(sb, sb2)].map((v) => Number(v.toFixed(1))),
    lumaMin: Number(minL.toFixed(1)), lumaMax: Number(maxL.toFixed(1)),
    rowLumaEvery40px: rows,
  };
}

const file = process.argv[2];
const [x0, y0, x1, y1] = (process.argv[3] || "0,0,100,100").split(",").map(Number);
const label = process.argv[4] || "region";
const img = decodePng(fs.readFileSync(file));
console.log(JSON.stringify({ file, size: [img.width, img.height], label, ...stats(img, x0, y0, x1, y1) }, null, 2));