# 01 — 普通发送的 TTFT 阶段指标与瀑布图

**What to build:** 桌面本地工作区在持续前台、空闲发送且无需重试时，性能分析人员能够查看从点击发送到首有效输出的完整主阶段耗时、P50/P95 和单消息瀑布图。正文、思考、工具调用先到均能正确收口，首正文耗时另行记录。此 ticket 贯穿真实发送、跨进程关联、阶段采集、最终 OTLP 导出、查询和 E2E，完成后可独立演示和验收。

**Blocked by:** None — can start immediately.

**Status:** in-progress

**Parent:** [桌面本地消息 TTFT 分阶段遥测](../../monitoring/ttft-stage-telemetry.md)

## 验收标准

- [x] 明确本 ticket 的支持样本：桌面本地、持续前台、空闲发送、无重试。尚不支持的排队、立即引导、失败取消等路径有明确分类和有界清理，不把已有输出或残缺数据作为普通成功样本；其完整诊断由 ticket 02 补齐。
- [x] 真实点击发送或 Enter 提交通过门禁后建立稳定观测关联，贯穿 Renderer、窗口 Local Host、CLI 和实际会话内容回传。共享协议采用严格类型和运行时校验，保持旧调用兼容；Host 不增加第二份业务队列，Main 不承载 task 业务状态。
- [x] 同一条发送的观测关联能够定位 command/input/query、turn 和模型请求；输出早于 ACK 仍可正确归属，合法乱序和重复不会造成重复主 TTFT 或重复 Metric。独立会话、工作区和进程实例之间不串线。
- [x] 完整记录六个主阶段：Renderer 发送准备、命令传递与 CLI 受理、等待执行、执行与请求准备、模型请求、首输出回传。CLI 收到命令到获得 admission gate 的等待不能遗漏；ACK 往返与执行可能并行，不重复累计。
- [x] 请求准备先作为一个完整主阶段记录，其内部 hooks、持久化、压缩及 MCP 等细分归因由 ticket 02 展开。本 ticket 的主阶段不能因子阶段尚未展开而缺失准备耗时，也不能把内部压缩模型请求误认为主响应的首输出。
- [x] 首输出来自发起 Renderer 的实际内容接收，接受非空可展示正文、思考或工具调用，记录 first_output_kind；空 block/start、心跳、状态通知及旁路 telemetry 通知均不触发首输出。旧轮次和子任务旁路内容不抢占本条输入的首响应。
- [x] 首输出到达即完成主 TTFT 并进入异步导出，不等待整轮 terminal；继续轻量观察首正文，晚到正文另报耗时，无正文结束有独立状态，后续错误不反转已经成立的首输出结果。
- [x] 端到端使用发起 Renderer 的同一时钟，各进程内部使用单调时钟。跨进程对齐误差有实测结果和可执行阈值，短阶段可区分几十毫秒量级；无效或不可靠区间不得靠钳零伪装为有效值。
- [x] Trace 保留真实阶段 interval 与因果关系，主阶段按实际时间线对账；重叠不重复相加，缺失和未归因区间可见，未执行阶段不填零。模型服务内部网络、排队和推理不做无事实支撑的拆分。
- [x] 同一份阶段事实生成专用 OTel Metric 与 Trace，复用已有 OTLP 导出设施。主 TTFT 以一次发送为统计单位；模型 attempt 或阶段的重复记录不能放大消息样本数。
- [x] 为短阶段配置专用毫秒级 Histogram 分桶，查询显示样本数和分桶精度，并提供总 TTFT 与各主阶段 P50/P95。不得相加分位数或用总 P95 减去模型 P95 推算阶段。
- [x] 提供基础 ARMS 查询和看板配置，可按阶段、模型/provider、应用版本和操作系统使用受控组合筛选，并通过关联 ID 查看单消息瀑布图。高基数消息、Trace 或工作区标识不进入 Metric labels。
- [x] 灰度启用决策全链路一致；启用人群的有界 TTFT 明细不主动抽样，不依赖旧 CLI 10% Trace 或 Renderer 独立抽样。关闭时不启动新采集；不改变旧 Agent Trace 的父子归属或采样范围。
- [x] 阶段记录、内存与导出队列有界；导出超时、拒绝或队列满不阻塞用户发送与输出，丢弃和截断可观察。无逐 token 网络上报，不采正文、文件内容、原始路径、凭据或请求 Header/Body。
- [x] 桌面仍走 desktop-continuous，远程工作区、手机/Web、历史 hydration、replayable 恢复及自动任务不生成本地用户 TTFT；旧业务事件、RUM TTFT 和发送漏斗的口径与计数保持不变。
- [x] 先编写“真实桌面 Composer 发送 → 最终 OTLP 接收器解码结果”的 E2E，再实现链路。复用现有对话回放与 OTLP HTTP 接收器组织方式，检查最终 Trace/Metric，而非只验证内部函数调用。
- [x] E2E 覆盖正文、思考和工具先到、空开始事件、首正文晚到、首输出早于 ACK，以及在主阶段注入已知延迟后的归因；底层测试只补充难以稳定复现的时钟、去重和协议边界。
- [x] 用受控样本验证 ARMS 基础分位数和单消息关联展示，保存真实运行或测试导出证据；平台验收与本地测试分开记录。2026-09-15 完成：新 service 已入库，总 P50/阶段 P95 可查，`observation_id` 去连字符等于 traceID，单条 62 span 的六阶段并集与根时长对账一致。证据见 [platform-evidence](../../monitoring/local-ttft-platform-evidence.json)。控制台界面瀑布目视确认仍未做。
- [ ] 完成相关 E2E/单测、类型检查、lint、架构门禁，留下阶段合同、时钟误差、分桶和数据量上限的说明。若需要小范围预重构，在接线前完成且保持现有行为，不另起宽泛重构任务。

## 范围交接

主链路的协议、关联、计时质量、导出和最终出口测试能力在本 ticket 内形成可复用边界。[Ticket 02](02-queued-retry-and-failure-diagnostics.md) 在同一合同上展开准备子阶段、支持排队重试和异常场景，并完成完整诊断看板与灰度上线验收。

两者共同实现父 spec；本 ticket 的窄场景支持不表示已经完成整个需求，也不扩大到桌面远程或手机远控。

## 实施与验证（2026-09-14）

本地实现与查询配置已完成；平台最终验收、全量 CLI 验证仍未完成，因此保持 in-progress。

- [阶段合同与查询](../../monitoring/local-ttft-queries.md)、[看板配置](../../monitoring/dashboards/local-ttft.json)、[最终 OTLP 证据](../../monitoring/local-ttft-evidence.json)。
- 真实桌面 E2E 3/3 通过：正文、思考、工具先到；空开始；晚到正文；内容早于 ACK；命令与模型已知延迟归因。主 TTFT 与六阶段 Histogram 各有 3 个样本，无逐 attempt 放大。
- 最终运行时钟误差上界 3.125 ms，小于 10 ms 阈值。正常正文、思考和工具三类均 quality=complete；不把失焦运行混入成功样本。
- 根级全量单测 1707 文件通过，14991 条通过，14 条跳过；根级 typecheck、E2E typecheck、lint 和 architecture gate 通过。
- CLI 全量直接 Vitest：442 文件通过、76 文件失败；5872 条通过、187 条失败。默认 turbo 入口在本环境缺失。不能宣称 CLI 全量通过；失败未逐项归因。本次受影响 gateway 的 stale 场景在开工 HEAD 同样失败，已通过隔离源码加载复现；oversize 单跑通过（2.91 秒），全量时曾受 5 秒测试预算影响。
- 额外 Desktop 全工程 tsc 发现既有 rootDir/global declaration 等错误；新增 exporter 单独 strict typecheck 通过。
- 当前 ARMS 北京项目可只读查询既有 ZCode Trace/Metric，SLS SQL+PromQL 查询已验证。新 service 样本仍为 0，本机未配置目标 OTLP 写入 endpoint/headers；未验证新样本入库、实际瀑布跳转及平台保留策略。
- 测试仍为 manual-review/pending 候选，未自行转正或加入 Docker suite；本次没有 Windows/Linux 实机与手机远控 E2E 运行证据。

## 平台验收（2026-09-15）

上一条记录的"新 service 样本为 0"已被取代：接入值取自 CI 变量后，两次 `conversation-session-ttft-stages`（各 3/3 通过）的样本写入北京 ARMS 并全部可查。

- 接入点形态：base `/apm/trace/opentelemetry` 同时接收 `/v1/traces` 与 `/v1/metrics`（均 200），独立 metric base 是 404。桌面 main 不需要新增 metrics endpoint 注入通道。
- 指标名不带单位后缀，查询合同默认名成立；DELTA + `sum_over_time` 口径成立。总 P50 1500ms、六个阶段 P95 齐全，阶段样本数 18 = 3 次发送 × 6 阶段（无 attempt 放大）。
- 单消息瀑布：`observation_id` 去连字符等于 traceID；62 个 span，根 701.70ms 与六阶段并集 701.69ms 对账一致，`unattributed_ms=0`、`clock_error_ms=5.02` 均在合同范围内。
- 明细与聚合在 run 结束时即可查（首次轮询命中，上界 <5s），非逐条精确测量。
- 未完成：控制台界面瀑布目视确认、打包版编译注入写入路径、保留期与费用。CLI 全量单测未通过项与 Windows/Linux 实机证据仍如上保留。

细节见[上线清单](../../monitoring/local-ttft-rollout-checklist.md)与[平台验收证据](../../monitoring/local-ttft-platform-evidence.json)。

## Standards

规范评审发现的遥测异常隔离、无效 Metrics URL 启动失败风险已修复；诊断回调也受到隔离。Metrics 独立 Header/endpoint 进入既有私有捕获与 tool env 清洗名单，凭据不传给工具。

## Spec

修复了执行准备边界偏晚、完整工具事件漏识别、未知 turn ID 补全被拒绝、terminal 过早清理、恢复样本误归类及失败误标 retry。执行入口单调时间经 raw TurnStarted 只供新 TTFT 消费，不扩展旧 strict telemetry fact。平台与全量 CLI 未完成项如上保留。

- 额外 coverage audit 未通过：既有 D19/I74/I75 自动化引用、统计与生成决策文档陈旧；本次 pending fixture metadata 为 0 rejected，专用 fixture check 通过。未在本任务重写无关 case 统计或决策文档。

校准工作区隔离回归已修复：clock-only 请求不占用 Host 业务查询 workspace 绑定，并在协议层拒绝 session command 查询。
