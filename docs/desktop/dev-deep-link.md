# Desktop Dev deep link

## 状态

- 当前事实 spec，日期：2026-09-09。
- 目标场景：先执行 `pnpm dev:desktop:test`，再从线上测试 Share 页面点击“去 ZCode 继续”。
- 线上 Share 页面和 `zcode://share/import` 协议保持不变。

## 问题边界

线上 Share CTA 只能生成稳定的 `zcode://share/import?code=...`。macOS 的协议处理由
LaunchServices 决定，不能感知哪个终端通过 pnpm 启动了项目。

当前 `pnpm dev:desktop:test` 直接启动 `node_modules/electron/dist/Electron.app`。这个 raw
Electron bundle 的 `Info.plist` 没有 `CFBundleURLTypes`，系统登记后得到的 handler 是
`com.github.electron`，冷启动或外部 URL 进入时可能只显示 Electron 默认页。

## 方案

仅在 macOS Dev 启动脚本中准备一个本地 `ZCode Dev.app` bundle：

1. 以当前 checkout 的 Electron runtime 为源，在 `.codex-runtime/desktop-dev/` 下准备副本。
2. 只修改副本的 `Info.plist`，写入：
   - `CFBundleIdentifier=dev.zcode.app.development`；
   - `CFBundleName/CFBundleDisplayName=ZCode Dev`；
   - `CFBundleURLTypes` 中的 `zcode` scheme。
3. 仍以 `packages/desktop` 目录作为 Electron 的开发入口启动副本，保留 Vite、HMR、
   `ELECTRON_RENDERER_URL`、`ZCODE_ENV` 和现有单实例锁语义。
4. 现有 main process 继续调用 `registerDeepLinkProtocol`；由于当前进程已经来自带
   `zcode` 声明的 Dev bundle，LaunchServices 注册的是 Dev bundle，而不是 raw Electron。
5. `open-url`、`second-instance`、ShareImport 投递和导入持久化逻辑不变。

## 事件顺序

```text
pnpm dev:desktop:test
  -> dev.mjs 等待 main/host/preload/Vite 就绪
  -> 准备 ZCode Dev.app + Info.plist(zcode)
  -> 从 Dev.app 启动 Electron packages/desktop
  -> main 注册 zcode 默认 handler
  -> 浏览器点击 zcode://share/import?code=...
  -> macOS open-url / second-instance
  -> 现有 Desktop ShareImport 路由
```

## 运行边界

- 只改变未打包 macOS Dev runtime；Windows/Linux 保持当前启动路径。
- `pnpm dev:desktop:test` 继续使用测试环境 endpoint；`pnpm dev:desktop` 的 production
  endpoint 语义不改变。
- 该修复保证“Dev 已启动后点击线上页面”的场景。Dev 未启动时的 macOS 冷启动仍需要
  独立的 packaged launcher，不在本次最小修复范围内。
- 不删除或覆盖 `node_modules/electron`；生成的 `.codex-runtime/` 仅为可重建的本地产物。

## 验收标准

1. `pnpm dev:desktop:test` 启动日志记录 Dev bundle 路径和 `zcode` 注册成功。
2. macOS LaunchServices 的 `zcode` handler 指向 `dev.zcode.app.development`，而不是
   `com.github.electron`。
3. 线上 Share 页面仍显示原 CTA 和原 `zcode://share/import` href。
4. Dev 已运行时点击 CTA，不出现 Electron 默认页，现有 Dev 窗口收到 `ShareImport`。
5. Dev endpoint 为 `https://zcode.z.ai`，导入请求与页面环境一致。
6. 原有 deep-link parser/route 单测继续通过。
