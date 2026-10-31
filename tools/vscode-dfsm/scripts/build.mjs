import * as esbuild from 'esbuild';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

/**
 * Generates a crisp 128x128 RGBA PNG extension icon for Marketplace / VSIX packaging
 * using pure Node.js built-ins (zlib + CRC32) with zero native image dependencies.
 */
function ensureExtensionIconPng(targetPath) {
  if (existsSync(targetPath)) {
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const width = 128;
  const height = 128;
  const raw = Buffer.alloc(height * (1 + width * 4));

  const setPixel = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = y * (1 + width * 4) + 1 + x * 4;
    raw[idx] = r;
    raw[idx + 1] = g;
    raw[idx + 2] = b;
    raw[idx + 3] = a;
  };

  const inRoundedRect = (x, y, x0, y0, w, h, radius) => {
    const rx = Math.max(x0 + radius - x, 0, x - (x0 + w - 1 - radius));
    const ry = Math.max(y0 + radius - y, 0, y - (y0 + h - 1 - radius));
    return rx * rx + ry * ry <= radius * radius;
  };

  // Background rounded tile (#0F172A -> #1E293B gradient)
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      if (inRoundedRect(x, y, 4, 4, 120, 120, 24)) {
        const t = (x + y) / (width + height);
        const r = Math.round(15 + t * 20);
        const g = Math.round(23 + t * 28);
        const b = Math.round(42 + t * 48);
        setPixel(x, y, r, g, b, 255);
      }
    }
  }

  // Draw state nodes (indigo top-left, emerald top-right, amber bottom) & connector bars
  for (let y = 52; y <= 58; y++) {
    for (let x = 48; x <= 80; x++) {
      setPixel(x, y, 99, 102, 241, 255);
    }
  }
  for (let y = 58; y <= 88; y++) {
    for (let x = 61; x <= 67; x++) {
      setPixel(x, y, 56, 189, 248, 255);
    }
  }

  for (let y = 26; y < 62; y++) {
    for (let x = 20; x < 58; x++) {
      if (inRoundedRect(x, y, 20, 26, 38, 36, 9)) {
        setPixel(x, y, 99, 102, 241, 255);
      }
    }
  }
  for (let y = 26; y < 62; y++) {
    for (let x = 70; x < 108; x++) {
      if (inRoundedRect(x, y, 70, 26, 38, 36, 9)) {
        setPixel(x, y, 16, 185, 129, 255);
      }
    }
  }
  for (let y = 74; y < 106; y++) {
    for (let x = 40; x < 88; x++) {
      if (inRoundedRect(x, y, 40, 74, 48, 32, 9)) {
        setPixel(x, y, 245, 158, 11, 255);
      }
    }
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const makeChunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
  writeFileSync(targetPath, png);
  console.log(`[build] Generated extension icon at ${targetPath}`);
}

ensureExtensionIconPng(resolve(rootDir, 'resources/icon.png'));

await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/extension.ts')],
  bundle: true,
  outfile: resolve(rootDir, 'dist/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info'
});
