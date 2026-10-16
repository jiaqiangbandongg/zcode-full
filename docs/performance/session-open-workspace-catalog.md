# Session 打开：CUA spawn 解耦与目录读取重新评估

## 基线与范围

2026-09-10 基于 staging `279907140bd7`，只重新应用 CUA 安全预留 tuple 提前返回。
不恢复目录后置，也不恢复旧 Provider 实现。
旧改动及 CCR01/CCR02 配置竞态复现完整保存在 stash `38d1e293`；那些测试针对已经移除的
`readWorkspaceState`/配置缓存合同，本轮不直接移植，也不宣称新 staging 已通过旧复现。

新 staging 的 `workspace/readPresentation` 只返回 mode/slash commands，不再创建临时 App。
模型候选由 Host ModelSelectionView 提供，Composer draft intent 与 session 执行配置保持原 owner。
因此旧版“后置目录省去约 700ms 临时 App”的结论不再适用。
剩余 slash discovery、Host client 准备及协议排队不能合并归因于目录计算，本轮不为此调整 UI 时序。

## 时序与不变量

```text
CUA：start + 原 startup tracker
       ├─ Windows waitForTransport -> 原 transport_ready/deadline
       ├─ 安全 reservedTransport 已存在且无 unavailable marker -> 立即返回 tuple
       └─ 无预留 -> 原有界等待、超时检查及 fail-closed
```

- UI 的目录读取、Composer 初始化与提交时序保持 staging 原样。
- CUA 保留 warm health、admission marker、失败 backoff 与后台 startup tracker。
  提前返回不等于 Helper 已可用；完整启动失败仍只限制后续 spawn，不回收已有 Agent。
- 不新增 timer、调度层、协议、状态 owner、持久化或跨模块接口。
- desktop continuous 与 mobile replayable 各自 delivery、gap、owner 边界不变。
  远程 Host 与 Windows 的 transport 准入不被本地 macOS 预留快路替代。

## 验证

1. 测试先行：CUA fake timer 证明已有预留时无需推进 1s；覆盖延迟预留、Windows transport_ready、warm health 失败及原 admission/失败生命周期。
2. 完整依赖 `pnpm bootstrap` 后生产构建；WDIO 启动独立 Electron，App ready、默认 workspace 目录 ready 后点击真实 session。
   以实际 pointer click 到首个 viewport 内 conversation row 为主指标，协议阶段单独记录。
3. 两个真实 session 各测 5 次，报告全部样本与中位数、interval/cumulative，不把各阶段独立中位数相加冒充总中位数。

## 当前运行记录

- 纯 staging 已测：a6（Agent 已启动）657/669/986/1857/796ms，中位数 796ms；
  6951（点击后启动 Agent）2919/2211/2704/2452/2705ms，中位数 2704ms。
- 隔离生产包、manifest、WDIO 首个可见 row 截图、日志与阶段数据：`/tmp/zcode-session-staging-ab.KWbOnL`。
- 首轮隔离包缺少新 Provider 配置路径导致 startup error；补齐构建/显式配置路径后重跑。
  启动失败的 smoke/control1 不计入基线，control2 为预热预检，round1–5 为正式样本。
- 优化后：a6 为 721/766/862/628/819ms；6951 为 1483/1390/2361/1272/1476ms。
  10 次均得到目标会话可见 row，snapshot row count 前后分别稳定为 295 / 25。
- 两组串行运行、各组交替 session 顺序；不是随机交错 A/B，也不是稳定性 SLA。
  UI 两个入口文件与 CLI bundle hash 前后相同，唯一生产代码变化是 services 的 CUA env 快路。

### 中位数对照（ms）

| 指标 | staging | CUA 优化后 | 差值（后－前） |
| --- | ---: | ---: | ---: |
| a6 click → 首个可见 row（Agent reused） | 796 | 766 | -30 |
| 6951 click → 首个可见 row（Agent spawned） | 2704 | 1476 | -1228 |
| 6951 command resolved → spawn preflight（Host 子阶段） | 1051 | 60 | -991 |
| 6951 Host prepare | 1775 | 770 | -1005 |
| 6951 CLI request → ACK | 566 | 541 | -25 |
| 6951 session restore（request → ACK 子阶段） | 343 | 330 | -13 |
| 6951 ACK → 可见 row（残差，含埋点间隙） | 225 | 115 | -110 |

各行独立取中位数，且存在父子关系，不能求和。端到端减少约 45%，明确可归因的是 Host
约 1s 固定等待消除；不能把另外约 0.2s 的差异也全部算成 CUA 收益。a6 已有 Agent，30ms
差异不作为确定收益。6951 的 2361ms 慢样本中 preflight 仅 60ms、Host prepare 为 1429ms，
长等待发生在 preflight 之后，不能据此判为快路失效。

### 同一轮 interval / cumulative 对照（ms）

取首个可见 row 恰好处于各组中位数的运行：baseline 6951 round3、optimized 6951 round5。
累计为同一轮已测阶段的算术累计，埋点之间未覆盖的时间单列；可见 row 使用独立 DOM 终点，
不把 interactive 终点冒充可见终点。

| 阶段 | staging interval | staging cumulative | optimized interval | optimized cumulative |
| --- | ---: | ---: | ---: | ---: |
| click → acquire | 55 | 55 | 52 | 52 |
| Renderer prepare | 0 | 55 | 0 | 52 |
| Host prepare | 1775 | 1830 | 770 | 822 |
| CLI request → ACK | 644 | 2474 | 526 | 1348 |
| initial frame transport + snapshot apply | 5 | 2479 | 2 | 1350 |
| React render | 92 | 2571 | 56 | 1406 |
| paint → interactive | 134 | 2705 | 35 | 1441 |
| 未分配的埋点间隙（补齐独立 click → interactive） | 11 | 2716 | 41 | 1482 |

独立 DOM 可见终点分别为 2704 / 1476ms。其他轮的 interval/cumulative 保存在各自
`runs/<variant>-<session>-roundN/profile.md`；原始样本与汇总在 `results.json`。

### read 后置的剩余空间

a6 的 workspace presentation 已预热，点击窗口没有目录请求。6951 仍有目录读取先于 resume，
但 `CLI request → ACK` 扣除 restore 的中位数残差仅为 223 → 211ms；这还包含请求排队与
其他 subscribe 处理，不是纯目录耗时，不能承诺后置可全部省掉。Host 的整段
`readWorkspacePresentation` 时间包含 Agent 启动，尤其不能把约 1s 的 Host 准备重复算成目录成本。
当前先保留 staging 的目录读取顺序，只有后续独立证据证明收益值得时再评估后置。

### 验证与限制

- 新增零时间推进单测在原代码上失败，优化后通过；CUA env、producer resolver、Helper Host、
  Windows Host 与 service dispose 共 144 项单测通过。
- `pnpm typecheck`、Desktop `typecheck:e2e`、`pnpm architecture:check --changed`、变更 TS 格式检查通过。
  `pnpm lint` 为 0 error / 43 条未改动文件 warning；`git diff --check` 通过。
- `check-workspace-freshness` 因落后旧实验 `origin/feat/session_opt` 1 个提交报错；本轮按用户指定的
  已拉取 `origin/staging` / HEAD `279907140bd7` 为基线，未混入旧实验提交。
- 本轮 WDIO 是真实本地会话打开 benchmark，不是 CUA 权限/实际工具调用的完整 E2E。
  Windows 实机、手机远控以及实际 CUA 调用未重跑，不宣称全平台端到端零风险。
- 快路仅适用于已安全预留的 transport；首次 start 尚未发布预留、warm health 和 Windows
  transport_ready 仍可能有原来的有界等待，没有新增轮询、缓存或更宽的准入。
- 本轮不自动提交或 push，旧 stash 保留。
