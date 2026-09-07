'use strict';
// DSH Desktop 桌面端主进程：
// 数据目录初始化 → 欢迎引导（API Key/工作区）→ 启动内置引擎（dsh web）→ 加载 Web UI。
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

app.setName('DSH Desktop');

// ---------- 路径 ----------
const APP_ROOT = path.join(__dirname, '..');
const DATA = app.getPath('userData');
// 打包版：vendor.zip 首次运行自解压到 %APPDATA%；开发版：直接用项目 vendor/
const VENDOR = app.isPackaged ? DATA : path.join(APP_ROOT, 'vendor');
const RUNTIME = app.isPackaged ? path.join(DATA, 'runtime') : path.join(VENDOR, 'runtime');
const VENDOR_ZIP = app.isPackaged ? path.join(process.resourcesPath, 'vendor.zip') : null;
const DSH_HOME = path.join(DATA, 'dsh-home');
const ICON_PNG = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'resources', 'icon.png')
  : path.join(APP_ROOT, 'resources', 'icon.png');
const LOGS_DIR = path.join(DATA, 'logs');
const SETTINGS_FILE = path.join(DATA, 'settings.json');

const ENGINE_BOOT_TIMEOUT = 150000;

// ---------- 全局状态 ----------
let engine = null; // 引擎子进程（启动器 cmd）
let enginePort = 0;
let engineUrl = null; // 引擎输出的带令牌访问地址（如 ?token=...）
let engineReady = false;
let quitting = false;
let starting = false;
let ringLog = ''; // 引擎输出环形缓冲（错误页展示用）
let logStream = null;
let logFile = '';
let mainWindow = null;
let splashWin = null;
let welcomeWin = null;
let errorWin = null;
let tray = null;
let lastErrorDetail = '';

function log(m) { console.log(`[dsh-desktop] ${new Date().toISOString()} ${m}`); }
function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

// ---------- 引擎清单（路径必须位于 vendor/runtime 内） ----------
function loadEngine() {
  const engineJson = path.join(RUNTIME, 'engine.json');
  if (!exists(engineJson)) throw new Error('引擎清单缺失（engine.json）');
  const engine = JSON.parse(fs.readFileSync(engineJson, 'utf8'));
  const runtimeAbs = path.resolve(RUNTIME) + path.sep;
  const inside = (rel, what) => {
    const abs = path.resolve(RUNTIME, rel);
    if (!abs.startsWith(runtimeAbs)) throw new Error(`引擎清单中${what}路径非法`);
    if (!exists(abs)) throw new Error(`${what}缺失: ${rel}`);
    return abs;
  };
  return {
    launcher: inside(engine.launcher || 'bin\\dsh-web.cmd', '启动器'),
    nodeExe: inside(engine.node.exe, 'node.exe'),
    dshBin: inside(engine.dsh.bin, 'dsh 入口'),
    engine,
  };
}

// ---------- 端口 / HTTP ----------
function findFreePort(start = 3080) {
  return new Promise((resolve, reject) => {
    let port = start;
    let tries = 50;
    const attempt = () => {
      if (tries-- <= 0) return reject(new Error('未找到可用端口（3080-3130 均被占用）'));
      const srv = net.createServer();
      srv.once('error', () => { port += 1; attempt(); });
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
    };
    attempt();
  });
}

function httpOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// ---------- 设置 / 凭据 ----------
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  fs.mkdirSync(DATA, { recursive: true });
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}
function defaultWorkspace() {
  return path.join(app.getPath('home'), 'DeepSeek-Workspace');
}
function envFile() { return path.join(DSH_HOME, '.env'); }
function readApiKey() {
  try {
    const text = fs.readFileSync(envFile(), 'utf8');
    const m = text.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)\s*$/m);
    return m && m[1].trim() ? m[1].trim() : '';
  } catch { return ''; }
}
function writeApiKey(key) {
  const lines = exists(envFile()) ? fs.readFileSync(envFile(), 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => /^DEEPSEEK_API_KEY\s*=/.test(l));
  if (key) {
    if (idx >= 0) lines[idx] = `DEEPSEEK_API_KEY=${key}`;
    else lines.push(`DEEPSEEK_API_KEY=${key}`);
  } else if (idx >= 0) lines.splice(idx, 1);
  fs.writeFileSync(envFile(), lines.filter((l, i, a) => l !== '' || i === a.length - 1).join('\n') + '\n');
}

// ---------- 数据目录 ----------
// 打包版首次运行：把 resources/vendor.zip（runtime + dsh-home + plugin-report）
// 解压到 %APPDATA%（zip 内无符号链接；dsh 每次启动会按本机位置重建共享链接）。
// 开发版直接使用项目 vendor/，无需解压。
async function ensureVendorData() {
  if (!app.isPackaged) return;
  if (exists(path.join(RUNTIME, 'engine.json')) && exists(path.join(DSH_HOME, 'profiles', 'web'))) return;

  setStatus('首次初始化数据目录（解压运行时，约 1-3 分钟，仅此一次）…');
  // 清理可能存在的不完整解压
  if (exists(path.join(DATA, 'runtime'))) {
    log('清理不完整的 runtime…');
    fs.rmSync(path.join(DATA, 'runtime'), { recursive: true, force: true });
  }
  if (exists(DSH_HOME)) {
    log('清理不完整的 dsh-home…');
    fs.rmSync(DSH_HOME, { recursive: true, force: true });
  }
  if (!exists(VENDOR_ZIP)) throw new Error('vendor.zip 缺失，安装包不完整');

  log('解压 vendor.zip → ' + DATA);
  await new Promise((resolve, reject) => {
    // .NET ExtractToDirectory：与打包端（ZipFile）同族，反斜杠条目名兼容
    const p = spawn('powershell', [
      '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
      `[IO.Compression.ZipFile]::ExtractToDirectory('${VENDOR_ZIP.replace(/'/g, "''")}', '${DATA.replace(/'/g, "''")}')`,
    ], { windowsHide: true });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（powershell exit=${code}）`))));
    p.on('error', (e) => reject(new Error('解压进程启动失败: ' + e.message)));
  });
  if (!exists(path.join(RUNTIME, 'engine.json'))) throw new Error('解压后 engine.json 缺失');
  log('数据目录初始化完成');
}

// ---------- 日志 ----------
function rotateLogs() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter((f) => /^engine-.*\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(10)) fs.rmSync(path.join(LOGS_DIR, f), { force: true });
  } catch { /* 忽略清理失败 */ }
}
function openLogStream() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  rotateLogs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  logFile = path.join(LOGS_DIR, `engine-${stamp}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
}
function appendEngineOutput(chunk) {
  const text = chunk.toString('utf8');
  ringLog = (ringLog + text).slice(-8000);
  if (logStream) logStream.write(text);
  // 捕获带令牌的访问地址（dsh web 可能输出 http://127.0.0.1:PORT/?token=...）
  const m = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
  if (m) engineUrl = m[0];
}

// ---------- 窗口 ----------
function setStatus(text) {
  log(text);
  if (splashWin && !splashWin.isDestroyed()) splashWin.webContents.send('splash:status', text);
}

function showSplash() {
  if (splashWin) { splashWin.show(); return; }
  splashWin = new BrowserWindow({
    width: 380, height: 440, frame: false, resizable: false, movable: true,
    show: false, backgroundColor: '#0d1428', alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.once('ready-to-show', () => splashWin.show());
}

function closeSplash() {
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  splashWin = null;
}

const WINDOW_ICON = () => {
  const img = nativeImage.createFromPath(ICON_PNG);
  return img.isEmpty() ? undefined : img;
};

function showMain(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (url) mainWindow.loadURL(url);
    mainWindow.show();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1360, height: 900, minWidth: 980, minHeight: 640,
    show: false, backgroundColor: '#0d1428',
    title: 'DSH Desktop', autoHideMenuBar: true,
    icon: WINDOW_ICON(),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.setMenu(null);
  // 窗口标题固定为 DSH Desktop（Web UI 页面自带 <title>，不跟随）
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!/^https?:\/\/127\.0\.0\.1(:\d+)?/.test(target)) { e.preventDefault(); shell.openExternal(target); }
  });
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (url) mainWindow.loadURL(url);
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function showWelcome() {
  return new Promise((resolve) => {
    welcomeWin = new BrowserWindow({
      width: 640, height: 760, resizable: false, show: false,
      backgroundColor: '#0d1428', title: '欢迎使用 DSH Desktop',
      icon: WINDOW_ICON(),
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    welcomeWin.setMenu(null);
    welcomeWin.loadFile(path.join(__dirname, 'welcome.html'));
    welcomeWin.once('ready-to-show', () => welcomeWin.show());
    welcomeWin.on('closed', () => { welcomeWin = null; resolve(); });
  });
}

function showError(detail) {
  lastErrorDetail = detail || '';
  if (errorWin && !errorWin.isDestroyed()) { errorWin.focus(); return; }
  closeSplash();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  errorWin = new BrowserWindow({
    width: 700, height: 560, resizable: true, show: false,
    backgroundColor: '#0d1428', title: 'DSH Desktop · 引擎异常',
    icon: WINDOW_ICON(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  errorWin.setMenu(null);
  errorWin.loadFile(path.join(__dirname, 'error.html'));
  errorWin.once('ready-to-show', () => errorWin.show());
  errorWin.on('closed', () => { errorWin = null; });
}

// ---------- 引擎 ----------
function engineEnv(port, workspace) {
  const binDir = path.join(RUNTIME, 'bin');
  const nodeDir = path.dirname(loadEngine().nodeExe);
  return {
    ...process.env,
    DSH_HOME,
    DSH_WORKSPACE: workspace,
    DSH_PORT: String(port),
    PATH: `${binDir};${nodeDir};${process.env.PATH || ''}`,
  };
}

// dsh 每次启动都会把自有依赖链接到 $DSH_HOME/profiles/node_modules（链接修复），
// 但该步骤对已存在的链接不幂等（EISDIR），跨重启会崩——启动前清空让它重建。
function cleanProfileLinkDir() {
  const linkDir = path.join(DSH_HOME, 'profiles', 'node_modules');
  if (exists(linkDir)) {
    fs.rmSync(linkDir, { recursive: true, force: true });
    log('已清理 profile 链接目录（由引擎启动时重建）');
  }
}

async function startEngine() {
  if (starting || engine) return;
  starting = true;
  engineReady = false;
  ringLog = '';
  engineUrl = null;
  try {
    cleanProfileLinkDir();
    const settings = loadSettings();
    const workspace = settings.workspace || defaultWorkspace();
    const port = await findFreePort(3080);
    openLogStream();

    setStatus(`正在启动引擎（端口 ${port}）…`);
    // 以字面量相对路径 + cwd=runtime 调用启动器；启动器内部 cd 到工作区并按相对路径启动 node
    const child = spawn('.\\bin\\dsh-web.cmd', [], {
      cwd: RUNTIME,
      env: engineEnv(port, workspace),
      windowsHide: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    engine = child;
    enginePort = port;

    child.stdout.on('data', appendEngineOutput);
    child.stderr.on('data', appendEngineOutput);
    child.on('exit', (code) => {
      log(`引擎进程退出（code=${code}）`);
      if (logStream) { logStream.end(`\n[引擎退出 code=${code}]\n`); logStream = null; }
      const wasReady = engineReady;
      engine = null;
      engineReady = false;
      if (quitting || starting) return; // 启动失败路径由 startEngine 自行处理
      if (wasReady) showError('引擎进程意外退出。');
    });

    // 等待 HTTP 就绪
    const deadline = Date.now() + ENGINE_BOOT_TIMEOUT;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || !engine) throw new Error('引擎进程在启动阶段退出，请查看日志。');
      if (await httpOk(port)) {
        // 引擎可能在监听后才打印令牌地址，稍等捕获
        for (let w = 0; w < 10 && !engineUrl; w++) await new Promise((r) => setTimeout(r, 500));
        engineReady = true;
        starting = false;
        log(`引擎就绪: http://127.0.0.1:${port}${engineUrl ? '（带令牌地址已捕获）' : ''}`);
        return { port, url: engineUrl || `http://127.0.0.1:${port}`, workspace };
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error('引擎启动超时，请查看日志。');
  } catch (e) {
    starting = false;
    stopEngine();
    throw e;
  }
}

function stopEngine() {
  const child = engine;
  engine = null;
  engineReady = false;
  if (!child) return;
  const pid = child.pid;
  if (!pid) return;
  // 同步强杀进程树：应用退出路径上定时器不可靠，温和关闭会留下孤儿引擎
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

// ---------- 托盘 ----------
function showTray() {
  if (tray) return;
  const icon = WINDOW_ICON();
  if (!icon || icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('DSH Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '重启引擎', click: () => restartEngine() },
    { label: 'TUI 终端（dsh-tui）', click: () => openTui() },
    { type: 'separator' },
    { label: '打开工作区', click: () => shell.openPath(loadSettings().workspace || defaultWorkspace()) },
    { label: '打开数据目录', click: () => shell.openPath(DATA) },
    { label: '打开日志目录', click: () => shell.openPath(LOGS_DIR) },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit() },
  ]));
}

// 在独立控制台窗口里打开 dsh-tui（连接当前引擎端口）
function openTui() {
  if (!enginePort) return;
  const binDir = path.join(RUNTIME, 'bin');
  const workspace = loadSettings().workspace || defaultWorkspace();
  fs.mkdirSync(workspace, { recursive: true });
  spawn('.\\bin\\dsh-tui.cmd', [], {
    cwd: RUNTIME,
    env: { ...process.env, DSH_HOME, DSH_URL: `http://127.0.0.1:${enginePort}`, PATH: `${binDir};${process.env.PATH || ''}` },
    shell: true,
    windowsHide: false,
    stdio: 'ignore',
  });
}

async function restartEngine() {
  log('重启引擎…');
  stopEngine();
  closeSplash();
  showSplash();
  try {
    setStatus('正在重启引擎…');
    const { port, url } = await startEngine();
    closeSplash();
    showMain(url);
  } catch (e) {
    showError(e.message);
  }
}

function requestQuit() {
  quitting = true;
  stopEngine();
  app.quit();
}

// ---------- 启动编排 ----------
async function boot() {
  showSplash();
  await ensureVendorData();

  const smokeMode = process.env.DSH_SMOKE === '1';
  const settings = loadSettings();
  if (!smokeMode && !readApiKey() && !settings.skippedKey) {
    setStatus('等待首次配置…');
    await showWelcome(); // 提交/跳过后窗口关闭，设置已落盘
  }

  setStatus('正在启动引擎…');
  const { port, url } = await startEngine();
  closeSplash();
  showMain(url);
  showTray();

  if (smokeMode) {
    log('DSH_SMOKE_OK port=' + port);
    try { fs.writeFileSync(path.join(DATA, 'smoke-result.txt'), `OK port=${port}\n`); } catch { /* ignore */ }
    setTimeout(() => requestQuit(), 1500);
  }
}

// ---------- IPC ----------
ipcMain.handle('welcome:init', () => ({
  workspace: loadSettings().workspace || defaultWorkspace(),
  envPath: envFile(),
}));
ipcMain.handle('welcome:browse', async () => {
  const r = await dialog.showOpenDialog(welcomeWin, {
    title: '选择工作区目录',
    defaultPath: loadSettings().workspace || defaultWorkspace(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('welcome:submit', (_e, data) => {
  try {
    saveSettings({ workspace: data.workspace, skippedKey: !!data.skipKey });
    if (!data.skipKey) writeApiKey(String(data.apiKey || '').trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('error:init', () => ({ detail: lastErrorDetail, logTail: ringLog }));
ipcMain.handle('error:restart', () => {
  if (errorWin && !errorWin.isDestroyed()) errorWin.close();
  restartEngine();
});
ipcMain.handle('error:open-logs', () => shell.openPath(LOGS_DIR));

// ---------- 生命周期 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    boot().catch((e) => {
      log('启动失败: ' + e.message);
      if (process.env.DSH_SMOKE === '1') {
        console.error('DSH_SMOKE_FAIL ' + e.message);
        try { fs.writeFileSync(path.join(DATA, 'smoke-result.txt'), `FAIL ${e.message}\n`); } catch { /* ignore */ }
        app.exit(1);
        return;
      }
      showError(e.message);
    });
  });

  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });

  app.on('before-quit', () => {
    quitting = true;
    stopEngine();
  });
}
