# Desktop 进程命名

## 目标

为了让开发态和运行态都能更快检索桌面端相关进程，应用内统一引入 `zcode-*` 命名约定。

## 命名规则

- main 进程：`zcode-main`
- renderer 进程：
  - 主窗口：`zcode-renderer-main`
  - 远程窗口：`zcode-renderer-remote-<host>`
  - Resource Manager（资源管理器）：`zcode-renderer-resource-manager`
- host utility process：`zcode-host-<label>`
- Agent 子进程：`zcode-agent-<provider>-<workspace>`

统一的字符串拼装逻辑集中在 `packages/shared/src/process-names.ts`，避免 main / host / preload / services 各自散落硬编码。

## 实现入口

- `process.title`
  - main / host / renderer preload 都会设置，提升 `ps` / `pgrep` 检索体验
- `utilityProcess.fork({ serviceName })`
  - 让 `app.getAppMetrics()` 和资源管理器里能拿到稳定的 host 名称
- `spawn({ argv0 })`
  - 给 Agent 子进程补统一的可检索入口

## 边界说明

- 开发态下，macOS Activity Monitor 或系统进程管理器的“外壳可执行名”仍可能显示为 `Electron` / `Electron Helper`
- `process.title` 更适合 `ps` / `pgrep` / 应用内资源管理器这种检索场景，不保证所有系统 GUI 都完全按这个名字展示
- GPU / Network Service 这类 Electron 内建子进程，应用内资源管理器会统一映射成 `zcode-*`，但系统级展示仍受 Electron / Chromium 控制
