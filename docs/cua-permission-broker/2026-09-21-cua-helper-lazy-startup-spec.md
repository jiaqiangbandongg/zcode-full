# CUA Helper 懒启动规范（macOS / Windows）

## 状态

- 状态：已实现（MR1/MR2 落地于 feat/cua-helper-lazy-startup + producer feat/win-lazy-fork@5bcdde06）；全部门禁绿（typecheck/lint/architecture/services 单测 3141）；darwin 实机 MC-1/2/3 与 Windows 全链路 MC-4~7/9 待实机验证
- 日期：2026-09-21
- 适用范围：Desktop Host（services）、Agent spawn/session 链路、zcode-cua SDK（producer）、
  Computer Use Helper
- 平台：macOS 与 Windows；Linux 不在本规范范围
- 前置：M7 已在 darwin 落地懒启动基线（spawn 恒注入稳定 socket、SDK 首次 CUA 调用自拉、
  设置页按需拉起）。本规范收窄 darwin 残留路径，并把 Windows 移植到同一模型
- 替代关系：本规范替代
  [Helper lifecycle 隔离规范](./2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md)
  中与 spawn env 相关的准入条款——即 §3.1 的「2026-09-10 spawn 快路」条目与 §3.3 中
  「Agent spawn env 需要决定是否可以注入当前 broker tuple」的有界探针入口。该规范的其余
  条款（fail-closed、进程身份校验、代际 fence、无周期探测、Helper 事件不得 dispose Agent）
  继续完全有效

## 一、产品不变量

**核心不变量：Agent-facing 凭据 =（传输路径， pluginAuthority）是纯数据。**

铸造与推导零 IO；注入（spawn env、resolver、设置页）零 IO、零等待、零健康依赖。
Helper 的启停与健康只影响 CUA 工具调用的结果与设置页展示，永不影响 Host 启动、
Agent spawn、session create 的时序。

必须永久成立：

1. Host 进程启动不得触发 Helper 安装、启动或探测（孤儿收割仅随授权流的 host 懒创建执行）。
2. Agent spawn env 解析不得包含任何 Helper IO：无 `checkHealth`、无 `waitForTransport`、
   无 acquire、无 deadline race。
3. Helper 的合法启动触发者只有三类：
   - Agent 首次 CUA 调用的 SDK `ensureBrokerAvailable`（唯一的首调路径）；
   - 用户显式动作：设置页 `getStatus` 拉起、权限授权流；
   - Host 维护动作：`restartAfterPermissionGrant` 等 resolver 重启入口。
4. standalone 模式 300s idle 自退是特性：无人使用即退出，不常驻。
5. spawn 注入的凭据在 Host 进程生命周期内恒定（Windows 稳定 pipe 名、macOS 稳定 socket
   推导）；Helper 重启或换代不换发凭据，已持有凭据的 Agent 无需任何更新动作。

## 二、当前问题（2026-09-21 基线事实）

**darwin（M7 已落地，存在残留）**：

- spawn env 已恒定注入稳定 socket + spawn 铸 authority（`node.ts:2184`）；resolver 已
  peek-only pass-through（`node.ts:2308`）；SDK 首调自拉含安装与 bundled 刷新
  （producer `computer-use-runtime.ts:91`）。
- 残留阻塞：授权流刚建过托管 host 时，spawn 走 `buildCuaProductHelperAgentEnv` 的
  warm `checkHealth(1000)` / marker 恢复探针 / 预留 race（`node.ts:1123`），挂死 Helper
  场景吃满 1s。
- `warmHelperForBuiltInPlugin` 预热路径与懒启动语义冲突。

**win32（仍是旧模型）**：

- spawn `await getOrCreateDefaultCuaProductHelper`（含 runtime 解析 IO）+
  `waitForTransport(1000)`（`node.ts:1186/1193`）。
- SDK `ensureBrokerAvailable` 在 win32 为 no-op；Helper 只能由 Host fork
  （`windowsCuaDevHelperHost.ts:308`，pipe 名本就由 Host mint 经 argv `--socket` 传递）。
- 设置页 `getStatus` 在 win32 直接返回 "CUA permissions are only available on macOS"
  （`node.ts:1900`），无任何状态。

**结构性浪费（已被 M7 的 darwin 改动证实）**：spawn 侧 1s grace race 等待的是完整
startup（含 750–1080ms bundle 验签 + Gatekeeper + 健康），而它要发的 tuple 在 `start()`
首个 await（占位 bind，毫秒级）后即可用；无论等多久结论相同。

## 三、规范性行为

### 3.1 凭据铸造与注入（两平台统一）

| 平台 | 传输路径 | pluginAuthority |
| --- | --- | --- |
| darwin | `resolveBrokerSocketPath()` 稳定推导（ZCODE_HOME 派生），零 IO | spawn 时铸造（per-bootstrap config-provenance，保留现状） |
| win32 | Host app 进程铸一次的稳定 pipe 名（含随机段；模块级 singleton；Host 重建复用同名；跨 app 运行必不相同） | 同 darwin |

- spawn env 注入 = 纯查表，函数体内不得出现任何 `await` Helper 相关 IO。
- win32 spawn env 额外注入 **fork recipe**（见 3.3）。
- resolver 恒 pass-through（不 acquire、不改写凭据）；CUA MCP 凭据只经 agent 进程 env
  流转，与 M7 darwin 对齐。

### 3.2 Helper 启动时序

图 1：macOS 冷启动 → spawn → 首次 CUA 调用（干净机器）

```text
Host                                Agent(SDK)                     Helper(standalone)
 │ app 启动（零 Helper IO）             │                                │
 ├─ resolveSpawnEnv ─────────────────► │ spawn，<5ms 返回                │
 │   env = { 稳定socket, authority }    │ （不连 socket、不探活）          │
 │                                     │ ── 非 CUA turn 正常跑 ──        │
 │                                     │ ══ 首次 CUA 工具调用 ══          │
 │                                     │  connect(稳定socket) ✗ ENOENT  │
 │                                     │  onUnavailable → ensure(5s冷却) │
 │                                     │   ① ensure-installed（首装）     │
 │                                     │   ② LS open standalone ───────►│ bind 稳定socket
 │                                     │                                 │ flock 单实例、无 launcherPid
 │                                     │                                 │ ⇒ 300s idle 自退启用
 │                                     │  ◄─ warmup-retry ───────────────┤ authenticate(签名门)
 │                                     │ ─── broker 调用 ───────────────►│
```

图 2：Windows 冷启动 → spawn（零 IO）→ 首调自 fork

```text
Host                                Agent(SDK)                     Helper(forked node)
 │ app 启动：铸稳定 pipe 名（一次性）      │                                │
 ├─ resolveSpawnEnv ─────────────────► │ spawn，<5ms 返回                │
 │   env = { PIPE名, authority,          │ （零 acquire、零等待）           │
 │          RECIPE(见3.3) }             │                                │
 │                                     │ ══ 首次 CUA 工具调用 ══          │
 │                                     │  connect \\.\pipe\… ✗           │
 │                                     │  ensure(win32 分支) fork ──────►│ bind pipe(~300-500ms)
 │                                     │   (--socket 稳定名,              │ authenticate/peer 门
 │                                     │    --parent-pid hostPid)        │ native 初始化
 │                                     │  ◄─ warmup-retry(2s 窗) ───────┤
 │                                     │ ──── broker 调用 ──────────────►│
 │  并发首调：第二个 fork bind 失败退出，无害；两 Agent 连同一 Helper        │
```

图 3：死亡/空闲后的恢复（两平台同构）

```text
Agent(SDK)                                    Helper
 │ ── (darwin) 300s 无连接 && 无 in-flight ──► idle_exit: exit(0)
 │ ── (任意平台) kill / 崩溃 ─────────────────► 消失
 │ ── 后续 CUA 调用 ──► connect ✗
 │   ensure（5s 冷却内只拉一次）
 │     darwin: LS open（flock stale 清理后重绑稳定 socket）
 │     win32:  fork（同一稳定 pipe 名 → 新实例独占 bind）
 │   ◄── warmup-retry 连上 ── 恢复；调用方凭据不变
```

图 4：Helper 生命周期状态机（触发者标注）

```text
 [不存在] ──Agent 首调 ensure──► [启动中 bind+native] ──ready──► [服务中]
    ▲                                │                            │
    │                                │ 启动失败(peer 门/缺件)       │ 300s 无连接(darwin)
    │                                ▼                            │ kill / 崩溃
    └────────────────────────────────┴────────────────────────────┘
 Host 启动 / spawn / session create / resolver 在任何转移边上都不出现（只读纯数据）。
```

图 5：设置页（用户显式 demand boundary）

```text
用户                        Host(设置页/getStatus)              Helper
 │ 直接进电脑控制设置页          │                                 │
 │ ──────────────────────────► │ probe(300ms ping) ── ✗ ────────│（不存在）
 │  （页面 loading）            │ darwin: LS open standalone ────►│ bind
 │                             │ win32:  Host fork ─────────────►│ bind pipe
 │                             │ poll ping(≤5s) ◄───────────────── ready
 │  ◄── permission_status 真值 │                                 │ idle 计时开始
 │  拉不起 → idle:true 降级文案（"首次使用 Computer Use 时会自动启动"）
```

### 3.3 win32 SDK fork 契约（producer 侧新增）

- `ensureStandaloneHelperLaunched` 增加 win32 分支：
  `fork(recipe.entryPath, ["--socket", 稳定pipe名, "--parent-pid", recipe.hostPid],`
  `{ env: { ELECTRON_RUN_AS_NODE: "1", [ADDON_ENV]: recipe.addonPath, …白名单 } })`。
- recipe 经 spawn env 注入，键名定稿为 `ZCODE_CUA_WIN_HELPER_RECIPE`（值为 JSON：
  `entryPath`、`command`、`root`、`addonPath`、`commandEnv`、`hostPid`；常量登记进
  producer helperConstants，z-code 侧用同名字面量，两处一致属跨仓契约）。
- `--parent-pid` 恒为 **hostPid**：Helper 生命周期挂 Host（watchdog 只认 Host pid），
  不随 fork 方 Agent 退出；Agent 进程死亡后 Helper 存续，stdio control channel 断写
  属可接受损耗（该 channel 仅作拉起方可观测性，见下）。
- 单实例：named pipe 独占 bind。并发首调的第二个 fork 实例 bind 失败退出，无害，
  双方连同一 Helper。
- `transport_ready` control channel 归 fork 方（Agent）所有；Host 的 spawn、状态查询、
  `restartHelper` 均不依赖它（Host 直接连 pipe 查询；重启用 Host 自己的 runtime 配方
  重新 fork）。
- peer 门现状（M8 fail-closed，缺 4 个 native peer 原语）不因本规范改变；本规范只改
  生命周期时序，不触碰能力面。

### 3.4 死亡与恢复

- Helper 死亡或空闲退出后，恢复 = 下一次 CUA 调用的 ensure 再拉（同一路径/pipe 名，
  凭据不变）；调用进行中死亡按 delivery-state 收口（`possibly_sent` 禁止自动重放）。
- Host 侧不设周期探测（沿隔离规范 §3.3）；resolver 的 `checkHealth` + `restartHelper`
  仅保留给授权后重启与权限维护入口。

### 3.5 设置页（两平台统一）

- `getStatus`：probe（300ms ping，不拉起）→ 无则拉起（darwin LS open / win32 Host
  fork，Host 侧保留 runtime 解析能力即为此用）→ 就绪后 `permission_status` 真值查询。
- 拉起失败 → `{ available:false, idle:true }` 与友好文案，不报错不打扰。
- 拉起候选与安装 variant 同源（producer `standaloneHelperCandidatePaths`）：
  stable/preview/dev 运行时各自只枚举本 variant 的安装根。**生产运行时不得枚举 dev
  根**——dev 残留在场时静默选中未签名包会让设置页恒「拉起失败」且伪装成权限问题
  （2026-09-22 ZCT-2102352739585175552）。dev 运行时额外兼容 `dev/` 根下装成稳定名的
  一键 bundle（2026-09-10 修复意图保留）。候选缺失 → 按拉起失败路径走安装引导。
- win32 删除 "only available on macOS" 短路（权限真值查询逻辑本身是平台无关的 broker
  方法调用）。

### 3.6 授权流并存窗口（darwin，保守取舍）

- 授权流的托管 host 拉起 managed Helper（随机 socket、`launcherPid=Host`、无 idle 退）；
  窗口内 spawn 仍恒注入稳定 socket；两个 Helper 短暂并存、互不干扰（不同 socket，
  flock 不冲突）；host dispose 时收口 managed 实例。
- 增强选项（未纳入本次）：mac 托管 host 改用稳定 socket 并 adopt 既有 standalone
  实例，消除并存窗口。留待实测并存窗口产生实际困扰时再做。

## 四、边界与状态 owner

| 状态/事实 | 权威 owner | 说明 |
| --- | --- | --- |
| 稳定 pipe 名（win32） | Host 模块级 singleton | app 进程铸一次，Host 重建复用 |
| 稳定 socket 路径（darwin） | `resolveBrokerSocketPath()` 纯推导 | 零状态 |
| pluginAuthority | spawn 侧铸造 | config-provenance 语义，Helper 不校验它 |
| Helper 进程生命周期 | launcher watchdog（认 hostPid）+ idle 计时（darwin standalone） | 无人使用即退出 |
| Helper 健康 | 按需查询（调用重试、设置页、权限维护） | 无周期探测 |
| spawn admission marker | 废弃（本规范） | resolver restart 内部的恢复代际仍保留，但不再被 spawn env 消费 |

## 五、实现分阶段

### MR1（纯 services，darwin 收尾；本机全可验证）

- spawn env 删除 peeked-host 分支：darwin 恒注入稳定 socket + authority，
  `buildCuaProductHelperAgentEnv` 在 darwin 不再可达。
- 测试：MC-1、MC-3；`cuaPermissionBrokerProductAgentEnv.test.ts` 相应调整。

### MR2（producer + services，win32 移植 + 清理）

- producer：`ensureStandaloneHelperLaunched` 增加 win32 fork 分支 + 单测；删除
  `warmHelperForBuiltInPlugin` 预热路径（懒启动下「无候选即预热」与不变量 3 冲突）；
  producer pin bump 用原子命令
  `pnpm --filter @zcode/zcode-cua-plugin bump:producer`。
- services：稳定 pipe 名 singleton；spawn env 注入 pipe 名 + authority + recipe（删除
  win32 acquire / `waitForTransport`）；`getStatus` win32 对齐 3.5。
- 清理（可并入本 MR 或单独 MR3）：删除 `buildCuaProductHelperAgentEnv` 尸体、
  `CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS`、spawn 侧 admission marker 消费、
  `cuaProductHelperWorkspaceRegistry.setEnabled` 的 spawn 调用点。
- 测试：MC-4/5/6/7/8/9；Windows 实机验证缺口在 MR 如实标注。

## 六、验证矩阵

| Case | 平台 | 初始状态 | 事件 | 预期 |
| --- | --- | --- | --- | --- |
| MC-1 | darwin | 冷启 app | spawn env 解析 | 无 Helper IO（fake host 断言 start/checkHealth 未被调用），毫秒级 |
| MC-2 | darwin | 干净机器 | 首次 CUA 调用 | SDK 安装+拉起后调用成功（M7 回归） |
| MC-3 | darwin | 授权流刚结束（host 在） | spawn | 仍恒注入稳定 socket；不探针、不等 1s |
| MC-4 | win32 | 冷启 app | spawn env 解析 | 零等待、零 acquire；env 含 pipe 名 + recipe |
| MC-5 | win32 | 无 Helper | 首次 CUA 调用 | SDK fork → warmup 窗内连上 → 调用成功 |
| MC-6 | win32 | Helper 被 kill | 下一次 CUA 调用 | 失败 retryable → ensure 再 fork（同名 pipe）→ 恢复 |
| MC-7 | win32 | 双 Agent 并发首调 | 同时 ensure | pipe 单实例；第二 fork 失败无害；连同一 Helper |
| MC-8 | 两平台 | Helper 已重启/换代 | spawn env 与既有 Agent 凭据 | 传输路径恒定（同 socket/pipe），Helper 换代不换发凭据；darwin authority 按 spawn 铸造、各 agent 可不同，属既有语义 |
| MC-9 | win32 | 未开对话 | 直接进设置页 | probe → Host fork → 权限真值；失败则 idle:true 降级 |

回归红线（沿隔离规范 §7，继续有效）：

- Helper 生命周期日志中不得出现由 readiness/recovery 直接引起的 `workspace-dispose`；
- 普通 Agent spawn / session create 的时序不包含 Helper IO；
- 非 CUA 模块启动耗时不包含 Helper health budget。

必要验证命令（按根 AGENTS.md）：`pnpm typecheck`、`pnpm lint`、
`pnpm architecture:check --changed`、受影响单测；涉及 apps/zcode-cli 的改动另按
[CLI 规则](../../apps/zcode-cli/AGENTS.md)验证；desktop CUA E2E 按现 case catalog 执行。

## 七、风险与未验证项

1. **Windows 实机缺口**：开发机为 macOS。MR2 的 fork 配方、pipe bind、transport_ready
   行为只能以单测覆盖；实机验证待 Windows 同事接力，MR 中如实标注。
2. **Windows M8 peer 门**：现状 CUA 在 win32 fail-closed。本规范不改变能力面，只改
   生命周期时序；peer 门解除后本规范行为不变。
3. **idle 自退副作用（darwin）**：无连接 300s 后 PiP / ghost cursor 随 Helper 关闭。
   与 CLI 现状一致，属懒启动的自然语义。
4. **授权流并存窗口（darwin）**：见 3.6；增强选项留待需要时。
5. **agent 侧 ensure 与 managed Helper 的启动竞态（darwin 授权流窗口）**：不同 socket
   的 flock 相互独立，最坏情况窗口内短暂双实例；授权流 host dispose 收口。

## 八、实施顺序

1. 本规范确认（本文档）。
2. MR1 实现并本机完成全部必要验证。
3. MR2：先 producer（win32 fork 分支 + 单测）→ pin bump → services 侧接入 → 单测；
   Windows 缺口标注。
4. 按 [E2E 工作流](../../.agents/skills/e2e-case-lifecycle/SKILL.md)评估并更新
   desktop CUA E2E case catalog。
5. 完成后运行第六节验证命令；无法实机验证的平台在 MR 列出风险与待补证据。
