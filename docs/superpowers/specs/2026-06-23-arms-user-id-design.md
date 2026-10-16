# ARMS RUM user.id 注入登录账号 userId — 设计

日期：2026-06-23
分支：feat/launch-to-input-telemetry

## 背景与问题

桌面端目前有两套 telemetry，user 维度完全不同：

1. **ARMS RUM（`@arms/rum-electron`，electron 主进程 init）**：`armsRum.init(...)`（`appARMSBootstrap.ts`）**没有传 `user`**，renderer 的 `buildArmsBrowserInitConfig()`（`armsRumShared.ts`）也没有。因此 ARMS 后台看到的「用户」只是 SDK 自动生成的**匿名 session**。唯一与身份相关的维度是三处 `armsRum.setConfig("properties", { device_mid, ... })`，其中 `device_mid = sha256(app.getPath("userData")).slice(0, 32)`（`index.ts:353`）——**一台设备一个值，与登录账号无关**。

2. **自研 telemetry core（`@zcode/shared` / `packages/services` 的 `createTelemetryCore`，运行在 fork 出的 host 子进程）**：用真实账号 `userId`，来源是 `createTelemetryUserIdLoader`（`node.ts:453`），即 OAuth `loadUserProfile(activeProvider).id`。

**结论**：ARMS 监控里现在没有账号级 userId，只有匿名 session + 设备级 `device_mid`。目标是把第 2 套里的真实账号 `userId` 注入 ARMS RUM 的 `user.id`。

## 关键架构事实

- ARMS SDK 在 **electron 主进程** 初始化；OAuth 登出 hook（`oauthService.onProviderLogout`）在 **fork 出的 host 子进程**（`utilityProcess`），主进程的 `armsRum` 够不着子进程的登出事件。
- 但**主进程自己持有 `appTelemetryCredentialService`**（`index.ts:220`），可直接读 userId（`createTelemetryUserIdLoader` 即基于它），无需跨进程。
- ARMS Electron SDK 支持运行时动态更新：`armsRum.setConfig("user", { id })`（README L243-246；`IConfiguration.user?: { id?, name?, tags? }`，来自 `@arms/rum-core` 的 `types/client.d.ts`）。
- 主进程 init 时通过 autoInject 把 `user:{ id: getUserId() }` 一并注入 renderer 的 browser SDK，因此**只改主进程一处即覆盖主进程 + 渲染进程上报**，无需改 renderer/web。

## 设计决策（已与用户对齐）

- **同步策略：动态同步**。init 时尽力设置一次；登录回调完成、以及窗口聚焦时刷新，使登录/登出/切号都能反映到 ARMS。
- **未登录兜底：回填 device_mid**。`userId` 为空时，把 `device_mid` 当作 `user.id`，保证每条上报都有非空 user 维度（设备粒度）；登录后覆盖为真实账号 id。

## 方案

### 新增模块：`packages/desktop/src/main/armsUserIdentity.ts`

职责单一：解析「当前应上报的 ARMS user.id」并写入 SDK，带去重。

- `createArmsUserIdentitySync(deps)`，依赖注入：
  - `loadUserId: () => Promise<string>`（复用主进程已有的 `createTelemetryUserIdLoader(appTelemetryCredentialService)`）
  - `deviceMid: string`
  - `setUser: (user: { id: string }) => void`（默认包装 `armsRum.setConfig("user", ...)`，测试可注入 stub）
- 暴露 `refresh(): Promise<void>`：
  1. `const userId = (await loadUserId()) || deviceMid;`（空串回填 device_mid）
  2. 与上次写入的 id 比较，**未变则跳过**（避免每次 focus 都 setConfig）
  3. 变化时调用 `setUser({ id: userId })` 并缓存
  - 内部对并发 refresh 做串行化/忽略叠加，避免竞态把旧值写回（简单做法：进行中标记 + 末次重跑）。
- 失败安全：`loadUserId()` 抛错时按未登录处理（回填 device_mid），不向上抛、不影响启动。

### 接线（`packages/desktop/src/main/index.ts`）

主进程已 `await armsInitPromise`（L1221）后配置三处 desktop telemetry。在此处构造 `armsUserIdentitySync`（`loadUserId` 复用 L229 已有 loader，`deviceMid` 复用 L353）：

1. **首次设置**：`await armsInitPromise` 之后 `void armsUserIdentitySync.refresh()`（此时通常未登录 → 落 device_mid）。
2. **登录即时**：在 `desktopMainIpcRemote` 的 `OAuthCallbackHandled` 监听（`desktopMainIpcRemote.ts:155`，登录回调处理完成的现有 IPC 信号）旁触发 `refresh()`。选此处而非改 `appTelemetryRuntime`，以缩小公共接口改面；具体接法是给该模块的 options 注入一个可选 `onOAuthCallbackHandled` 旁路回调或直接传入 sync 句柄，在现有 handler 内追加 `void armsUserIdentitySync.refresh()`。
3. **登出/切号兜底**：搭车已有的 `app.on("browser-window-focus", syncAppTelemetryInteractiveState)`（`index.ts:249`）——在该 handler 内追加 `void armsUserIdentitySync.refresh()`。覆盖 host 侧登出后主进程无即时信号的缺口（用户登出后回到窗口即刷新）。

### 不改动

- host 子进程、自研 telemetry core（其 userId 链路不变）。
- 三处 `setConfig("properties", { device_mid })`（保留作设备维度，与 user.id 并存）。
- renderer `armsBrowserInit.ts` / `web` 端（user.id 经 autoInject 自动下传）。

## 测试

对 `armsUserIdentity` 做单测（vitest，注入 stub 依赖，不依赖真实 SDK）：

- 未登录（`loadUserId` 返回空串）→ `setUser` 收到 `{ id: deviceMid }`。
- 已登录（`loadUserId` 返回 `"acc-123"`）→ `setUser` 收到 `{ id: "acc-123" }`。
- 连续两次 refresh 且 id 未变 → `setUser` 只被调用一次（去重）。
- 登录后再登出（id: account → 空）→ 第二次 refresh 回填 device_mid 并触发 setConfig。
- `loadUserId` 抛错 → 按未登录处理（落 device_mid），不抛出。

接线层无需新测试（沿用现有 telemetry 集成路径）。

## 验证

- 根 `pnpm typecheck` 不覆盖 desktop main，按惯例对 `packages/desktop` 单独 `tsc -p` 验证（见 memory: typecheck 覆盖盲区）。
- `pnpm vitest run packages/desktop/test/armsUserIdentity.test.ts`。
