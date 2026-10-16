# Desktop 开发构建 watcher 范围

## 背景

`pnpm dev:desktop` 在启动 Electron 前会并行运行 Vite 和 tsup watch。Desktop 包目录同时
包含 E2E 缓存、远程 mock CDN、内置 Agent 和本地 CUA Helper 等生成物；这些内容不是
TypeScript 开发源码，却会被默认的 `tsup --watch`（watch path 为 `.`）扫描。

当这些生成目录很大时，main/host 的构建 marker 迟迟不会出现，`dev.mjs` 只能持续输出
`Waiting for build artifacts`。这条日志是等待状态，不是 Electron 自身的错误。

## 目标

桌面开发 watch 只监听会触发 main/host/preload/scheduler 重建的源码和依赖，排除不会参与
开发构建增量更新的生成目录，缩短首次启动和 watcher 建立时间。必须同时收窄 watch root；
只设置 `--ignore-watch` 仍会让 tsup 先对 `.` 做全量 glob，无法解决首次扫描成本。

启动链路保持不变：

```text
dev:runtime
  +--> vite dev
  +--> tsup --watch + 生成目录黑名单
  `--> dev.mjs
          `--> 等待 main/host/preload marker 后启动 Electron
```

## 黑名单

以下路径相对于 `packages/desktop`，只用于本地开发 watcher 排除，不改变构建、打包或运行时
资源准备：

- `mock-cdn/**`
- `bundled-agents/**`
- `.e2e-cache/**`
- `.e2e-artifacts/**`
- `.e2e-home-*/**`（E2E 隔离 home）
- `dist-cua-helper/**`

这些目录可以继续由 E2E、Helper 或 runtime asset 流程写入；写入不会触发 Desktop bundle
重建。`out`、`.git` 和 `node_modules` 继续使用 tsup 默认排除规则。

watch root 显式覆盖 `packages/desktop/src` 以及 `services`、`server`、`shared`、`rpc`、
`client`、`provider`、`provider-node` 的 `src` 目录，保持 workspace 源码变更可触发重建。

## 约束

1. `dev:runtime` 和 `dev:local-cli` 使用同一份 watch root 与 blacklist，避免标准桌面和远控
   local-cli 启动路径行为漂移。
2. 只改变 chokidar 的监听范围，不改变 tsup entry、输出目录、ready marker 或 Electron
   启动门禁。
3. 黑名单必须使用 glob 形式并在 shell 中引用，避免 `*` 被宿主 shell 提前展开。
4. 修改后仍应保留 workspace 源码变化触发构建的能力；如果后续将依赖源码移出默认 watch
   范围，需显式增加对应 source path 并更新本 spec。

## 验收

- package scripts 中两个 Desktop watch 入口都包含完整黑名单。
- 相关静态测试通过。
- `tsup --watch` 日志显示每个黑名单路径在 `Ignoring changes` 中出现。
- 在包含大体积生成目录的 checkout 中，watcher 不再因这些目录的扫描阻塞 ready marker。
- `pnpm typecheck`、`pnpm lint` 和受影响单测通过。
