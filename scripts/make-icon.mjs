// Draws the original ThickShake icon (a low-poly shake with a straw) with no
// image dependencies, and writes public/icon.png plus build/icon.ico.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// Polygons in a 256-unit canvas, painted back to front.
const shapes = [
  { c: '#17191c', rounded: true },
  { c: '#c7362f', p: [[160, 18], [178, 24], [150, 104], [132, 98]] },
  { c: '#ee8ba4', p: [[62, 102], [98, 64], [128, 56], [160, 64], [194, 102]] },
  { c: '#f7b2c4', p: [[98, 64], [128, 56], [128, 102], [62, 102]] },
  { c: '#a8121e', p: [[114, 50], [128, 38], [142, 50], [128, 64]] },
  { c: '#f2b24c', p: [[54, 102], [128, 102], [128, 238], [80, 238]] },
  { c: '#d9952f', p: [[128, 102], [202, 102], [176, 238], [128, 238]] },
  { c: '#f8cf85', p: [[48, 96], [208, 96], [204, 114], [52, 114]] },
];

function inside(p, x, y) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}

function roundedRect(x, y, r) {
  const qx = Math.abs(x - 128) - (128 - r), qy = Math.abs(y - 128) - (128 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = ((x + (sx + 0.5) / SS) / size) * 256, uy = ((y + (sy + 0.5) / SS) / size) * 256;
      let col = null;
      for (const s of shapes) {
        if (s.rounded ? roundedRect(ux, uy, 44) : inside(s.p, ux, uy)) col = hex(s.c);
      }
      if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
    }
    const i = (y * size + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a / (SS * SS)) * 255; }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
mkdirSync('build', { recursive: true });
writeFileSync('public/icon.png', png(256));

// ICO containers may hold PNGs directly.
const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const head = Buffer.alloc(6 + sizes.length * 16);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const o = 6 + i * 16;
  head[o] = s === 256 ? 0 : s; head[o + 1] = s === 256 ? 0 : s;
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(images[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
  offset += images[i].length;
});
writeFileSync('build/icon.ico', Buffer.concat([head, ...images]));
console.log('Wrote public/icon.png and build/icon.ico');
