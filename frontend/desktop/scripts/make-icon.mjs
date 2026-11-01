// Draws the app icon (build/icon.png, 1024×1024): a violet rounded square with a white "record" dot.
// electron-builder turns it into .ico / .icns. Pure Node (zlib + a tiny PNG encoder), no image libraries.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const S = 1024;
const px = Buffer.alloc(S * S * 4);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded square (squircle-ish) with 1 px anti-aliasing
    const m = 72, r = 210, half = S / 2 - m;
    const qx = Math.abs(x + 0.5 - S / 2) - (half - r), qy = Math.abs(y + 0.5 - S / 2) - (half - r);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    const inside = 1 - smooth(-1, 1, d);
    // diagonal violet gradient
    const t = (x + y) / (2 * S);
    let R = lerp(124, 79, t), G = lerp(92, 70, t), B = lerp(255, 229, t);
    // white record dot with a soft ring
    const dd = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2);
    const dot = 1 - smooth(196, 200, dd);
    const ring = (1 - smooth(268, 272, dd)) * smooth(244, 248, dd) * 0.35;
    const w = Math.max(dot, ring);
    R = lerp(R, 255, w); G = lerp(G, 255, w); B = lerp(B, 255, w);
    const i = (y * S + x) * 4;
    px[i] = Math.round(R); px[i + 1] = Math.round(G); px[i + 2] = Math.round(B); px[i + 3] = Math.round(255 * inside);
  }
}

// PNG: signature + IHDR + IDAT (filter 0 per row) + IEND
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('[make-icon]', out, `${(png.length / 1024).toFixed(0)} KB`);
