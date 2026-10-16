# Desktop Context Prompt 灰度裁决链路与首 Host 门禁

> spec / 轨迹文档：服务端灰度（Desktop Context Prompt，简称 Desktop SP / DSP）如何决定 Agent
> 是否输出 `::code-comment` 指令；以及 CR-01 修复的"首个 Host 创建时灰度裁决无生效路径"问题。

## 1. 背景：什么是 Desktop Context Prompt

服务端通过 `/api/v1/client/configs` 下发单功能灰度：`data.configs.desktopContextPrompt.enabled`。
- `enabled: true`：Agent 以 **desktop surface** 启动，系统提示注入 `::code-comment{...}` 指令段
  （`apps/zcode-cli/packages/core/src/context/sections/desktop.ts`），助手输出内联 code-comment。
- `enabled: false` 或未下发：Agent 以 **terminal surface** 启动，跳过该段，输出普通 terminal prompt。

## 2. 冻结链路（核心事实）

裁决一旦离开 desktop main，会被多个进程边界冻结。整条链路如下：

```
desktop main 进程
  └ createDesktopContextPromptRollout          ← 拉取 + 缓存裁决（TTL 1h，请求超时 3s）
        │  getSnapshot().enabled（live，随成功 refresh 更新）
        ▼
  └ resolveDesktopContextPromptEnabledForHost()  ← Host fork 时同步读快照
        ▼
  └ spawnHostProcess(env: ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED="0"|"1")  ← 烤进子进程 env
        │  （desktopHostProcess.ts:291）
        ▼
Host 子进程（Local Host / Remote Host）
  └ services/node.ts:614-621 顶层 const 只读一次 env → desktopContextPromptEnabled
        ▼
  └ resolveZCodeAgentPresentationSurface({...})  ← 只在 Host 启动时算一次
        ▼
  └ ZCodeAgentProcessManager.presentationSurface（Host 生命周期内冻结）
        ▼
  └ spawn CLI: --surface desktop | （缺省）--surface terminal
        ▼
Agent 子进程（CLI）
  └ run.ts:192 normalizePresentationSurface → "zcode_desktop" | "terminal"
  └ zcode-protocol-entrypoint.ts:31 runtimeConfig.presentationSurface（进程内冻结）
  └ context/builder.ts:114 仅当 "zcode_desktop" 注入 desktop context section
```

**两个冻结点**决定了：运行中的 Host / Agent 不会重新评估灰度。只有**新 fork 的 Host** 才会读取
最新快照。因此裁决的"可达性"完全取决于：Host fork 时 `getSnapshot()` 是否已是服务端真值。

## 3. CR-01 问题：首个 Host 创建时裁决无生效路径

### 病根（设计张力）

- 旁路约束：`index.ts` 注释明确——"网络请求不能阻塞 Local/Remote Host"。bootstrap 的
  `void rollout.refresh()` 与 `resolveDesktopContextPromptEnabledForHost()` 里的 `void rollout.refresh()`
  都是 **fire-and-forget**。
- 冻结约束：surface 在 Host/Agent 启动时冻结（见第 2 节）。

两者叠加后，**异步成功结果对已创建的首个 Host/Agent 没有可达生效路径**：

```
t=0      app.whenReady → void refresh()（发请求，≤3s，不 await）
t≈500ms  首个 Local Host dom-ready → resolveDesktopContextPromptEnabledForHost()
           ├ void refresh()（命中 inFlight，复用 t=0 的请求）
           └ return snapshot.enabled  ← 同步读 → false（请求尚未 resolve）
         spawnHostProcess(env="0")  ← 烤死
t≈1.8s   网络成功 enabled=true → snapshot 更新（但首 Host 已带 "0" 跑起来）
         → Host/Agent 冻结 → 整个应用会话继续用 terminal prompt，不产生 ::code-comment
```

只有"请求在首 Host fork 前 resolve"（快网/缓存命中）才能命中灰度；慢网下首会话必漏，
通常要新建窗口或重启才恢复。远程 workspace 若复用该 Local Host 也继承错误裁决。

### 4. 修复：首个 Host 创建前的有界裁决门

给"成功结果"一条**有界的生效路径**：首个 Host fork 前 await 一次裁决，失败/超时仍 fail-open。

```
app.whenReady
  ├ void rollout.refresh()                  ← 预热（最早发请求，复用 inFlight）
  └ ensurePrimaryWindow → createWindow
        └ dom-ready handler（async）:
              … 同步 setup（cancel/gen/win32 show/oldChild 处理）不变 …
              if (awaitFirstHostSpawnDecision)            ← 新增：有界门
                  await awaitFirstHostSpawnDecision()     ≤2s，first-only 永久 latch
              spawnLocalHost()                            ← 此刻快照已是服务端裁决
```

### 关键设计点

1. **`rollout.awaitFirstDecision(timeoutMs)`**（`desktopContextPromptRollout.ts`）
   - `Promise.race([refresh(), setTimeout(timeoutMs)→snapshot])`。
   - 复用 `refresh()` 的 TTL/inFlight 去重 + 内部 3s 请求超时；两支均 resolve（refresh 内部已 catch，
     timeout 回退当前 snapshot），永不 reject。
   - **无状态**——first-only latch 由调用方（desktop main）持有。

2. **`firstHostSpawnDecisionPromise` + `awaitFirstHostSpawnDecision()`**（`index.ts`）
   - 模块级永久 latch（首次创建后不清空）。首个 Host 之后的所有 fork await 已 resolve 的 promise，近乎 0ms。
   - 超时 `DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000`（< 内部 3s 请求超时，留缓冲）。
   - 即使首 Host 超时回退 `false`，后台请求最终成功后 `getSnapshot()` 变 true——**后续 Host fork**
     （新窗口/reload）同步读取 live 快照即可命中，无需 re-arm latch。

3. **Local 路径**（`desktopWindowLifecycle.ts`）
   - dom-ready handler 改 `async`；reattach 早退路径之后、`spawnLocalHost` 之前插入
     `if (options.awaitFirstHostSpawnDecision) { await options.awaitFirstHostSpawnDecision(); }`。
   - **用 `if` 守卫而非 `await cb?.()`**：cb 缺省时**完全不触发 await**，async handler 同步跑完——
     既有不注入 gate 的调用方与测试零回归。
   - `spawnHostProcess` 签名/返回类型**不变**，`spawnLocalHost` 保持同步。

4. **Remote 路径**（`desktopRemoteSessions.ts`）
   - `createRemoteWorkspaceSession`（覆盖 SSH/WSL/Dedicated 三个 fork 点）与
     `createBotRemoteWorkspaceRuntimePort`（第 4 个 fork 点，不经 createRemoteWorkspaceSession）
     在 `appShutdownStarted` 检查之后 await gate。
   - **teardown re-check**：参考 `:1841` 既有"跨 await 期间窗口/app 可能 teardown"防护，await 越过点后
     必须重新校验 `appShutdownStarted` 与 `win.isDestroyed()`，命中则 throw，禁止在退出 barrier 之外再 fork。
   - `spawnHostProcess` 签名/类型**不变**，4 个 fork 点无需 async 化、无 pool 连带改动。

### 超时 / 延迟语义

| 场景 | 首 Host 延迟 |
|---|---|
| 快网/缓存命中（请求 < 500ms） | ~0ms（gate 在 dom-ready 前已 resolve） |
| 慢网（请求 > 2s） | 最多 +2s（fail-open 用 `false` 继续） |
| 首 Host 之后的所有 fork | ~0ms（latch 已 resolve；读 live 快照） |

慢网下的 +2s 加在"首次打开工作区"前，不在窗口显示前。已确认为可接受 trade-off。

## 5. 多端 / 边界兼容

- **桌面端**：gate 仅在 desktop main 进程；Local 与 Remote(SSH/WSL/Docker) 共享同一 first-only latch。
- **Web / 手机端**：无 host fork，不受影响。手机 `/remote` 通过 shared-host attachment 连接桌面已存在的
  Local/Remote Host，继承该 Host 创建时的裁决——这正是 gate 要保证"首 Host 裁决正确"的价值。
- **Web 远控保护**：gate 不下沉任何 session/task/stream 状态到 relay/main；只是 main 进程内一次性 await。
  不影响 `continuous`（桌面）与 `replayable`（手机）链路边界。

## 6. 测试覆盖索引

| 文件 | 覆盖 |
|---|---|
| `packages/desktop/test/desktopContextPromptRollout.test.ts` | rollout 解析、TTL、inFlight 去重、3s 超时；`awaitFirstDecision` 慢响应/超时回退/并发；**CR-01 集成式**（慢响应 `enabled=true` + bounded await → 同步读快照为真值） |
| `packages/desktop/test/desktopWindowLifecycle.test.ts` | Local dom-ready → spawn 流程；**gate 未 resolve 前不 spawn，resolve 后 spawn** |
| `packages/desktop/test/desktopRemoteSessions.test.ts` | Remote 各 fork 点；**gate 阻塞 spawn、resolve 后完成 session**；**gate await 期间 teardown → re-check 拦截、不 spawn** |

## 7. 相关常量 / 环境变量

| 名称 | 位置 | 说明 |
|---|---|---|
| `ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV` | `packages/shared/src/runtimeEnv.ts` | Main→Host 的 env 名（`"0"`/`"1"`） |
| `DESKTOP_CONTEXT_PROMPT_REQUEST_TIMEOUT_MS` | `desktopContextPromptRollout.ts:9` | 单次请求超时 3s |
| `DESKTOP_CONTEXT_PROMPT_CACHE_TTL_MS` | `desktopContextPromptRollout.ts:10` | 成功缓存 TTL 1h |
| `DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS` | `packages/desktop/src/main/index.ts` | 首 Host 门禁超时 2s |
