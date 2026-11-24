#!/usr/bin/env node
/**
 * 生成 App 图标（纯 Node 写 PNG，不依赖 sharp / ImageMagick）。
 *
 * 为什么自己写编码器：图标是纯色矩形构成的几何图形，没有任何渐变、
 * 圆角或文字，用不着渲染器。而瑞士风格的立身之本就是"边缘绝对锐利、
 * 色值绝对准确"—— 交给图像库去缩放重采样，反而会引入灰边。
 *
 * 图形语言：四象限网格，左上角实心 = 一格里的事已做完。
 * 与 Web 端的四象限视图是同一套视觉隐喻。
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '..', 'apps', 'mobile', 'assets');

const BLUE = [0x00, 0x2f, 0xa7, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

const CrcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CrcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前加一个 filter byte 0（None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function canvas(size, color = CLEAR) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4] = color[0];
    buf[i * 4 + 1] = color[1];
    buf[i * 4 + 2] = color[2];
    buf[i * 4 + 3] = color[3];
  }
  return buf;
}

function rect(buf, size, x0, y0, w, h, color) {
  for (let y = Math.max(0, y0); y < Math.min(size, y0 + h); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(size, x0 + w); x += 1) {
      const i = (y * size + x) * 4;
      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = color[3];
    }
  }
}

/**
 * 画四象限网格。inset 是图形相对画布边距的比例（Android 自适应图标
 * 要求前景内容收在中间 66% 的安全区内，否则会被圆形裁切吃掉）。
 */
function drawGrid(buf, size, ink, inset, filled) {
  const pad = Math.round(size * inset);
  const box = size - pad * 2;
  const stroke = Math.max(2, Math.round(box * 0.045));
  const mid = pad + Math.round(box / 2 - stroke / 2);

  // 外框四条边
  rect(buf, size, pad, pad, box, stroke, ink);
  rect(buf, size, pad, pad + box - stroke, box, stroke, ink);
  rect(buf, size, pad, pad, stroke, box, ink);
  rect(buf, size, pad + box - stroke, pad, stroke, box, ink);
  // 十字
  rect(buf, size, mid, pad, stroke, box, ink);
  rect(buf, size, pad, mid, box, stroke, ink);
  // 左上格实心。必须与边框、十字线各留一条缝，
  // 否则白色连成一片，四格的边界就消失了，图标看起来只剩一个白框
  if (filled) {
    const gap = Math.round(stroke * 0.75);
    const inner = pad + stroke + gap;
    const cell = mid - gap - inner;
    rect(buf, size, inner, inner, cell, cell, ink);
  }
}

function save(name, size, pixels) {
  writeFileSync(resolve(ASSETS, name), encodePng(size, pixels));
  console.log(`  · ${name}  ${size}x${size}`);
}

console.log('生成图标：');

// 1. 主图标：蓝底 + 白网格（iOS / 通用）
{
  const size = 1024;
  const buf = canvas(size, BLUE);
  drawGrid(buf, size, WHITE, 0.2, true);
  save('icon.png', size, buf);
}

// 2. Android 前景：透明底 + 白网格，收在安全区内
{
  const size = 1024;
  const buf = canvas(size, CLEAR);
  drawGrid(buf, size, WHITE, 0.31, true);
  save('android-icon-foreground.png', size, buf);
}

// 3. Android 背景：纯蓝
{
  const size = 1024;
  save('android-icon-background.png', size, canvas(size, BLUE));
}

// 4. 单色图标（Android 13 主题图标）：透明底 + 白网格
{
  const size = 1024;
  const buf = canvas(size, CLEAR);
  drawGrid(buf, size, WHITE, 0.31, false);
  save('android-icon-monochrome.png', size, buf);
}

// 5. 启动图：白底页面上的蓝色网格
{
  const size = 512;
  const buf = canvas(size, CLEAR);
  drawGrid(buf, size, BLUE, 0.18, true);
  save('splash-icon.png', size, buf);
}

// 6. favicon
{
  const size = 64;
  const buf = canvas(size, BLUE);
  drawGrid(buf, size, WHITE, 0.16, true);
  save('favicon.png', size, buf);
}

console.log('完成。');
