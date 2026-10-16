# Todo 145 开工审查与影响面

后续实施与验证见 [实施复审](./database-startup-implementation-review.md)；本文保留开工时的审查轨迹，下方“待实现”是历史状态。

日期：2026-09-14。结论：产品目标、排除范围和验收维度已经足够进入实施的 A 阶段；不是实现完成或发布通过。
执行入口：[Todo 145](../working-memory/provider-refactor/steps/todo-145-global-database-startup-loading.md)。本轮只审查和整理文档，不修改产品代码、不继续性能测试。

## Feature Summary

| 字段 | 内容 |
| --- | --- |
| Developer intent / Capability | 主界面前统一准备本地数据库、准确失败提示、低开销磁盘观测与 ARMS 诊断 |
| Change layer / Operating mode | presentation、validation、commit-effect、persistence、recovery；planning |
| Primary seeds | renderer main/Root、Host InitLocal、createLocalServices、TaskIndexRepo、Agent storage bootstrap/runner、ARMS reporter |
| Out of scope | SQL/ledger/checksum 变更、批处理、全库备份、全远端预连接、通用遥测平台、20 GB 性能承诺 |

## UI Surface Matrix

| 场景/入口 | 共享实现 | 展示状态/默认来源 | 校验与动作 | 权威与落点 | 模式隔离 |
| --- | --- | --- | --- | --- | --- |
| Desktop renderer 冷启动 | 独立启动壳待实现，基础 loading 可复用 | Host 快照；主题/语言沿既有本地来源 | 所需库+必需服务 ready 才挂 Root；失败重试 | Host attempt；SQLite 事务/账本 | 无 workspace 也生效；不依赖账号网络 |
| 工作区/聊天 Root | 原 hook 接入待撤 | 完成启动后正常恢复 tabs | 保留服务端准入，不随切 tab 重启全局准备 | 原 workspace/Agent owner | identity/path 不混用；active-first 恢复规则保留 |
| 远程工作区 | 现有连接壳及远端启动能力 | 对应 remoteSessionId 的服务源 | 连接 ready 后才读迁移状态；失败仍可重连 | 对应远端库 | 不等待其他历史 SSH/WSL/Docker；旧 Agent 按能力兼容 |
| 手机 /remote | shared-host attachment 的启动状态投影 | 同一 Host 快照，非独立 runtime | 观察、重连；启动失败恢复沿桌面 owner | 同一后端账本 | replayable 不扩散到 desktop continuous；Main/relay 只转发 |
| Web server/独立 CLI | 注入 reporter 和原存储入口 | 各自配置与实际库 | 保持其启动准入；无 Electron SDK 依赖 | 各自运行环境 | 桌面壳不是后端数据安全前提 |

## Shared And Divergent Behavior

| 关注点 | 共享 | 差异与原因 |
| --- | --- | --- |
| UI/component | 基础 loading/i18n 可以复用 | 全局启动页重写；远端连接错误不能套成本地迁移错误 |
| Option source / Default | 数据库路径沿实际配置解析 | 不引入 Provider/模型候选或默认值修改；不同库独立准备 |
| Validation / Commit effect | 先准备、后业务；统一安全错误 | 桌面负责重试 owner；手机观察；SQL 锁由 SQLite 决定 |
| Persistence/recovery | 冻结原 SQL、账本、单库事务 | 两库不跨库回滚；遥测终态补报不成为迁移状态来源 |

## Feature Relationships

| Rank | From → semantic edge → To | 原因与源码依据 |
| --- | --- | --- |
| must-inspect | renderer ServicePort → 挂载 Root → hooks | `renderer/src/main.tsx` 目前收到业务端口就挂 Root；启动页必须更早独立存在 |
| must-inspect | Host InitLocal → createLocalServices → 后台同步 | `host/index.ts`、`services/src/node.ts` 装配期间有后台启动，不能只移动 UI |
| must-inspect | TaskIndex/Automation/OffPeak Repo → ensureReady → 同一 tasks-index | 三个 Repo 均打开 SQLite；TaskIndex 有迁移后修复，账本齐全不等于初始化结束 |
| must-inspect | Agent bootstrap → 原 SQL runner → COMMIT/错误 | `app/session-store.ts`、`migration-runner.ts`；原 cause 保留但分类粗，finally 不能覆盖原错误 |
| must-inspect | 原始错误 → schema → UI/ARMS | `errors.ts`、shared `zcodeStorageStartupStateSchema`、`DatabaseStartupLoading` 需同步分类 |
| must-inspect | Main telemetry → SDK reporter → HTTP 接收 | 安装 SDK sendCustom 返回 void，request 未在该层检查 HTTP status；发送调用不是入库证明 |
| should-inspect | 环境预热/更新退出 → Host 生命周期 | `desktopWindowLifecycle.ts` 的 4.5 秒环境预算不得误套到长迁移；退出/安装继续释放资源 |
| conditional | remote connection / mobile attachment → 对应 runtime | 未连接代理不应触发 DB 失败；不能创建额外 Host/Agent |
| invariant-only | CommandInbox / owner lease / replay profile | 启动改动不改变已接受输入、流和快照恢复语义 |
| evidence-only | 旧锁/崩溃/原 SQL 回归与 pending E2E | 可复用测试基础，不能沿用旧 loading 已通过的结论 |

## State Owners And Commit Sinks

| 状态 | 展示/镜像 | 权威 owner | 提交与持久化 |
| --- | --- | --- | --- |
| 已迁移项 | Host/UI 进度 | SQLite ledger | 原事务 COMMIT |
| 本次准备 | UI 快照、Main 遥测镜像 | Host coordinator | 内存 attempt；不得以 telemetry 文件续跑迁移 |
| 错误与恢复状态 | UI/ARMS 同源分类 | 失败阶段执行者及 Host | 原始 cause 本地诊断；安全码跨进程 |
| 磁盘观测 | Host 聚合、Main 小摘要 | OS statfs 返回值 | 仅 peak/min/覆盖摘要；不是物理独占成本 |
| 遥测待发送终态 | Main reporter | 发送确认/接收端 | 有界内存与最多 64 KiB/7 天补报；不能影响 app ready |

## Must-Preserve Invariants

原 SQL/checksum/账本不变；准备库路径等于业务库路径；单库原子提交；Host 必需修复完成后才 ready；
新用户无工作区不绕过；失败不建空库；未知错误不伪装 FULL/OOM；遥测不阻塞准备；
多窗口/独立 CLI 用 SQLite 互斥；远端 identity、shared-host、continuous/replayable 不变。
证明入口为 Todo 145 GLOBALDB-01～26，全部待新实现验证。

## Codegraph Evidence

当前可调用工具中没有 codegraph，**未执行 codegraph 自动影响面扫描**。本轮用语义图声明与精确源码阅读替代，未声称完成 depth-2/3 静态调用图证明。

| 种子 | 已核对直接链路 | 深度/解释 |
| --- | --- | --- |
| createWindow / spawnHostProcess | dom-ready、环境预算、ServicePort、已有 Host 重挂 | 人工局部链路；不是全量索引结果 |
| renderer Root / useStorageStartup | 业务端口后挂载、workspace 才触发准备 | 旧接入与新产品目标冲突 |
| Repo ensureReady / runTasksDatabaseMigrations | mkdir → DatabaseSync → WAL/迁移 → 后置修复 | 同一库多个入口须统一 |
| openStartupSessionStore | getSessionDbPath → openStartup → 迁移进度 | 真实 config 路径须贯穿新入口 |
| ARMS custom/reporter | 最终 payload 捕获 → void sendCustom → fetch | 原发送捕获不能证明网络送达 |

## Graph Drift Candidates / Graph Delta

已确认的产品语义：全局数据库准备先于业务 Root/工作区恢复，Host 初始化在本次范围；图谱仍主要描述 active-workspace 启动。
本轮在既有启动 capability 增补 alias、当前 TODO/审查文档和已存在的 Host/renderer/Repo/错误/遥测代码种子，保留节点 ID，不把尚未实现的协调器写成当前代码。
图谱其余无关漂移不修复；完整图和 seed 的检查结果在本轮验证记录中注明，旧悬空边不算新增。

## Unresolved Questions / 技术落地前置项

没有需要用户再次确认的产品范围问题。以下是已授权范围内 A 阶段必须完成的设计任务，不能跳过后直接改 UI：

| 任务 | 选择边界 | 完成证据 |
| --- | --- | --- |
| Host SQLite 执行与后置修复 | 优先 Host 所属 Worker；迁移结果复用，Repo 重新打开不重复重型初始化 | 具体生命周期/依赖图与幂等测试入口 |
| 无 workspace 会话库准备 | Agent 原存储入口；实际配置与随后 runtime 一致，不构造假 workspace | 配置优先级、命令/协议、连接关闭合同 |
| 启动通道与重试 | 业务服务发布前可观察；快照+订阅，旧 attempt 失效 | 协议/schema 与时序测试设计 |
| 遥测接收确认与补报 | SDK 最小修复或受支持出口，不临时旁路 | 打包版本/补丁审计、HTTP 接收合同、失败测试 |
| 所需物理库清单 | 已确认 tasks-index 与 session；核对其他必需存储 | 每项路径/消费者/就绪条件/排除原因 |

若源码审计证明必须改变这些产品边界，再带具体原因沟通；不因例行技术选择重复索要授权。

## Clarification Log / Boundary Decisions

| 用户决定 | 已固定边界 |
| --- | --- |
| 不改迁移脚本 | 不做优化/batch/checksum 分支 |
| 主界面前 loading，包含 Host | 重做启动编排，旧 workspace UI 撤掉 |
| 低负担、只看有意义的峰值 | 2 秒单个 statfs 在途，只汇总观测空间最大下降，不能声称零 IO |
| 失败也能诊断、提醒磁盘不足 | 明确 FULL/ENOSPC/EDQUOT 映射；安全提示与 ARMS 同源；有限可靠补报 |

## Domain Scope / Dimensions / High-Risk Cross-Products

4 个主领域：启动进程边界、持久化迁移、跨端展示/恢复、遥测。形式枚举器当前聚焦对话 turn，不适用于直接证明此启动流程；本轮使用表驱动场景，不运行形式证明工具。
维度：新/旧/部分/已迁库 × checking/waiting/migrating/committing/post-init/service-ready × 本地/远端/手机 × 失败类别 × 原因是否可确认 × 同/异物理库 × 采样/网络可用性。
高风险组合：Host 已提交+会话失败；COMMIT 失败+清理再失败；FULL+采样仍有剩余；Worker/Host 崩溃+旧快照；多窗口+同库；APFS 多卷+重复计数；离线+磁盘满+补报失败。

## Candidate Combinations / Pruning Decisions

| 决定 | 状态 | 理由/覆盖 |
| --- | --- | --- |
| Todo GLOBALDB-01～26 | accepted | 用户已确定目标与边界；详细 setup/action/assertion 见 TODO 场景 |
| 旧 workspace 触发全局 loading、一般 IOERR 提示磁盘满 | bug-candidate | 新启动与错误合同不允许；02/03/24 |
| 迁移未完进入正常业务、超时自动跳过、删账本重试 | pruned | 原子与准入不变量 |
| 所有历史远端一起准备、手机另起 Agent | pruned | 远端连接及 shared-host 边界；15/16 |
| 所有 OS × 所有错误 × 所有主题全排列 | pruned | 错误单测+代表 UI/平台案例，避免重复组合 |
| 20 GB 性能、精确瞬时磁盘峰值、永久离线必达 | ignored/明确排除 | 暂无测量授权或不可能保证，不伪造通过 |

## Accepted Cases / Planning Handoff / Matrix Backfill

| 交付 | 落点 | 状态 |
| --- | --- | --- |
| 当前产品要求、错误映射、26 个场景 | Todo 145 | 文档完成，测试未执行 |
| 实现 spec | database-migration-startup-gate-plan.md | A 阶段重写；旧版仅保留历史引用 |
| case catalog / coverage matrix | conversation-session-case-catalog.md / testing/conversation-session-e2e-coverage-matrix.md | 本轮补 GLOBALDB planned 入口；旧 DBSTART 保留历史 |
| 决策与影响面 | 本文 | 人工源码审查完成，codegraph 不可用 |
| E2E handoff | e2e-case-lifecycle | planned；先 spec，再先写测试，后改代码 |

E2E 使用隔离 HOME/数据目录、冻结旧库、阶段 latch/锁 owner/COMMIT barrier；不靠 sleep 猜时序。
空间不足以真实 SQLite 容量上限和错误注入验证分类，不填满用户磁盘；无模型请求，必要业务验证沿 case-local replay。
需补可运行的桌面环境（此前 Electron 在用例前崩溃）、Windows/macOS 打包 Worker/子进程、手机及远端验证。它们是发布门槛，不阻止先进行 A 阶段设计和单测实现。

## 本轮文档校验

`pnpm typecheck`、`pnpm lint`、`git diff --check` 通过。图谱 YAML 可解析，节点 ID 唯一，启动 capability 的文档/文件/符号文本 seed 校验通过；既有 4 条悬空边未增加。符号文本存在不等于 codegraph 索引或完整调用分析；没有自动 codegraph 工具，因此保留人工审查限制。
本轮无产品代码变更，未运行迁移、磁盘性能或 UI E2E；没有把 26 个 planned 场景标成测试通过。
