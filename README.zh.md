# DSH Desktop

**DSH Desktop** 是为 DeepSeek Harness（`dsh`）打造的**社区**桌面端（非官方）：Windows 一键安装，**内置 Node.js 运行时，用户机器零依赖**，预装 11 个社区插件。

> 命名与图标遵循 DeepSeek Harness 官方 [品牌使用规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md)：项目名使用生态推荐的 **DSH** 缩写，图标为原创 "DSH_" 字标（DeepSeek 品牌蓝 #4D6BFE），不使用官方 logo，与官方无隶属关系。

```
┌─ Electron 窗口 ──── 加载 http://127.0.0.1:<port>（DSH Web UI）
│    · dsh-worktable：侧边栏抽屉 + 可停靠分屏 + 控制室看板
│    · @dsh-market/plugin：侧边栏插件市场（可继续在线装插件）
│    · dsh-context / modlens / agent-teams 等面板
├─ Electron 主进程 ── 生命周期 / 托盘 / 首启引导 / 日志
│    └─ 子进程：vendor/runtime/bin/dsh-web.cmd（构建期生成的启动器）
└─ 内置引擎 ───────── 便携 Node 22 LTS + @deepseek-ai/dsh + pnpm（垫片注入 PATH）
     └─ 数据目录 %APPDATA%\DSH Desktop\dsh-home（首启自解压 vendor.zip）
```

## 使用

1. 双击 `dist/DSH Desktop Setup 1.0.0.exe` 安装（默认装到用户目录，无需管理员权限）
2. 首次启动：粘贴 DeepSeek API Key（可在 [platform.deepseek.com](https://platform.deepseek.com/) 获取），选择工作区目录
3. 完成 —— Web UI 出现后即可使用；关闭窗口最小化到托盘，托盘菜单可重启引擎 / 打开 TUI 终端 / 打开日志 / 退出

数据全部保存在本机：`%APPDATA%\DSH Desktop\`（数据目录）与所选择的工作区。

## 应用图标

`resources/icon.ico`（16-256 多尺寸）与 `icon.png`（256）由 `scripts/make-icon.js` 纯 Node 生成，无需任何图像库依赖：

- 原创 "DSH_" 圆头字标（SDF 绘制：线段/圆弧/圆角矩形 + 解析式抗锯齿），基线下划线呼应终端光标；
- 底板为 DeepSeek 品牌蓝 #4D6BFE 对角渐变圆角方形；
- 16/24/32 小尺寸层自动切换为终端箭头 motif（全字标在小尺寸不可读）。

## 预装插件

| 插件 | 说明 |
| --- | --- |
| dsh-worktable 0.3.0 | 项目工作台：侧边栏抽屉 + 可停靠分屏 + 控制室看板（GitHub Release tarball 安装） |
| dsh-memory-plugin | 跨会话长期记忆增强（`memory_*` 工具，配置行激活） |
| @dsh-market/plugin | 侧边栏插件市场 |
| @liustack/modlens | 视觉桥接 |
| @liustack/modsearch | 免 key 联网搜索 |
| @nanmicoder/dsh-agent-teams | 多智能体团队协作 |
| dsh-context | 上下文统计面板 |
| dsh-pocket | 手机扫码访问（自动在局域网暴露带 PIN 保护的访问入口） |
| dsh-tui | 全屏终端 UI（独立 CLI，托盘「TUI 终端」入口，经 `DSH_URL` 连接引擎） |
| archify | 仓库架构图生成（已安装，默认未启用——与 dsh 0.1.2-rc.1 存在兼容性问题） |
| aegis | 软件工程方法论（已安装，默认未启用——同上） |

> 兼容性说明：在 Win11 虚拟机实测中，`agent-teams`/`archify`/`aegis` 三个插件与内置 dsh 0.1.2-rc.1 存在 API 兼容问题（会导致引擎启动失败），故默认安装但不激活。它们仍留在插件目录中，可在 Web UI 插件市场或配置中按需启用。真实使用反馈欢迎提 issue。

实际安装结果以 `vendor/plugin-report.json` 为准（构建产物）。

## 从源码构建

构建机需求：Node.js ≥ 20（自带 npm 即可，无需全局 pnpm —— 引擎内置）、Windows 10+。

```sh
npm install             # electron + electron-builder
npm run prepare:engine  # 下载便携 Node 22 LTS + 安装 @deepseek-ai/dsh + pnpm + PATH 垫片
npm run prepare:plugins # 预装 11 个插件到 web profile（逐个冒烟验证）
npm run prepare:icon    # 生成 resources/icon.ico + icon.png（原创 DSH 字标）
npm run dist            # 打 vendor.zip + electron-builder 出 NSIS 一键安装包 → dist/
```

产物约 193 MB；应用首次启动时把 `vendor.zip` 自解压到 `%APPDATA%\DSH Desktop\`（约 2-4 分钟，仅一次），此后每次启动约 8 秒。

端到端验证（无界面启动，引擎就绪后自动退出）：

```sh
node scripts/smoke-engine.js                   # 仅验证引擎
DSH_SMOKE=1 dist/win-unpacked/"DSH Desktop.exe"  # 验证完整桌面链路
```

## 工程说明

- **运行时完全自包含**：用户机器不需要 Node.js / pnpm。`vendor/runtime/` 内含便携 Node 22 LTS（Jod LTS）、`@deepseek-ai/dsh` 完整安装、pnpm、以及 `bin/` 下的 `dsh.cmd` / `pnpm.cmd` / `dsh-web.cmd` 垫片——桌面端里用插件市场在线装插件时用的也是内置运行时。
- **启动器模式**：`dsh-web.cmd` 在构建期生成，内部先 `cd` 到工作区（DSH 以进程 cwd 作为 workspace 根），再用相对路径启动 node，路径全部自包含，不依赖安装位置。
- **profile 即拷即用**：dsh 的 profile 使用 pnpm `node-linker: hoisted`（真实目录、无符号链接），整棵 `dsh-home` 可直接复制打包；首次启动复制到 `%APPDATA%`，此后用户在插件市场里的安装都能持久化。
- **引擎生命周期**：应用退出/重启引擎时对引擎进程树**同步强杀**（`taskkill /T /F`）——温和关闭加延时补杀的方案在应用退出路径上会因定时器销毁而留下孤儿引擎（占用端口，导致下次启动绑定错乱）。
- **已知上游兼容处理**（`scripts/prepare-plugins.js` / `scripts/pack-vendor.js`）：
  - 部分社区包以带 BOM 的 `package.json` 发布，dsh 清单核对不剥 BOM 会崩溃 —— profile 内置 `postinstall` 钩子自动清洗（pnpm 物化之后、dsh 清单核对之前），桌面端里在线装插件同样受保护；
  - git 托管插件需要 pnpm `allowBuilds` 白名单 —— 按提示键自动写入 profile 的 `pnpm-workspace.yaml` 并重试；
  - dsh-memory-plugin / archify / aegis 为配置行型插件（无 `dsh.bundle` 声明）—— 自动写入 profile 的 `cordis.patch.yml` 激活行；
  - bundle 层自愈：孤儿 bundle（依赖被移除但层仍在）会让引擎启动崩溃，脚本自动清理；
  - dsh 每次启动的链接修复对已存在链接不幂等 —— 应用每次启动前清空 `profiles/node_modules` 让引擎重建；
  - 生成的 `.cmd` 垫片只用 ASCII（cmd.exe 按 GBK 解析含中文注释的批处理会产生垃圾命令）；
  - **分发采用单一 `vendor.zip`**：NSIS 打包深层 node_modules 时会静默丢文件（实测整个 runtime 目录消失），改为 zip 随包分发、首次运行自解压，彻底规避。
- **端口**：默认从 3080 起自动探测空闲端口，多实例/端口冲突无感。

## 目录结构

```
DeepSeek/
├── app/                 # Electron 壳（main.js / splash / welcome / error / preload）
├── scripts/
│   ├── make-icon.js     # 纯 Node 绘制原创 DSH 字标图标（SDF → PNG 编码 → ICO 封装）
│   ├── prepare-engine.js# 便携 Node + dsh + pnpm + 垫片 + engine.json
│   ├── prepare-plugins.js# 插件预装 + BOM/allowBuilds 兼容处理 + 逐个冒烟
│   ├── pack-vendor.js   # vendor → vendor.zip 单文件分发（跳过符号链接）
│   └── smoke-engine.js  # 引擎冒烟测试（可 CLI 亦可被 require）
├── vendor/              # 构建生成：runtime/（node+dsh+pnpm）、dsh-home/（预装插件）、plugin-report.json
├── resources/           # icon.ico / icon.png（原创 DSH 字标）
└── dist/                # electron-builder 产物：Setup exe + win-unpacked/
```

## 许可

MIT。DeepSeek Harness（DSH）与各插件版权归其各自作者所有；本项目为独立社区作品，与 DeepSeek 官方无隶属关系。
