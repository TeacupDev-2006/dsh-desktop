#!/usr/bin/env node
// 准备内置引擎：便携 Node 22 LTS (win-x64) + @deepseek-ai/dsh + pnpm + PATH 垫片。
// 产出 vendor/runtime/ 与 vendor/runtime/engine.json（桌面端主进程读取该清单定位引擎）。
// 子进程约束：可执行文件一律为字面量，动态值只经参数数组传入（不经 shell）。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const RUNTIME = path.join(VENDOR, 'runtime');
const CACHE = path.join(VENDOR, 'cache');
const NODE_DIST_URL_BASE = 'https://registry.npmmirror.com/-/binary/node';

const FORCE = process.argv.includes('--force');

function log(m) { console.log('[engine] ' + m); }

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// 断言 target 位于 rootDir 之内，防止动态路径片段越界
function assertInside(rootDir, target) {
  const rootAbs = path.resolve(rootDir) + path.sep;
  const targetAbs = path.resolve(target);
  if (targetAbs !== path.resolve(rootDir) && !targetAbs.startsWith(rootAbs)) {
    throw new Error(`路径越界: ${targetAbs} 不在 ${rootAbs} 内`);
  }
  return targetAbs;
}

async function fetchBuffer(url, redirects = 4) {
  const res = await fetch(url, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location') && redirects > 0) {
    return fetchBuffer(new URL(res.headers.get('location'), url).href, redirects - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveNodeVersion() {
  log('查询 npmmirror 上的 Node 22 LTS 版本列表…');
  const list = JSON.parse((await fetchBuffer(NODE_DIST_URL_BASE + '/index.json')).toString('utf8'));
  const v22 = list
    .map((e) => e.version) // "v22.14.0"
    .filter((v) => /^v22\.\d+\.\d+$/.test(v))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number);
      const pb = b.slice(1).split('.').map(Number);
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
    });
  if (!v22.length) throw new Error('未找到任何 v22.x 版本');
  const chosen = v22[0];
  const entry = list.find((e) => e.version === chosen);
  log(`选定 Node ${chosen}${entry && entry.lts ? ` (lts: ${entry.lts})` : ''}`);
  return chosen;
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  if (tar.status === 0) return;
  log('tar 解压失败，回退 PowerShell Expand-Archive…');
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', zipPath, '-DestinationPath', destDir, '-Force'],
    { stdio: 'inherit' }
  );
  if (ps.status !== 0) throw new Error('zip 解压失败（tar 与 PowerShell 均失败）');
}

async function main() {
  const engineJsonPath = path.join(RUNTIME, 'engine.json');
  if (!FORCE && exists(engineJsonPath)) {
    log('vendor/runtime/engine.json 已存在，跳过（加 --force 重建）');
    return;
  }

  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  // ---------- 1. 便携 Node 22 LTS ----------
  const version = await resolveNodeVersion();
  const zipName = `node-${version}-win-x64.zip`;
  if (!/^node-v\d+\.\d+\.\d+-win-x64\.zip$/.test(zipName)) throw new Error('异常的 zip 文件名: ' + zipName);
  const zipPath = assertInside(CACHE, path.join(CACHE, zipName));
  if (!exists(zipPath)) {
    const url = `${NODE_DIST_URL_BASE}/${version}/${zipName}`;
    log(`下载 ${url} …`);
    const buf = await fetchBuffer(url);
    fs.writeFileSync(zipPath, buf);
    log(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  } else {
    log('使用缓存的 Node zip');
  }

  const nodeDir = assertInside(RUNTIME, path.join(RUNTIME, 'node'));
  if (!exists(path.join(nodeDir, 'node.exe'))) {
    const tmpExtract = assertInside(CACHE, path.join(CACHE, 'node-extract'));
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    log('解压 Node…');
    extractZip(zipPath, tmpExtract);
    // 严格白名单：只接受官方 zip 的顶层目录名
    const innerName = fs.readdirSync(tmpExtract).find((n) => /^node-v\d+\.\d+\.\d+-win-x64$/.test(n));
    if (!innerName) throw new Error('zip 内未找到 node-v*-win-x64 目录');
    const innerAbs = assertInside(tmpExtract, path.join(tmpExtract, innerName));
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.renameSync(innerAbs, nodeDir);
    fs.rmSync(tmpExtract, { recursive: true, force: true });
  }
  const nodeExe = path.join(nodeDir, 'node.exe');
  log(`便携 Node 就绪: ${version}`);

  // npm 走 JS 入口（以字面量 .\\node.exe + cwd 调用，避免 .cmd 需要 shell）
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!exists(npmCli)) throw new Error('便携 Node 中未找到 npm-cli.js');
  const npm = (prefix, ...pkgs) => {
    log(`npm i --prefix ${path.basename(prefix)}: ${pkgs.join(' ')}`);
    const r = spawnSync(
      '.\\node.exe',
      [npmCli, 'i', '--prefix', prefix, ...pkgs, '--no-audit', '--no-fund', '--loglevel=warn'],
      { cwd: nodeDir, stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error(`npm install 失败（${pkgs.join(' ')}），退出码 ${r.status}`);
  };

  // ---------- 2. 安装 @deepseek-ai/dsh ----------
  const dshDir = assertInside(RUNTIME, path.join(RUNTIME, 'dsh'));
  fs.mkdirSync(dshDir, { recursive: true });
  npm(dshDir, '@deepseek-ai/dsh');

  const dshPkgPath = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const dshPkg = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8'));
  let binRel;
  if (typeof dshPkg.bin === 'string') binRel = dshPkg.bin;
  else if (dshPkg.bin && dshPkg.bin.dsh) binRel = dshPkg.bin.dsh;
  else throw new Error('无法从 @deepseek-ai/dsh package.json 解析 bin 入口: ' + JSON.stringify(dshPkg.bin));
  const dshBinAbs = assertInside(dshDir, path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', binRel));
  if (!exists(dshBinAbs)) throw new Error('dsh bin 入口不存在: ' + dshBinAbs);
  log(`dsh 入口: node_modules/@deepseek-ai/dsh/${path.relative(path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh'), dshBinAbs).replace(/\\/g, '/')}`);

  // ---------- 3. 安装 pnpm（dsh plugin 底层依赖 pnpm） ----------
  const pnpmDir = assertInside(RUNTIME, path.join(RUNTIME, 'pnpm'));
  fs.mkdirSync(pnpmDir, { recursive: true });
  npm(pnpmDir, 'pnpm');
  const pnpmPkg = JSON.parse(fs.readFileSync(path.join(pnpmDir, 'node_modules', 'pnpm', 'package.json'), 'utf8'));
  const pnpmBinRel = pnpmPkg.bin && (pnpmPkg.bin.pnpm || Object.values(pnpmPkg.bin)[0]);
  if (!pnpmBinRel) throw new Error('无法解析 pnpm bin');
  const pnpmCjsAbs = assertInside(pnpmDir, path.join(pnpmDir, 'node_modules', 'pnpm', pnpmBinRel));

  // PATH shims used by child processes at runtime (no global installs needed)
  const binDir = assertInside(RUNTIME, path.join(RUNTIME, 'bin'));
  fs.mkdirSync(binDir, { recursive: true });
  const rel = (p) => path.relative(binDir, p);
  fs.writeFileSync(
    path.join(binDir, 'dsh.cmd'),
    `@echo off\r\n"%~dp0${rel(nodeExe)}" "%~dp0${rel(dshBinAbs)}" %*\r\n`
  );
  fs.writeFileSync(
    path.join(binDir, 'pnpm.cmd'),
    `@echo off\r\n"%~dp0${rel(nodeExe)}" "%~dp0${rel(pnpmCjsAbs)}" %*\r\n`
  );
  fs.writeFileSync(
    path.join(binDir, 'pnpx.cmd'),
    `@echo off\r\n"%~dp0${rel(nodeExe)}" "%~dp0${rel(pnpmCjsAbs)}" dlx %*\r\n`
  );
  // engine launcher: workspace/port passed via env; node & dsh entry resolved relative to this file
  fs.writeFileSync(
    path.join(binDir, 'dsh-web.cmd'),
    `@echo off\r\n` +
    `rem Generated by DeepSeek Harness Desktop build. Do not edit.\r\n` +
    `if not defined DSH_WORKSPACE set "DSH_WORKSPACE=%USERPROFILE%\\DeepSeek-Workspace"\r\n` +
    `if not defined DSH_PORT set "DSH_PORT=3080"\r\n` +
    `if not exist "%DSH_WORKSPACE%" mkdir "%DSH_WORKSPACE%"\r\n` +
    `cd /d "%DSH_WORKSPACE%"\r\n` +
    `"%~dp0${rel(nodeExe)}" "%~dp0${rel(dshBinAbs)}" web --no-open --port %DSH_PORT%\r\n`
  );

  // ---------- 5. 引擎清单（路径均相对 vendor/runtime 根） ----------
  const relRuntime = (p) => path.relative(RUNTIME, p);
  const engine = {
    generatedAt: new Date().toISOString(),
    node: { exe: relRuntime(nodeExe), version: version },
    dsh: { bin: relRuntime(dshBinAbs), version: dshPkg.version },
    pnpm: { bin: relRuntime(pnpmCjsAbs), version: pnpmPkg.version },
    binDir: 'bin',
    launcher: relRuntime(path.join(binDir, 'dsh-web.cmd')),
    homeTemplate: path.relative(RUNTIME, path.join(VENDOR, 'dsh-home')),
  };
  fs.writeFileSync(path.join(RUNTIME, 'engine.json'), JSON.stringify(engine, null, 2));
  log('engine.json 已写入');
  log('引擎准备完成 ✓');
}

main().catch((e) => {
  console.error('[engine] 失败:', e.message);
  process.exit(1);
});
