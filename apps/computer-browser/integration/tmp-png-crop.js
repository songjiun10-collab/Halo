"use strict";

// TEMPORARY image helper (not a test): precise crop of a PNG capture into a
// new PNG so small regions can be inspected at full resolution.
//   node integration/tmp-png-crop.js <in.png> <x0,y0,x1,y1> <out.png>   (pixel coords)

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
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
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

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const [, , inFile, regionText, outFile] = process.argv;
const [x0, y0, x1, y1] = regionText.split(",").map(Number);
const img = decodePng(fs.readFileSync(inFile));
const w = x1 - x0, h = y1 - y0;
const rgba = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const si = ((y0 + y) * img.width + (x0 + x)) * img.channels;
    const di = (y * w + x) * 4;
    rgba[di] = img.data[si];
    rgba[di + 1] = img.data[si + 1];
    rgba[di + 2] = img.data[si + 2];
    rgba[di + 3] = 255;
  }
}
fs.writeFileSync(outFile, encodePng(w, h, rgba));
console.log(JSON.stringify({ inFile, region: [x0, y0, x1, y1], outFile, size: [w, h] }));
