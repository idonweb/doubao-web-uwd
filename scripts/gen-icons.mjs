// 生成扩展图标（16 / 32 / 48 / 128 PNG）。
// 零依赖：用纯 Node（zlib）手写 PNG 编码器，4x 超采样做抗锯齿。
// 视觉：豆包品牌蓝圆角方形 + 白色下载图标（与 UI 内联 SVG 同一套几何）。
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'icons');

const BRAND = [0x00, 0x57, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // 超采样倍数

/* ---------- 几何（以 24×24 视图盒为单位，与 icons.ts 的 SVG 一致） ---------- */

function roundRectSDF(px, py, x0, y0, x1, y1, r) {
  // 返回「到圆角矩形边界的有符号距离」，<0 表示在内部
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 下载图标：竖条 + 箭头 + 底部 U 形托盘 */
function inGlyph(x, y) {
  const dy = y + 0.6; // 整体上移，视觉居中
  // 竖条
  if (roundRectSDF(x, dy, 10.6, 3.0, 13.4, 11.2, 0.5) < 0) return true;
  // 箭头
  if (pointInTriangle(x, dy, 6.9, 10.6, 17.1, 10.6, 12, 16.9)) return true;
  // 托盘（三条圆角矩形拼 U 形）
  if (roundRectSDF(x, dy, 4.4, 15.6, 6.6, 21.0, 1.1) < 0) return true;
  if (roundRectSDF(x, dy, 17.4, 15.6, 19.6, 21.0, 1.1) < 0) return true;
  if (roundRectSDF(x, dy, 4.4, 18.8, 19.6, 21.0, 1.1) < 0) return true;
  return false;
}

function inBackground(x, y) {
  return roundRectSDF(x, y, 1.0, 1.0, 23.0, 23.0, 5.2) < 0;
}

/* ---------- PNG 编码 ---------- */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 渲染 ---------- */

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const unit = 24 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0;
      let glyphHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * unit;
          const uy = (y + (sy + 0.5) / SS) * unit;
          if (inBackground(ux, uy)) {
            bgHit++;
            if (inGlyph(ux, uy)) glyphHit++;
          }
        }
      }
      const total = SS * SS;
      const alpha = bgHit / total;
      const g = bgHit ? glyphHit / bgHit : 0;
      const i = (y * size + x) * 4;
      // 在品牌蓝与纯白之间按字形覆盖率插值（颜色边缘自带抗锯齿）
      px[i] = Math.round(BRAND[0] * (1 - g) + WHITE[0] * g);
      px[i + 1] = Math.round(BRAND[1] * (1 - g) + WHITE[1] * g);
      px[i + 2] = Math.round(BRAND[2] * (1 - g) + WHITE[2] * g);
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, px);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = render(size);
  const file = path.join(outDir, `icon${size}.png`);
  await writeFile(file, png);
  console.log(`[icons] ${path.relative(root, file)}  ${png.length} B`);
}
