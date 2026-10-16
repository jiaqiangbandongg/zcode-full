# Case Catalog → 黄金测试映射（M0 素材）

把 [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 的产品 case 按**证明手段**分层，作为 M2 黄金测试集的选题依据。产品语义来源不变（仍是 catalog / product-protocol），变的只是证据类型：大部分 case 从「必须开 GUI 断言」下沉为「事件序列进、投影断言出」的 reducer 纯函数测试。

## 分层判据

| 层 | 判据 | 形态 |
| --- | --- | --- |
| **L1 reducer 黄金测试**（新增，主力） | case 的断言对象是投影内容：phase、queue、availability、rows 结构、marker、inputRouting | 构造事件/command 序列 → 跑 ProductProjection reducer → 断言投影；无 GUI、无网络、毫秒级、可全枚举 |
| **L2 协议/传输测试** | 断言对象是投递语义：snapshot 一致性、coalesce、profile、恢复 | 纯函数 + 模拟订阅者 |
| **L3 WDIO E2E**（保留，收窄） | 断言对象必须含真实 UI 交互或跨进程链路：按钮点击、弹窗、滚动、replay 网络 | 按 [11-deletion-plan](./11-deletion-plan.md) E2E 处置节奏重建，testid contract v2 |

原则：**每条 catalog case 至少有一层证据；L1 能证明的语义不重复消耗 L3 预算**，L3 只补「L1 证明不了的交互面」。coverage matrix 重建时证据列标注层别（`L1`/`L3` 或两者）。

## Catalog 分组映射

| 组 | 内容 | 主证据层 | 说明 |
| --- | --- | --- | --- |
| A 首发和运行中输入 | inputRouting 三分（startNow/enqueue/guide）、running fork | **L1** | 全部是「状态×输入→裁决」，formal-proof 枚举的核心区；L3 只留 1-2 条 composer 交互冒烟 |
| B Stop 和队列保留 | stop 后 phase/queue/autoDrain | **L1** | stop command → 投影断言；L3 补 stop 按钮态一条 |
| C Completed 成功态 | 完成后可用动作 | **L1** | availability 断言 |
| D Edit User Query | edit 重跑、row.removed 截断、editKeepsQueue | **L1** + L3 | 截断语义 L1；编辑交互动线 L3 |
| E Fork | 稳定性判定、child 不复制 queue/background、E10 merged assistant | **L1** + L3 | canFork 行级计算、child 投影内容 L1；E10 类跨 session 内容完整性配 replay L3 |
| F 手动 Compact | F01–F09（含已裁决 F09） | **L1** + L3 | marker 状态机、queue 保留 L1；F09 retry 入口点击 L3 |
| G 自动 Compact | G01–G12（含已裁决 G11/G12） | **L1** 为主 | retry/circuit breaker/pendingAction 去向全是 runtime 语义，L1 事件序列可精确构造「三连败」这类 L3 很难稳定复现的场景——**本组是下沉收益最大区** |
| H Goal | goal 状态机、verifier、queue 联动 | **L1** + L3 | 状态机 L1；`/goal` 输入动线 L3 |
| I 模型和思考深度 | config 作用域、N01–N07 交叉 | **L1** | switchModelConfig CAS + config 快照消费（含已裁决 N06） |
| J 多 Session 并发 | 会话隔离 | **L1** + L2 | 两个 reducer 实例互不影响 L1；订阅隔离 L2 |
| K 关键剪枝 | 9 条 reject 规则 | **L1** | 全部是 guard 断言，formal-proof 直接覆盖 |
| M Turn Steer | queue/guide 两模式、steerState | **L1** | QueueItem.steerState 投影断言 |
| N 模型切换交叉 | N01–N07 | **L1** | 同 I |
| O Tool Cross Product | 各工具 × compact/fork/goal | L1 + **L3** | 叉乘的状态语义 L1；工具 UI 展示复杂度（摘要/失败态/展开）是 L3 主场 |
| P Timeline 位置与折叠 | placement、折叠组 | **L1** + L3 | v4 下 placement 是 rows 全序 + turnHeader 的直接产物，L1 断言 rows 结构即可；折叠交互 L3 |
| Q AskUserQuestion 可见性 | pendingInteractions 生命周期 | **L1** + L3 | 出现/消失/先到先得 L1；弹窗交互 L3 |
| R Composer 草稿作用域 | draft 保留/切换 | **L3** | 纯客户端本地态（sessionKey 作用域），与投影无关，唯一以 L3 为主证据的组 |
| 环境故障 catalog（N/S/D/L/W/X 组） | 37 条 decision-needed | 裁决后分层 | fault 注入点在 provider/网络/fs，多数可在 reducer 层模拟错误事件（L1）+ replay 故障 fixture（L3）；X 组隔离断言进 L1（见 [12-fault-catalog](./12-fault-catalog.md) §3.4） |

## v4 新增的结构性黄金测试（不映射自 catalog，来自 design-review E-03）

这些证明的是**协议机制本身**，与产品 case 正交，全部 L1/L2：

1. **snapshot 原子性**：running 中任意水位 W 取 snapshot + 续流 ≡ 全量重放（R-03）。
2. **迟到终态不复活**：stop 后到达的 assistant/tool/verifier 终态被拒收（P1-5/P5-7 病例场景化）。
3. **provider 乱序整形**：tool_use 先于正文尾部、迟到 thought 包。
4. **profile 等价性**：同一事件序列跑 continuous/replayable 两档，终态逐字节一致。
5. **过滤收口**：被 profile 过滤的事件必被不可过滤事件收口（含 subagent summaryText）。
6. **重复/迟到帧静默丢弃**，重订阅替换旧订阅（R-01）。
7. **guard 与投影同源**：不存在「广播先于状态释放」窗口（P5-3）。
8. **formal-proof 全枚举 ↔ actionAvailability 一致**（02-projection 已列）。
9. **transcript 完备性**：`reduce(transcript) ≡ reduce(events)`（方案 B 的持久化验收，design-review §9.2）。
10. **fault 隔离**：任意 fault 注入 session A，session B 投影不变（12 §3.4）。

## 落地形态建议

- L1 测试与 reducer 同包（`apps/zcode-cli` 内），fixture 为**事件序列 JSON**——可从现有 e2e replay 轨迹中提取，也可手写最小序列；每条 catalog case id 出现在测试名中，供 coverage matrix 审计脚本对账。
- formal-proof 全枚举跑一个独立测试入口（组合量大，与逐 case 测试分开计时）。
- L3 重建时机在 M3 竖切之后（testid contract v2 就绪），选题以本表 L3 列为准，不再全量平移旧 52 个 spec。
