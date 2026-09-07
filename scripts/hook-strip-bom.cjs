// pnpm postinstall 钩子：清洗 node_modules 内带 UTF-8 BOM 的 package.json。
// 背景：dsh 的清单核对直接 JSON.parse 各依赖包的 package.json，
// 而部分社区包带 BOM 发布，pnpm 每次物化都会把 BOM 从 store 原样带回。
// 本钩子在 pnpm 物化之后、dsh reconcile 之前运行；任何情况下都不让安装失败。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const NM = path.join(__dirname, '..', 'node_modules');
const SKIP = new Set(['.pnpm', '.bin', '.store', '.modules.yaml']);
let fixed = 0;

function cleanFile(pj) {
  let raw;
  try { raw = fs.readFileSync(pj); } catch { return; }
  if (!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) return;
  // 临时文件 + 重命名：避免原地写入沿硬链接污染 pnpm store
  const tmp = pj + '.bomfix-tmp';
  fs.writeFileSync(tmp, raw.subarray(3));
  fs.renameSync(tmp, pj);
  fixed++;
  process.stdout.write(`[strip-bom] cleaned ${path.relative(NM, pj)}\n`);
}

function walk(dir, depth) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p, depth + 1); continue; }
    cleanFile(path.join(p, 'package.json'));
    walk(p, depth + 1);
  }
}

try { if (fs.existsSync(NM)) walk(NM, 0); } catch (err) {
  process.stdout.write(`[strip-bom] non-fatal: ${err && err.message}\n`);
}
process.stdout.write(`[strip-bom] done, ${fixed} file(s) cleaned\n`);
process.exit(0);
