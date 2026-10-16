# 进程资源遥测复审修复：影响与验证

## Feature Summary

2026-09-15，基于 `3e6ac3d643` 修复 R1–R7、N1/N2。模式为 planning / implementation；
改动层为 validation、commit-effect，瞬时内存分组与去重不属于 task 持久化或 recovery。
行为契约见 [主 spec](./process-resource-telemetry.md#复审修复契约2026-09-15)。
范围外：UI 提示、版本号硬门槛、RPC 框架重构、任务/队列/恢复协议、线上 ARMS 配置。

## UI Surface Matrix

| 场景 / 入口 | 共享实现与权威 owner | 校验与副作用 | 模式 / 隔离 |
| --- | --- | --- | --- |
| 桌面连接独立 Server | connectServerRemote → Host connection handle | server-info 能力决定旁路订阅 | 无能力仍连接；不改变 workspace 草稿或任务 |
| 桌面本地及 SSH/WSL/Docker | Host services → main 遥测出口 | 配套进程维持订阅 | 不改对应 UI、运行态或 settings |
| 多窗口同 Server Bash | CLI 单命令 owner → main | 完成标识校验、有界去重、ARMS 投影 | 不因连接数增加事件数 |
| 手机远控 attachment | Agent connection scope | 遥测事件保持空 | continuous/replayable 恢复语义不变 |

## Shared And Divergent Behavior

UI、候选项、默认值、持久化均无改动。共享 Host 转发与 main 出口；Server 仅在明确支持能力时
订阅，本地及配套部署路径保持既有能力。跨环境分别聚合，同环境多实例合计；缺新字段兼容旧生产者。

## Feature Relationships / State Owners And Commit Sinks

| 级别 | 链路 / owner | 原因与依据 |
| --- | --- | --- |
| must-inspect | shared server-info → 两种 Server → Host helper/index | 新能力的声明、解析与订阅门禁须一致 |
| must-inspect | CLI Bash owner → shared protocol → services/Host → main | completionToken 在 fan-out 前生成，在唯一出口去重 |
| must-inspect | Host 环境身份 → CLI/MCP 来源 → window aggregator | 隔离 key 贯穿，白名单投影不泄露身份 |
| must-inspect | CLI source → external app totals | 到达时刻属于原读数；交付不能延长有效期 |
| should-inspect | Host self heap / renderer heap | 同 tick 最大值与交付清空规则一致 |
| invariant-only | terminal attachment / task realtime / CommandInbox | 无新会话订阅、队列、snapshot 或 replay 状态 |
| evidence-only | telemetry tests / CI guard | 用触发场景断言验证契约，测试通过不外推实机 |

## Must-Preserve Invariants

- 一台运行环境的 CPU/RSS 只在自己的分组内相加；硬件规格不是身份。
- 样本过期基于实际接收时间；定时器不产生新的读数事实。
- 完成标识、环境身份仅用于旁路内存；事件属性白名单、20 属性限制不变。
- main 无外部采样进程；没有新增周期定时器、磁盘队列或持久化。
- 遥测异常不影响 Bash 完成、远端连接和桌面/手机任务交付。

## Codegraph Evidence

当前工具集无 codegraph，未执行 codegraph 影响扫描。以已固定 diff、直接调用搜索及架构 context
替代，深度约两层：registerHostServiceResourceTelemetry 的 local/remote 入口、
ingestCliResourceSample / ingestMcpResourceSamples 的 Host main 分发、
ingestToolExecResource 的协议生产者与白名单出口。未将所有静态可达节点视为产品影响。

## Graph Drift Candidates / Graph Delta

遥测 capability 的文档列表缺少主 process-resource spec；补该入口及环境隔离、完成标识不出网
不变量。现有 UI surface 和 task state owner 不变。

## Unresolved Questions / Clarification Log

无阻碍本次修复的问题。用户已授权逐项修复；采用现有“一条事件描述一个运行环境”契约，
旧 Server 能力缺省时保留连接。UI 提示或要求旧 Server 升级不属于必要修复。

## Planning Handoff / Accepted Cases

| Case | 设置与动作 | 断言 | 证据 / 状态 |
| --- | --- | --- | --- |
| PRT-031 | 旧/新 server-info，建立 Host 遥测订阅 | 缺能力无订阅且服务端存活；有能力四条旁路正常 | schema / Host / localhost WS 集成通过；旧 Core 探针 exit 0 |
| PRT-032 | 同一完成标识经不同 Host 重复到达；相同指标不同标识 | 前者一次、后者分别上报；集合有界且重置清空 | 协议 / CLI / main 回归通过；上限与 reset 已验证 |
| PRT-033 | chat/aux 错相位，aux 停更，周期与退出 flush | 按组新读数交付；旧读数两个周期后退出总量 | 受控时钟回归通过，含同组实例到期和 CLI/MCP 预算 |
| PRT-034 | 同规格不同环境及同环境多实例，CLI 与 MCP | 不跨环境相加；同环境合计；最终属性无身份 | Host / source / window / 出口回归通过 |
| PRT-035 | 同 tick 两 Host heap 高→低、低→高 | 最大值一致，下一 tick 不重交 | selfHeap / 集成回归通过 |
| PRT-036 | 实际来源路径、禁用调用与豁免 | 全部受保护，合法按需采样豁免仍有效 | guard / repo hygiene 通过，73 文件 / 2 项生效豁免 |
| PRT-037 | 正则内反引号、字符类、除法、注释及模板 | 真调用命中，真注释忽略，整仓无状态漂移 | guard 31 项回归通过，含真实稳定性源码 |

## Dimensions / Pruning / Matrix Backfill

高风险组合为 Server 能力 × 连接、实例 × 环境、读数相位 × 到期、Bash 完成 × 多 Host。
主题/语言/屏幕尺寸因无 UI 改动剪枝；任务 stream/snapshot 因旁路被 attachment 隔离而只验证不变量。
主 spec 同步新增字段的兼容、隐私及混装验收，旧测试文件按上述 case 补触发条件。
E2E 以现有资源角色用例为入口，新增旁路去重/环境分组验证；不需要模型供应商录制。

## 验证记录

实施前 freshness、实施后 architecture:check --changed 均通过，无新增架构违规。

- 应用侧定向 Vitest：24 文件 / 268 项通过；随后补同组过期和来源预算回归，相关 3 文件 / 39 项通过；
  shared 事件白名单与文档契约另 10 项通过。测试先失败后实现，未将旧断言改成错误行为。
- CLI Bash 遥测与真实生命周期：2 文件 / 16 项通过；协议完成标识的旧/新输入兼容已验证。
- pnpm typecheck、pnpm lint 与 desktop typecheck:e2e 通过；根 lint 为 0 error / 43 条既有 warning。
- 门禁及 repo hygiene：73 个实际跟踪文件，0 违规，2 项生效豁免；graph YAML 解析、节点 ID 唯一性及
  本次 capability 的文档/代码种子存在性检查通过。codegraph 工具不可用，未声称完成其索引扫描。
- CLI 包额外全量检查未通过：55 项固定 HEAD 已有接口/fixture/迁移预期不一致，另 1 个 suite 导入
  已删除模块；8 项并发失败在串行复验时通过，负载根因未确认。相关代码与基线逐字核对，本次 UUID
  逻辑未进入这些失败路径。包 lint 的 26 项 max-lines 错误均位于未改文件，本次 Bash 源定向 lint 通过。
- 首次 Electron 冒烟因并行 typecheck 覆盖 out/host bundle 而在 Host 启动阶段失败；隔离 utilityProcess
  复现 ERR_MODULE_NOT_FOUND。串行完整重建后 PRT-023 通过：1 spec / 1 case，退出码 0，验证真实
  main / renderer / Host 与系统事件。报告位于
  `packages/desktop/.e2e-artifacts/desktop-e2e-20260915105255962-p18104-75dc094004a00c1b/summary.md`。

R3 实施中补齐了原候选遗漏：设备总量改为按实例原始到达时刻更新，避免同组另一个活跃实例续存
已退出进程。外部缓存预算从 64 调整为 128，保留原有 MCP 空间并容纳 64 个 CLI 实例，仍无新定时器。
R2 采用 CLI 随机完成标识 + main 唯一出口去重，覆盖跨 window Host；未采用仍留下跨窗口重复的
单 Host 引用计数方案。

回滚可撤销本修复提交；仅回滚 main 会失去去重/环境隔离，旧 strict consumer 也会丢弃新 CLI 字段，
需要按同版本应用包回滚。无持久化格式或数据库迁移。真实 Windows/Linux、SSH/WSL/Docker 与完整
旧 Server Desktop E2E 仍未验证，不以 mock 或 localhost 模块探针代替实机结论。

## PRT-031：Desktop 连接旧 Server 的 E2E 边界

已接受的真实 Desktop 案例：在隔离 localhost 启动固定旧版独立 Server，从现有 preload
`window.zcode.connectRemote` 发起连接，经过 Main → Window Host → `host/index.ts` 的正式能力门禁。
旧 server-info 缺少资源能力时，不发送这组遥测订阅；Server 持续存活，连接成功返回 sessionId，
既有业务 RPC 可用，最后通过正式 disposeRemoteSession 回收。本例不发送模型请求。

当前状态为 **待现成旧版 Server fixture，未新增 pending spec、未执行该 Desktop 远端 E2E**。
仓库现有 E2E 没有可直接复用的 localhost 旧版独立 Server 夹具。正式连接在资源门禁之后还必须
完成 Provider Provisioning 的 initialSync 和 renderer attachment；只暴露旧遥测事件面的窄桩
不足以完成这些步骤。后续 provisioning 失败不能计作“连接成功”，也不能证明完整 Desktop 路径。
为本次回归临时复制旧 Core/业务服务或新增生产测试后门，会超出该用例的必要边界，因此未引入。

目前已通过的证据包括：`serverRemoteConnection.test.ts` 的真实 localhost WebSocket 集成测试
（能力缺失时跳过订阅、业务 RPC 继续可用；能力为 true 时正常转发），以及固定基准旧 Core 的
隔离 WebSocket 探针。前者通过真实 connector/RPC/helper 验证能力语义，但门禁参数由测试传入，
没有执行打包 Desktop 的 `host/index.ts`；后者同样不包含真实 Desktop。它们均不替代上述 E2E。
既有 `process-resource-telemetry-roles.test.ts` 可验证本地真实 Electron 资源上报，覆盖范围也不含
旧独立 Server 连接。

后续最小前置条件是提供固定版本、可在独立测试 HOME/cwd 启动并正确关闭的完整旧 Server 资产，
保留该版本的真实 server-info、RPC 事件面和 Provider Provisioning 实现。届时再将 PRT-031 写入
`packages/desktop/test/e2e/manual-review/pending/`，复用现有 Desktop 初始化和正式连接/释放接口，
经实际运行及人工审阅后再决定晋升。
