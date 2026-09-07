#!/usr/bin/env node
// 生成 resources/icon.ico + icon.png：原创 "DSH_" 字标（DeepSeek 品牌蓝 #4D6BFE 渐变底）。
// 按 DSH 官方品牌规范，第三方项目不直接使用官方 logo，此处为原创设计。
// 纯 Node 实现：SDF 绘制（线段/圆弧/圆角矩形）→ 各尺寸 PNG（zlib 内置）→ ICO 容器封装。
// 16-32px 小尺寸层用终端箭头 motif（全字标在该尺寸不可读）。
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CANVAS = 1024; // 几何坐标系（所有图形以此空间定义，按目标尺寸缩放采样）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const HALF_W = 36;   // 大尺寸字标笔画半宽
const SMALL_HALF_W = 64; // 小尺寸 motif 笔画半宽

// ---------- 极简 PNG 编码器（RGBA 8bit） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- ICO 容器（多尺寸，条目为 PNG 压缩，Vista+ 支持） ----------
function wrapICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = e[0];
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ---------- SDF ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// 圆弧：圆 + 半平面约束；约束外取端点距离（端点与相邻笔画衔接）
function sdArc(px, py, arc) {
  const cond = arc.axis === 'x'
    ? (arc.dir === '>=' ? px >= arc.value : px <= arc.value)
    : (arc.dir === '>=' ? py >= arc.value : py <= arc.value);
  if (cond) return Math.abs(Math.hypot(px - arc.cx, py - arc.cy) - arc.r);
  let d = Infinity;
  for (const [ex, ey] of arc.ends) d = Math.min(d, Math.hypot(px - ex, py - ey));
  return d;
}

// ---------- 字形（1024 几何空间） ----------
// "DSH_"：D 碗形右半圆 + S 双半圆环带斜脊 + H 双柱一横 + 基线下光标
const GLYPH_DSH = {
  segments: [
    [100, 312, 100, 652],   // D 竖笔
    [388, 426, 616, 538],   // S 斜脊
    [736, 312, 736, 652],   // H 左柱
    [924, 312, 924, 652],   // H 右柱
    [736, 482, 924, 482],   // H 横梁
    [736, 746, 924, 746],   // 光标下划线
  ],
  arcs: [
    { cx: 100, cy: 482, r: 170, axis: 'x', dir: '>=', value: 100, ends: [[100, 312], [100, 652]] }, // D 碗形
    { cx: 502, cy: 426, r: 114, axis: 'y', dir: '<=', value: 426, ends: [[388, 426], [616, 426]] }, // S 上环
    { cx: 502, cy: 538, r: 114, axis: 'y', dir: '>=', value: 538, ends: [[388, 538], [616, 538]] }, // S 下环
  ],
};

// 小尺寸 motif：终端箭头 + 光标（16-32px 下全字标不可读）
const GLYPH_CHEVRON = {
  segments: [
    [250, 300, 500, 512],
    [500, 512, 250, 724],
    [560, 700, 790, 700],
  ],
  arcs: [],
};

// ---------- 渲染 ----------
function render(size, glyphs, halfW) {
  const px = Buffer.alloc(size * size * 4);
  const scale = CANVAS / size;
  const aa = scale; // 约 1 像素抗锯齿（几何单位）
  const RR = 224;   // 底板圆角半径
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) * scale, gy = (y + 0.5) * scale;
      // 圆角矩形底板
      const qx = Math.abs(gx - 512) - (512 - RR);
      const qy = Math.abs(gy - 512) - (512 - RR);
      const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RR;
      const bg = clamp01(0.5 - sdf / aa);
      if (bg <= 0) continue;
      // 对角渐变：DeepSeek 品牌蓝 #4D6BFE 居中
      const t = clamp01((gx + gy) / (CANVAS * 2));
      let r = lerp(0x5e, 0x3d, t), g = lerp(0x7a, 0x52, t), b = lerp(0xff, 0xe8, t);
      // 白色笔画
      let d = Infinity;
      for (const seg of glyphs.segments) d = Math.min(d, sdSegment(gx, gy, seg[0], seg[1], seg[2], seg[3]));
      for (const arc of glyphs.arcs) d = Math.min(d, sdArc(gx, gy, arc));
      const cov = clamp01(0.5 + (halfW - d) / aa);
      if (cov > 0) {
        r = r * (1 - cov) + 255 * cov;
        g = g * (1 - cov) + 255 * cov;
        b = b * (1 - cov) + 255 * cov;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(bg * 255);
    }
  }
  return px;
}

function main() {
  const outDir = path.join(__dirname, '..', 'resources');
  fs.mkdirSync(outDir, { recursive: true });

  const pngs = ICO_SIZES.map((size) => {
    const small = size <= 32;
    const rgba = render(size, small ? GLYPH_CHEVRON : GLYPH_DSH, small ? SMALL_HALF_W : HALF_W);
    return { size, data: encodePNG(size, size, rgba) };
  });

  fs.writeFileSync(path.join(outDir, 'icon.ico'), wrapICO(pngs));
  fs.writeFileSync(path.join(outDir, 'icon.png'), pngs.find((p) => p.size === 256).data);
  // 预览图（不参与打包，供人工核对设计）
  const preview = render(512, GLYPH_DSH, HALF_W);
  fs.writeFileSync(path.join(outDir, 'icon-preview.png'), encodePNG(512, 512, preview));
  console.log('[icon] resources/icon.ico（7 尺寸）+ icon.png（256）已生成');
}

main();
