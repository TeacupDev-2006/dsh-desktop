# DSH Desktop

**DSH Desktop** is a **community** (unofficial) Windows desktop app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): one-click install, **bundled Node.js runtime (zero dependencies on the user machine)**, with 11 community plugins preinstalled.

> Naming and iconography follow the upstream [brand guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md): the project uses the ecosystem-recommended **DSH** abbreviation and an original "DSH_" wordmark in DeepSeek brand blue (#4D6BFE). No official logo is used; this project is not affiliated with DeepSeek.

## Highlights

- **Fully self-contained**: portable Node 22 LTS + `@deepseek-ai/dsh` + pnpm ship inside the app — no Node.js/pnpm required on the user machine
- **One-click NSIS install** (per-user, no admin rights); first launch self-extracts the runtime from a single `vendor.zip`
- **Preinstalled plugins**: dsh-worktable, dsh-memory-plugin, @dsh-market/plugin (marketplace), @liustack/modlens, @liustack/modsearch, dsh-agent-teams, dsh-context, dsh-pocket, dsh-tui, archify, aegis
- **Tray-resident**: restart engine, open TUI terminal, open workspace/logs, quit
- **First-run wizard**: API key + workspace folder, all data kept local (`%APPDATA%\DSH Desktop\`)

## Build from source

Requires Node.js ≥ 20 on the build machine (no global pnpm needed — the engine bundles it), Windows 10+.

```sh
npm install
npm run prepare:engine   # portable Node 22 + dsh + pnpm + PATH shims + engine.json
npm run prepare:plugins  # preinstall 11 plugins into the web profile (smoke-tested one by one)
npm run prepare:icon     # generate resources/icon.ico + icon.png (original DSH wordmark, pure Node)
npm run dist             # pack vendor.zip + electron-builder NSIS installer → dist/
```

See [README.zh.md](README.zh.md) for the full Chinese documentation — engineering notes, upstream compatibility workarounds, and project layout.

## License

MIT. DeepSeek Harness (DSH) and the plugins are copyrighted by their respective authors; this project is an independent community work.
