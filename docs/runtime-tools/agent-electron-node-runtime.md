# ZCode Agent 用「已有 Node + 编译产物 zcode.cjs」运行（桌面 & 远端）

## 核心思路

ZCode Agent 以前每个平台都内置一份独立的原生二进制 `zcode-agent`（SEA：官方 Node + `zcode.cjs` + TUI 资源 + 官方插件），单平台 ~180MB，里面**自带一份 Node**。

但无论桌面还是远端，运行 agent 的环境里**本来就已经有一份 Node**：

- **桌面**：Host 跑在 Electron `utilityProcess`，`process.execPath` 指向 Electron Helper，内置 Node 24.x（Electron 41）。
- **远端 SSH/WSL/Docker**：Source Server archive 自带目标 Node，并用它运行 Server CLI/Core 与 `zcode.cjs`。

所以 agent 没必要再带一份 Node，直接用这份已有的 Node 执行编译产物 `zcode.cjs` 即可。

关键前提：**ZCode Agent 没有任何原生 NAPI 插件**——`ripgrep` 是 WASM/WASI，其余依赖（cheerio / iconv-lite / jimp / ai-sdk / mcp-sdk / zod 等）全是纯 JS。`zcode.cjs` 是 esbuild 打的单文件 bundle（除 `@zcode/tui` 外全部 inline），跨平台同一份；`app-server` 命令路径永不加载 `@zcode/tui`，所以远端只需要这一个文件、无需 node_modules，桌面也不打包 TUI。

收益：单平台 ~180MB → ~16MB；同一份 JS 跨平台；桌面/远端统一一种 agent 形态。

## 运行方式

**桌面**（`zcodeAgentProcessManager.ts: resolveElectronRuntimeZCodeAgentCommand`，`process.versions.electron` 为闸门）：

```
process.execPath  <Electron Helper>
  args: [resources/glm/zcode.cjs, app-server, --stdio]
  env:  { ELECTRON_RUN_AS_NODE: "1" }   // 必须，否则子进程被当成 Chromium 子进程卡在 GPU 初始化
```

**远端**：完整 archive 将 `zcode.cjs` 放入 immutable release 的 `runtime/`，Server Core 按 release manifest 创建 Workspace Agent；不再向 `~/.zcode/server/agents/glm/` 部署散文件或 wrapper。

## 实现

**bundle 目标版本**（`apps/zcode-cli/packages/cli/scripts/build.mjs`）
esbuild `target` 从 `node26` 降到 **`node22`**，取两端运行时里最低的 Node 版本（远端 v22.16）。保证同一份 `zcode.cjs` 在桌面 Node 24 和远端 Node 22 上都不会用到目标运行时不支持的语法。

**桌面**
- `zcode-agent-runtime.ts`：描述符加 `nodeBundleEntryFile: "zcode.cjs"` + `resolveNodeBundleSegments()`。
- `providerRuntimeResolver.ts`：`findZCodeAgentRuntimeNodeBundle()` 定位 `resources/glm/zcode.cjs`。
- `zcodeAgentProcessManager.ts`：`resolveElectronRuntimeZCodeAgentCommand`，插在 monorepo dev 与 native-binary 兜底之间。
- 打包：`prepare:agent-bundle`（`prepare-agent-node-bundle.mjs`）构建 cli、把 `zcode.cjs` stage 进 `bundled-agents/<平台>/glm/`、删掉旧原生 `zcode-agent`；`prepare:runtime-assets` 本机列表用它替换 `prepare:glm`；electron-builder 整目录拷 `resources/glm`。

**远端**
- `@zcode/server-cli stage:remote-assets` 为四个平台生成完整 archive；`runtime/zcode.cjs` 与 Server CLI/Core 使用同一 descriptor SHA 身份。
- Desktop 本地下载上传与 SSH 远端直下只改变 archive 获取位置，最终都进入 `zcode update --from-archive`。
- legacy `prepare-prebuilds.mjs`、component manifest 与散文件部署不再进入开发、CI 或发布链路。

## 验证

- `tsc -b packages/rpc packages/shared packages/services packages/server` 通过；`oxlint` 改动文件 0/0。
- cli 以 `target node22` 重新构建成功（dist/zcode.cjs 15.7MB）。
- 冒烟：`node dist/zcode.cjs app-server --stdio` 在纯 Node 下正常启动并维持 stdio 服务（stdin EOF 时干净退出 0），证明编译产物脱离 SEA、脱离 Electron 也能跑——即远端 wrapper 的运行形态。
- 待补：一次真实 SSH 远端部署 + 一次真实桌面打包的端到端会话验证（涉及 web-remote-control 部署链路，本地无法连真实远端/CDN 验证）。

## 备注

`scripts/download-glm.mjs`（下载原生二进制）与 desktop `prepare:glm` 脚本不再进入默认链路，保留作为手动兜底，未删除。
