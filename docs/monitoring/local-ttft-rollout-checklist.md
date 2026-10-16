# 本地 TTFT 上线与 ARMS 验收清单

Status: in-progress

[父合同](ttft-stage-telemetry.md) · [查询与诊断合同](local-ttft-queries.md) · [看板模板](dashboards/local-ttft.json) · [怎么读一条 Trace](local-ttft-trace-reading.md) · [平台验收证据](local-ttft-platform-evidence.json) · [Ticket 01](../issues/ttft-stage-telemetry/01-local-send-stage-observability.md) · [Ticket 02](../issues/ttft-stage-telemetry/02-queued-retry-and-failure-diagnostics.md)

本文只覆盖"埋点已实现"之后的部署动作：把数据打通到北京 ARMS、完成平台验收、开灰度、核容量与费用。埋点合同本身见父合同，查询口径见查询合同。

**2026-09-15：阶段 0 已完成**，新 service `zcode-local-ttft` 的 Trace 与 Metric 在北京 ARMS 可查，分位数、瀑布关联、标签与诊断口径全部核对通过，实测数据见 [local-ttft-platform-evidence.json](local-ttft-platform-evidence.json)。本地 OTLP 证据见 [local-ttft-evidence.json](local-ttft-evidence.json)、[local-ttft-diagnostics-evidence.json](local-ttft-diagnostics-evidence.json)。阶段 1~3 仍未完成。

## 现状

| 门       | 现状                                                                                                                                                                                            | 由谁打开                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 写入地址 | 接入点已验证可写（同一 base 收 traces 与 metrics）。桌面 main 的 metrics reader 在没有 endpoint 时不创建（`packages/desktop/src/main/localTtftExporter.ts:46`），打包版靠构建期注入，该路径未验 | 阶段 1                                                             |
| 灰度开关 | `rendererActionTrace.localTtftEnabled` 缺省 false（`packages/shared/src/rendererActionTrace.ts:21`）                                                                                            | 阶段 2：服务端 `/api/v1/client/configs` 下发；单机可用环境变量强开 |
| 平台验收 | 已完成：查询、瀑布、标签、入库时延均核对通过；控制台界面目视与保留期/费用未做                                                                                                                   | 阶段 3                                                             |

灰度开关与旧 Renderer/Agent Trace 的 `enabled`、`sampleRatio` 相互独立，只开 TTFT 不改变旧 Trace 的采样与父子归属。

## 阶段 0：本机直连真实 ARMS，完成平台验收（2026-09-15 已完成）

平台验收不依赖 CI 与灰度下发；本机 dev 直连即可解掉 Ticket 01/02 的平台项。

- [x] 取现有 `zcode-cli-agent` 在用的那对接入值（CI 变量 `ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT` / `ZCODE_PACKAGED_AGENT_OTEL_HEADERS`）。写入密钥不进看板、不进本仓库文档。
- [x] **确认该 endpoint 是 OTLP base。** 实测 base 为 `/apm/trace/opentelemetry`；`base + /v1/traces` 与 `base + /v1/metrics` 都返回 200，独立的 `/apm/metric/opentelemetry/v1/metrics` 反而是 404。原先担心的"base 里带 trace 段导致 metrics 打到不存在的 URL"不成立，`packages/desktop/src/main/localTtftExporter.ts:31` 的拼接可用。
- [x] 确认后端同一接入点接受 metrics signal。**结论：接受**，因此不需要给桌面 main 增加独立 metrics endpoint 注入通道（注入白名单 `packages/desktop/src/main/desktopRuntimeEnv.ts:216` 保持现状即可）。
- [x] 用真实运行产生受控样本。实际用两个真实 E2E（`conversation-session-ttft-stages` 跑 2 次，各 3/3 通过；`conversation-session-ttft-diagnostics` 6/6 通过），共 12 次发送；出口按线上形态只设 base endpoint，未单独设置 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`。转发 85 次全部 200，无失败。
- [x] Trace 验收：`service.name = zcode-local-ttft` 可查（此前为 0）；`observation_id` 去连字符确实等于 traceID；单条发送 62 个 span，根 701.70ms 与六个主阶段并集 701.69ms 对账一致，`unattributed_ms=0` 得到印证；`local_ttft.checkpoint`、`.start`、`.first_text` 与根同属一条 Trace；`.started` 点记录 duration 为 0。
- [x] 核对指标实际序列名：**不追加单位后缀**，查询合同里的 `zcode_local_ttft_*` 默认名成立。
- [x] 跑总 P50/P95、阶段 P95、准备子阶段 P95 与配套 `_count`，DELTA + `sum_over_time` 口径成立。阶段样本数 18 = 3 次发送 × 6 阶段，未被 attempt 放大。
- [x] 诊断口径（Ticket 02）：`records` 按 kind 齐全（start 16 / first_output 12 / first_text 12 / excluded 4 / checkpoint 442）；`excluded` 区分 cancelled / failed / guided；`attempt` 按 role+outcome 区分失败重试与首输出；`no_output.wait` 记录 cancelled 与 failed；`preparation` 覆盖 context / hooks / persistence / mcp / tools / request_assembly / user_confirmation / retry_wait。
- [x] 标签为受控低基数（app_version、os、provider、model、quality、send_mode、visibility、stage、role、outcome、kind），未发现关联 ID 泄漏进指标标签。
- [x] 记录入库可见时延：第二次 run 结束瞬间开始轮询，Trace 与 Metric 首次轮询即命中（上界 <5s）。这是"结束时已可见"的上界，不是逐条精确时延。
- [x] 把结果写回 Ticket 01 与 Ticket 02 的平台验收项，本地测试与平台验收分开记录。
- [ ] **仍未做**：在 ARMS/Trace Explorer 控制台界面上目视确认瀑布渲染与跳转。本次全部通过只读 API 核对数据完整性，界面确认需要登录控制台。

验收细节与全部查询返回值见 [local-ttft-platform-evidence.json](local-ttft-platform-evidence.json)。

副作用：本次向生产遥测库写入 12 次发送的受控样本，可按 `provider="e2e-deepseek"`、`model="deepseek-v4-flash"` 识别排除，这两个标签不会出现在真实用户样本中。

## 阶段 1：让打包版带上写入配置

需要 CI 变量权限（发布/CI owner）。

- [ ] 确认 CI 变量在目标构建上可用。`resolveBuildPackagedAgentTelemetryEnv`（`packages/desktop/tsup.config.ts:84`）要求 endpoint 与 headers 成对出现、生产必须 HTTPS，release 分支/tag 缺失会直接让构建失败。变量到位时桌面 main 自动获得 metrics 出口，**不需要新增构建配置**。
- [ ] 出一个 dev/preview 包，从 Finder / 开始菜单启动验证一次。安装包启动时没有 shell 环境变量，历史上 Agent 因此静默落入 Noop，注释见 `packages/desktop/src/main/desktopRuntimeEnv.ts:213`。这是阶段 0 唯一没覆盖到的写入路径：阶段 0 走的是运行时 env 注入。
- [x] ~~若阶段 0 发现 metrics 需要独立接入点，先完成注入通道改动再打包。~~ 阶段 0 已确认同一 base 收 metrics，无需改动。

## 阶段 2：开灰度

- [ ] 服务端 `GET /api/v1/client/configs` 返回 `data.configs.rendererActionTrace.localTtftEnabled = true`（解析见 `packages/desktop/src/main/rendererActionTraceRollout.ts:53`）。请求携带 `app_version` 与 `platform`，可按版本/平台圈人。
- [ ] 从小人群起步。灰度内是有界全量采集、不主动抽样，先按阶段 3 观察量再扩。
- [ ] 内部验证用 `ZCODE_LOCAL_TTFT_ENABLED=1` 单机强开（`packages/desktop/src/main/rendererActionTraceIpc.ts:123`），不动线上配置。
- [ ] 确认开灰度后旧业务 completion、RUM TTFT 与发送漏斗的计数口径没有变化。

## 阶段 3：容量、费用与保留期

扩大灰度前的门槛，全部需要在 ARMS 上核实，文档里的估算不能替代。

- [ ] 序列量：10 Histogram + 2 Counter，15 个显式桶 + `+Inf` + sum/count，理论上限约 46,592 条序列/同资源组。另需检查后端资源标签映射与是否产生 overflow 序列。
- [ ] cardinality 未顶上限：每个 instrument 上限 256、provider/model 最多 16 组（`packages/desktop/src/main/localTtftExporter.ts:71`）。顶到上限会归入 `other`，等于丢失区分度。
- [ ] `zcode.local_ttft.dropped` 在线上为 0；非 0 说明队列或容量边界需要调整，按 reason 区分队列满、去重容量、传输超时与截断。
- [ ] 保留期达到目标：明细 7 天、聚合 ≥30 天，并给出实际费用估算。该项在父合同中标为待核验的部署条件。

## 阶段 4：看板落地

- [ ] 导入 [dashboards/local-ttft.json](dashboards/local-ttft.json)，用阶段 0 核对到的真实指标名替换 `total_metric` / `stage_metric` 变量。
- [ ] 默认体验视图带 `quality="complete"` 与 `visibility="foreground"`；`missing`、`clock_invalid` 与 observation 系列只进诊断视图。observation 系列的标签是该阶段观察当时的状态，不代表消息最终持续前台，混入会污染默认分布。
- [ ] 每张分位数图配同过滤、同时间窗的 `_count`。不相加 P95，也不用总 P95 减模型 P95 推导阶段。

## 本地复现入口

不接真实 ARMS 时的本地出口验证走 [查询合同的本地复现](local-ttft-queries.md#本地复现)：先起 `packages/desktop/scripts/ttft-otlp-receiver.mjs`（仅监听 localhost:14318），再跑 `conversation-session-ttft-stages` / `conversation-session-ttft-diagnostics` 两个候选用例。这条路径只证明最终 OTLP 出口合同，不构成平台验收。

## 未纳入本清单

- 桌面远程工作区、手机与 Web 远控的 TTFT 采集（父合同 Out of Scope）。
- Ticket 01 记录的 CLI 全量单测未通过项（442 文件通过 / 76 文件失败，失败未逐项归因，受影响 gateway 的 stale 场景在开工 HEAD 同样失败）。不阻塞平台验收，但主张整体完成前需单独交代。
- Windows / Linux 实机与手机远控 E2E 运行证据。
