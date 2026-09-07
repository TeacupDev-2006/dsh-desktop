#!/usr/bin/env node
// 引擎冒烟测试：通过构建期生成的启动器（bin/dsh-web.cmd）启动 dsh web 服务，
// 轮询 HTTP 直到就绪，然后结束进程树。可 CLI 运行，也可被 prepare-plugins require。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'vendor', 'runtime');

function log(m) { console.log('[smoke] ' + m); }

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// 引擎清单校验：所有关键文件必须位于 vendor/runtime 内
function loadEngine() {
  const engineJson = path.join(RUNTIME, 'engine.json');
  if (!exists(engineJson)) throw new Error('未找到 engine.json，请先运行 npm run prepare:engine');
  const engine = JSON.parse(fs.readFileSync(engineJson, 'utf8'));
  const runtimeAbs = path.resolve(RUNTIME) + path.sep;
  const resolveInside = (rel, name) => {
    const abs = path.resolve(RUNTIME, rel);
    if (!abs.startsWith(runtimeAbs)) throw new Error(`engine.json 中的${name}路径非法: ${rel}`);
    if (!exists(abs)) throw new Error(`${name} 不存在: ${abs}`);
    return abs;
  };
  const nodeExe = resolveInside(engine.node.exe, 'node.exe');
  if (path.basename(nodeExe) !== 'node.exe') throw new Error('node.exe 路径非法');
  const dshBin = resolveInside(engine.dsh.bin, 'dsh bin');
  const launcher = resolveInside(engine.launcher || path.join('bin', 'dsh-web.cmd'), 'launcher');
  return { engine, nodeExe, dshBin, launcher, runtimeAbs };
}

function findFreePort(start = 3080, tries = 50) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = (attempt) => {
      if (attempt <= 0) return reject(new Error('3080 起连续 50 个端口均被占用'));
      const srv = net.createServer();
      srv.once('error', () => tryNext(attempt - 1));
      srv.listen(port, '127.0.0.1', () => {
        const p = port;
        srv.close(() => resolve(p));
      });
      port += 1;
    };
    tryNext(tries);
  });
}

function httpOk(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function killTree(pid, force = true) {
  if (!pid) return;
  const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
  spawnSync('taskkill', args, { stdio: 'ignore' });
}

/**
 * 通过启动器启动 dsh web 并等待 HTTP 就绪。
 * 启动器内部会 cd 到 DSH_WORKSPACE（dsh 以进程 cwd 作为 workspace 根）。
 * @returns {Promise<{ok: boolean, port: number, error?: string, output: string, pid: number}>}
 */
async function bootWeb({ dshHome = path.join(ROOT, 'vendor', 'dsh-home'), workspace = path.join(ROOT, 'vendor', 'smoke-workspace'), port, timeoutMs = 90000, onOutput, autoStop = true } = {}) {
  // dshHome/workspace 会进入引擎启动环境，必须落在项目目录内（防路径逃逸）
  const rootAbs = path.resolve(ROOT) + path.sep;
  const inside = (label, value) => {
    const abs = path.resolve(value);
    if (!abs.startsWith(rootAbs)) throw new Error(`${label} 必须位于项目目录内: ${abs}`);
    return abs;
  };
  dshHome = inside('dshHome', dshHome);
  workspace = inside('workspace', workspace);
  const { launcher } = loadEngine();
  if (!exists(dshHome)) throw new Error('DSH_HOME 不存在: ' + dshHome);
  fs.mkdirSync(workspace, { recursive: true });

  // dsh 启动时的链接修复对已存在链接不幂等，启动前清空重建
  const linkDir = path.join(dshHome, 'profiles', 'node_modules');
  if (exists(linkDir)) fs.rmSync(linkDir, { recursive: true, force: true });

  const usePort = port || (await findFreePort());
  const binDir = path.join(RUNTIME, 'bin');
  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_WORKSPACE: workspace,
    DSH_PORT: String(usePort),
    DSH_TELEMETRY_MODE: 'DISABLED',
    PATH: `${binDir};${path.join(RUNTIME, 'node')};${process.env.PATH || ''}`,
  };

  // 以字面量相对路径 + cwd 调用启动器（.cmd 需要 shell）
  const child = spawn('.\\bin\\dsh-web.cmd', [], {
    cwd: RUNTIME,
    env: childEnv,
    windowsHide: true,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks = [];
  const collect = (d) => {
    chunks.push(d);
    if (onOutput) onOutput(d);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const output = () => chunks.join('').slice(-8000);

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearInterval(timer); clearTimeout(deadline); resolve(r); } };
    const timer = setInterval(async () => {
      if (await httpOk(usePort)) finish({ ok: true, port: usePort, pid: child.pid, output: output() });
    }, 600);
    const deadline = setTimeout(() => {
      finish({ ok: false, port: usePort, pid: child.pid, error: `等待 HTTP 就绪超时（${timeoutMs}ms）`, output: output() });
    }, timeoutMs);
    child.on('exit', (code) => {
      finish({ ok: false, port: usePort, pid: child.pid, error: `引擎进程提前退出（code=${code}）`, output: output() });
    });
    child.on('error', (err) => {
      finish({ ok: false, port: usePort, pid: child.pid, error: '引擎进程启动失败: ' + err.message, output: output() });
    });
  });

  if (autoStop) {
    await new Promise((r) => setTimeout(r, 300));
    killTree(result.pid, false); // 先尝试温和结束
    await new Promise((r) => setTimeout(r, 2000));
    killTree(result.pid, true); // 强制结束进程树
  }
  return result;
}

module.exports = { loadEngine, bootWeb, findFreePort, killTree, RUNTIME, ROOT };
// 独立运行：node scripts/smoke-engine.js（使用 vendor/ 内默认路径，引擎就绪后自动退出）
if (require.main === module) {
  bootWeb({ timeoutMs: 120000 })
    .then((r) => {
      if (r.ok) {
        log(`✓ web 服务在 127.0.0.1:${r.port} 正常响应`);
        process.exit(0);
      } else {
        log('✗ 失败: ' + r.error);
        log('---- 引擎输出（末尾） ----\n' + r.output);
        process.exit(1);
      }
    })
    .catch((e) => {
      log('✗ 异常: ' + e.message);
      process.exit(1);
    });
}
