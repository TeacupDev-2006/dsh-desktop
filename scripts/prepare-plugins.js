#!/usr/bin/env node
// 预装社区插件到 web profile：逐个 `dsh plugin add`，每装一个跑一次启动冒烟测试。
// 失败即回滚（remove）并记录；dsh-pocket 冲突时自动跳过。
// 兼容处理：
//  - 部分社区包以带 BOM 的 package.json 发布，dsh 的清单核对不剥 BOM 会崩 —— 装后统一清洗；
//  - git 托管包需要 pnpm allowBuilds 白名单 —— 按提示键自动写入 pnpm-workspace.yaml 并重试。
// 产出 vendor/plugin-report.json。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEngine, bootWeb, RUNTIME, ROOT } = require('./smoke-engine');

const VENDOR = path.join(ROOT, 'vendor');
const DSH_HOME = path.join(VENDOR, 'dsh-home');
const PROFILE = path.join(DSH_HOME, 'profiles', 'web');
const SMOKE_WS = path.join(VENDOR, 'smoke-workspace');

function log(m) { console.log('[plugins] ' + m); }

// 预装清单。specs 依次尝试；conditional 的插件失败即视为"冲突跳过"。
const PLUGINS = [
  { name: 'dsh-worktable', specs: ['https://github.com/Aisland-SJL/dsh-worktable/releases/download/v0.3.0/dsh-worktable.tgz', 'https://github.com/Aisland-SJL/dsh-worktable/releases/latest/download/dsh-worktable.tgz'], note: '项目工作台（侧边栏抽屉+停靠分屏+控制室看板），优先 0.3.0，GitHub Release tarball' },
  { name: 'dsh-memory-plugin', specs: ['dsh-memory-plugin'], note: '跨会话长期记忆（配置行激活）' },
  { name: 'archify', specs: ['archify'], note: '仓库架构图生成（配置行激活）' },
  { name: 'dsh-tui', specs: ['dsh-tui'], note: '全屏终端 UI（独立 CLI，垫片+托盘入口）' },
  { name: 'aegis', specs: ['aegis'], note: '软件工程方法论（配置行激活）' },
  { name: '@liustack/modlens', specs: ['@liustack/modlens'], note: '视觉桥接' },
  { name: '@liustack/modsearch', specs: ['@liustack/modsearch'], note: '免 key 联网搜索' },
  { name: '@nanmicoder/dsh-agent-teams', specs: ['@nanmicoder/dsh-agent-teams'], note: '多智能体团队' },
  { name: 'dsh-context', specs: ['dsh-context'], note: '上下文统计面板' },
  { name: '@dsh-market/plugin', specs: ['@dsh-market/plugin'], note: '侧边栏插件市场' },
  { name: 'dsh-pocket', specs: ['dsh-pocket'], note: '手机扫码访问', conditional: true },
];

// 非 bundle 型插件的激活配置行（写入 profile cordis.patch.yml 的 insert 列表）
const ACTIVATION_ROWS = [
  { id: 'memory', name: 'dsh-memory-plugin' },
  { id: 'archify', name: 'archify' },
  { id: 'aegis', name: 'aegis' },
];

function childEnv() {
  const { nodeExe } = loadEngine();
  const binDir = path.join(RUNTIME, 'bin');
  return {
    ...process.env,
    DSH_HOME,
    DSH_TELEMETRY_MODE: 'DISABLED',
    PATH: `${binDir};${path.dirname(nodeExe)};${process.env.PATH || ''}`,
  };
}

// 以字面量 .\node.exe + cwd=node 目录调用（与 prepare-engine 相同的已验证模式）
function dshCli(args, timeoutMs = 600000) {
  const { nodeExe, dshBin } = loadEngine();
  const nodeDir = path.dirname(nodeExe);
  const r = spawnSync('.\\node.exe', [dshBin, ...args], {
    cwd: nodeDir,
    env: childEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  return { ok: r.status === 0, status: r.status, out };
}

// ---------- BOM 清洗：dsh 清单核对不剥 BOM，带 BOM 的包会让 reconcile 崩溃 ----------
function stripBom(buf) {
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
}
// 临时文件 + 重命名写入，避免原地写沿硬链接污染 pnpm store
function writeClean(pj, buf) {
  const tmp = pj + '.bomfix-tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, pj);
}
// 安装 postinstall 钩子（pnpm 物化之后、dsh reconcile 之前自动清洗 BOM）
function ensureHook() {
  const hooksDir = path.join(PROFILE, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'hook-strip-bom.cjs'), path.join(hooksDir, 'strip-bom.cjs'));
  const manifestPath = path.join(PROFILE, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (pkg.scripts?.postinstall !== 'node hooks/strip-bom.cjs') {
    pkg.scripts = { ...pkg.scripts, postinstall: 'node hooks/strip-bom.cjs' };
    fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
    log('已接入 postinstall BOM 清洗钩子');
  }
}
function sanitizeBom() {
  const nm = path.join(PROFILE, 'node_modules');
  let cleaned = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === '.pnpm' || e.name === '.bin' || e.name === '.store') continue;
      if (e.name.startsWith('@')) { walk(p, depth + 1); continue; }
      const pj = path.join(p, 'package.json');
      try {
        const raw = fs.readFileSync(pj);
        const fixed = stripBom(raw);
        if (fixed !== raw) { writeClean(pj, fixed); cleaned++; log(`  BOM 清洗: ${path.relative(PROFILE, pj)}`); }
      } catch { continue; }
      walk(p, depth + 1);
    }
  };
  if (fs.existsSync(nm)) walk(nm, 0);
  // profile 自身清单也一并清洗
  const manifest = path.join(PROFILE, 'package.json');
  try {
    const raw = fs.readFileSync(manifest);
    const fixed = stripBom(raw);
    if (fixed !== raw) { writeClean(manifest, fixed); cleaned++; }
  } catch { /* ignore */ }
  return cleaned;
}

// ---------- allowBuilds：git 托管包的 prepare 脚本需要白名单 ----------
function allowBuildsRetry(out) {
  const m = out.match(/^allowBuilds:\s*$\n^\s+(.+?): true\s*$/m);
  if (!m) return false;
  const key = m[1];
  const wsPath = path.join(PROFILE, 'pnpm-workspace.yaml');
  let text = fs.readFileSync(wsPath, 'utf8');
  if (!/^allowBuilds:/m.test(text)) text += '\nallowBuilds:\n';
  if (!text.endsWith('\n')) text += '\n';
  text += `  ${key}: true\n`;
  fs.writeFileSync(wsPath, text);
  log(`  已写入 allowBuilds: ${key}`);
  return true;
}

function profileDeps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
  return pkg.dependencies || {};
}

// bundle 清单自愈：孤儿 bundle（依赖已被移除）会让 dsh 启动直接崩溃。
// 规则：保留 in-box bundle（@deepseek-ai/*），其余 bundle 必须仍存在于依赖中。
function sanitizeBundles() {
  const manifestPath = path.join(PROFILE, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bundles = pkg.dsh?.profile?.bundles;
  const deps = Object.keys(pkg.dependencies || {});
  if (!Array.isArray(bundles)) return;
  const kept = bundles.filter((b) => b.startsWith('@deepseek-ai/') || deps.includes(b));
  if (kept.length !== bundles.length) {
    const dropped = bundles.filter((b) => !kept.includes(b));
    pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh.profile, bundles: kept } };
    fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
    log(`  bundle 清单自愈：移除孤儿层 ${dropped.join(', ')}`);
  }
}

// 差集找出本次 add 真正新增的依赖名（fallback spec 的包名可能与插件名不同）
function addedDeps(before) {
  const now = profileDeps();
  return Object.keys(now).filter((k) => !(k in before));
}

function removePlugin(depName) {
  const r = dshCli(['plugin', '--profile', 'web', 'remove', depName], 300000);
  sanitizeBom();
  sanitizeBundles();
  log(`  remove ${depName}: ${r.ok ? '✓' : '✗'}${r.ok ? '' : '\n' + r.out.slice(-600)}`);
  return r.ok;
}

async function smoke(label) {
  const r = await bootWeb({ dshHome: DSH_HOME, workspace: SMOKE_WS, timeoutMs: 120000 });
  if (!r.ok) {
    log(`  [${label}] 冒烟失败: ${r.error}`);
    if (r.output) log('  引擎输出末尾:\n' + r.output.split('\n').slice(-30).join('\n'));
  }
  return r.ok;
}

// 安装 dsh-tui 垫片（独立 CLI，经 DSH_URL 连接运行中的 host）
function ensureTuiShim() {
  const binDir = path.join(RUNTIME, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'dsh-tui.cmd'),
    `@echo off\r\n` +
    `rem dsh-tui 垫片（构建期生成，勿手改）：连接运行中的 dsh web 全屏终端 UI\r\n` +
    `if not defined DSH_URL set "DSH_URL=http://127.0.0.1:3080"\r\n` +
    `if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"\r\n` +
    `"%~dp0..\\node\\node.exe" "%DSH_HOME%\\profiles\\web\\node_modules\\dsh-tui\\bin\\tui.js" %*\r\n`
  );
}

// 把激活配置行合并进 profile cordis.patch.yml（幂等）
function ensureActivationRows() {
  const patchPath = path.join(PROFILE, 'cordis.patch.yml');
  let text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '[]\n';
  const missing = ACTIVATION_ROWS.filter((r) => !new RegExp(`id:\\s*${r.id}\\b`).test(text));
  if (!missing.length) return;
  if (/^- insert:/m.test(text)) {
    // 追加到既有 insert 列表尾部（保持两空格缩进）
    const lines = text.split(/\r?\n/);
    let last = -1;
    lines.forEach((l, i) => { if (/^ {4}- id:/.test(l)) last = i; });
    for (const r of missing) lines.splice(++last, 0, `    - id: ${r.id}`, `      name: '${r.name}'`);
    text = lines.join('\n');
  } else {
    text = text.replace(/\[\s*\]\s*/, '').replace(/\s*$/, '');
    text += (text ? '\n' : '') + '- insert:\n' +
      missing.map((r) => `    - id: ${r.id}\n      name: '${r.name}'`).join('\n') + '\n';
  }
  fs.writeFileSync(patchPath, text);
  log(`已写入激活配置行: ${missing.map((r) => r.id).join(', ')}`);
}

async function main() {
  const { dshBin } = loadEngine();
  log(`DSH CLI: ${dshBin}`);
  log(`DSH_HOME: ${DSH_HOME}`);

  ensureHook();
  sanitizeBom(); // 清洗上一轮残留
  sanitizeBundles(); // 清理孤儿 bundle 层
  ensureTuiShim();

  const report = [];
  for (const plugin of PLUGINS) {
    log(`\n=== ${plugin.name} — ${plugin.note} ===`);
    const depsBefore = profileDeps();
    let installed = null; // { spec, depNames }
    let lastOut = '';

    for (const spec of plugin.specs) {
      log(`  add ${spec} …`);
      let r = dshCli(['plugin', '--profile', 'web', 'add', spec]);
      if (!r.ok && /allowBuilds/.test(r.out)) {
        log('  需要 allowBuilds 白名单，自动写入后重试…');
        if (allowBuildsRetry(r.out)) r = dshCli(['plugin', '--profile', 'web', 'add', spec]);
      }
      lastOut = r.out;
      if (r.ok) {
        sanitizeBom();
        sanitizeBundles();
        const names = addedDeps(depsBefore);
        installed = { spec, depNames: names.length ? names : [plugin.name] };
        log(`  ✓ 已安装（依赖: ${installed.depNames.join(', ') || '无新增'}）`);
        break;
      } else {
        log(`  ✗ add 失败（退出码 ${r.status}）`);
        log(r.out.split('\n').slice(-6).join('\n').replace(/^/gm, '    | '));
      }
    }

    if (!installed) {
      report.push({ name: plugin.name, note: plugin.note, status: 'failed', detail: '所有安装源均失败', tail: lastOut.slice(-1000) });
      continue;
    }

    log('  启动冒烟测试…');
    const ok = await smoke(plugin.name);
    if (ok) {
      report.push({ name: plugin.name, note: plugin.note, spec: installed.spec, status: 'installed', detail: '安装并验证通过' });
      log(`  ✓ ${plugin.name} 冒烟通过`);
    } else {
      let removed = true;
      for (const dep of installed.depNames) removed = removePlugin(dep) && removed;
      if (removed) await smoke(plugin.name + ' (rollback)'); // 回滚后确认可启动
      report.push({
        name: plugin.name,
        note: plugin.note,
        spec: installed.spec,
        status: plugin.conditional ? 'skipped-conflict' : 'failed',
        detail: plugin.conditional
          ? '与其他插件存在冲突，按预设跳过并已回滚'
          : (removed ? '安装后破坏启动，已回滚' : '安装后破坏启动，回滚失败需手工处理'),
      });
    }
  }

  // ---------- 激活配置行插件 + 最终全量冒烟 ----------
  ensureActivationRows();
  log('\n=== 最终全量冒烟（含配置行插件） ===');
  const finalOk = await smoke('final');

  // ---------- 汇总 ----------
  const summaryPath = path.join(VENDOR, 'plugin-report.json');
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), profile: 'web', finalSmoke: finalOk ? 'pass' : 'fail', plugins: report }, null, 2));
  log('\n================ 插件安装报告 ================');
  for (const r of report) {
    const icon = r.status === 'installed' ? '✓' : r.status === 'skipped-conflict' ? '⊘' : '✗';
    log(`${icon} ${r.name.padEnd(30)} ${r.status.padEnd(18)} ${r.detail}`);
  }
  log(`\n报告已写入 ${summaryPath}`);
  const failed = report.filter((r) => r.status === 'failed').length;
  process.exit(failed > 0 || !finalOk ? 2 : 0);
}

main().catch((e) => {
  console.error('[plugins] 失败:', e.stack || e.message);
  process.exit(1);
});
