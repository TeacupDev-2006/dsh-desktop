#!/usr/bin/env node
// 打包 vendor.zip：干净的 runtime + dsh-home + plugin-report.json 单文件分发。
// 为什么要 zip：NSIS 打包深层 node_modules 路径时会静默丢文件（实测 vendor/runtime 整个消失）。
// dsh-home 模板中的符号链接一律跳过（dsh 启动时会按本机位置重建）。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const STAGING = path.join(ROOT, 'dist', 'vendor-staging');
const OUT_ZIP = path.join(ROOT, 'vendor.zip');

function log(m) { console.log('[pack] ' + m); }
function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// 递归复制，跳过符号链接与 .bomfix-tmp 残留
function copyTree(src, dest, state) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isSymbolicLink()) { state.links++; continue; }
    if (e.isDirectory()) {
      if (e.name === '.pnpm' || e.name === '.store') { state.links++; continue; }
      copyTree(s, d, state);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      if (++state.files % 4000 === 0) log(`  已复制 ${state.files} 个文件…`);
    }
  }
}

function main() {
  if (!exists(path.join(VENDOR, 'runtime', 'engine.json'))) {
    throw new Error('vendor/runtime 未准备，请先运行 npm run prepare:engine && npm run prepare:plugins');
  }

  log('清理旧的 staging 与 zip…');
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.rmSync(OUT_ZIP, { force: true });
  fs.mkdirSync(STAGING, { recursive: true });

  const state = { files: 0, links: 0 };
  log('复制 runtime（真实文件，跳过链接）…');
  copyTree(path.join(VENDOR, 'runtime'), path.join(STAGING, 'runtime'), state);
  log('复制 dsh-home…');
  copyTree(path.join(VENDOR, 'dsh-home'), path.join(STAGING, 'dsh-home'), state);
  if (exists(path.join(VENDOR, 'plugin-report.json'))) {
    fs.copyFileSync(path.join(VENDOR, 'plugin-report.json'), path.join(STAGING, 'plugin-report.json'));
  }
  log(`复制完成：${state.files} 个文件，跳过 ${state.links} 个链接`);

  log('压缩 vendor.zip（.NET ZipFile，流式）…');
  const ps = spawnSync('powershell', [
    '-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `[IO.Compression.ZipFile]::CreateFromDirectory('${STAGING.replace(/'/g, "''")}', '${OUT_ZIP.replace(/'/g, "''")}', 'Optimal', $false)`,
  ], { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error('压缩失败');

  const mb = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
  fs.rmSync(STAGING, { recursive: true, force: true });
  log(`vendor.zip 完成：${mb} MB ✓`);
}

try {
  main();
} catch (e) {
  console.error('[pack] 失败:', e.message);
  process.exit(1);
}
