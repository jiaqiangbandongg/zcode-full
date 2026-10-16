# ZCode Agent 用「已有 Node + 编译产物 zcode.cjs」运行（桌面 & 远端）

## 核心思路

ZCode Agent 以前每个平台都内置一份独立的原生二进制 `zcode-agent`（SEA：官方 Node + `zcode.cjs` + TUI 资源 + 官方插件），单平台 ~180MB，里面**自带一份 Node**。

但无论桌面还是远端，运行 agent 的环境里**本来就已经有一份 Node**：

- **桌面**：Host 跑在 Electron `utilityProcess`，`process.execPath` 指向 Electron Helper，内置 Node 24.x（Electron 41）。
- **远端 SSH/WSL/Docker**：部署时会下发一份独立 `node`（`<REMOTE_BASE>/node`，v22.16.0）用来跑 `zcode-server.cjs`。

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

**远端**（无 Electron，复用 dev 已有机制）：部署 `zcode.cjs` 到 `~/.zcode/server/agents/glm/zcode.cjs`，再写一个**同名 wrapper**（就是 resolver 期望的可执行入口 `zcode-agent`）：

```sh
#!/bin/sh
set -eu
runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}"
exec "$runtime_root/node" "$HOME/.zcode/server/agents/glm/zcode.cjs" "$@"
```

这样 provider runtime resolver **不需要为远端改任何代码**——照旧找 `zcode-agent` 这个可执行文件，找到的是 wrapper，由它用远端 node 执行 `zcode.cjs`。

## 实现

**bundle 目标版本**（`apps/zcode-cli/packages/cli/scripts/build.mjs`）
esbuild `target` 从 `node26` 降到 **`node22`**，取两端运行时里最低的 Node 版本（远端 v22.16）。保证同一份 `zcode.cjs` 在桌面 Node 24 和远端 Node 22 上都不会用到目标运行时不支持的语法。

**桌面**
- `zcode-agent-runtime.ts`：描述符加 `nodeBundleEntryFile: "zcode.cjs"` + `resolveNodeBundleSegments()`。
- `providerRuntimeResolver.ts`：`findZCodeAgentRuntimeNodeBundle()` 定位 `resources/glm/zcode.cjs`。
- `zcodeAgentProcessManager.ts`：`resolveElectronRuntimeZCodeAgentCommand`，插在 monorepo dev 与 native-binary 兜底之间。
- 打包：`prepare:agent-bundle`（`prepare-agent-node-bundle.mjs`）构建 cli、把 `zcode.cjs` stage 进 `bundled-agents/<平台>/glm/`、删掉旧原生 `zcode-agent`；`prepare:runtime-assets` 本机列表用它替换 `prepare:glm`；electron-builder 整目录拷 `resources/glm`。

**远端**
- `zcodeAgentBundleWrapper.ts`（新）：`REMOTE_AGENT_BUNDLE_NAME` + `buildRemoteAgentBundleWrapper()`，dev / 生产共用一份 wrapper 语义。
- `zcodeAgentDeploy.ts`：去掉「只支持 native binary」的限制；改为 ① `installFile` 安装 `zcode.cjs` 到 `agents/glm/zcode.cjs`，② 写 wrapper 到 `agents/glm/zcode-agent`。skip 检查同时校验 wrapper 与 bundle 存在。
- 生产态 `glm/zcode.cjs` 始终跟随 ZCode app/server 版本：主 `zcode-server.cjs` 因 app 版本变化进入部署路径时强制刷新 `glm`；本地上传模式必须从当前 app release 取文件覆盖，远端下载模式必须按当前 manifest 的组件内容刷新远端 cache 后再覆盖，避免同一语义 runtime 版本但内容 hash 不同的旧 `zcode.cjs` 被重复安装。app 版本未变化时不再单独判断或补传 `glm`。
- `zcodeAgentDevDeploy.ts`：复用上面的共享 wrapper（删掉本地副本）。
- mock-cdn（`prepare-prebuilds.mjs`）：`stageRemoteAgentBundles()` 构建 cli 后把 `zcode.cjs` 放进各平台 `releases/<ver>/glm/<platform>/`，替代原来逐平台下载原生二进制；glm 组件复用 required-paths 改为 `["zcode.cjs"]`。组件 tar.gz / manifest / sha 机制不变，只是包里的文件从二进制换成 JS。

resolver 在远端**无需改动**：wrapper 名仍是 `zcode-agent`，由 `findZCodeAgentRuntimeBinary` 命中。

## 验证

- `tsc -b packages/rpc packages/shared packages/services packages/server` 通过；`oxlint` 改动文件 0/0。
- cli 以 `target node22` 重新构建成功（dist/zcode.cjs 15.7MB）。
- 冒烟：`node dist/zcode.cjs app-server --stdio` 在纯 Node 下正常启动并维持 stdio 服务（stdin EOF 时干净退出 0），证明编译产物脱离 SEA、脱离 Electron 也能跑——即远端 wrapper 的运行形态。
- 待补：一次真实 SSH 远端部署 + 一次真实桌面打包的端到端会话验证（涉及 web-remote-control 部署链路，本地无法连真实远端/CDN 验证）。

## 备注

`scripts/download-glm.mjs`（下载原生二进制）与 desktop `prepare:glm` 脚本不再进入默认链路，保留作为手动兜底，未删除。
