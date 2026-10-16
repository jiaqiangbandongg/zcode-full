# Conversation Session Environment Fault Catalog

目标：把会话区在外部环境异常下的状态空间单独列出来，避免把 429、503、断网、磁盘满、关闭 app 等故障混进 `A-J` 会话主路径。本文只做枚举和验证设计；除非已有产品协议明确确认，否则不擅自把结果标成 accepted。

关联文档：

- 主路径 catalog：[conversation-session-case-catalog.md](../conversation-session-case-catalog.md)
- 主路径覆盖矩阵：[conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)
- Fault 覆盖矩阵：[conversation-session-fault-e2e-coverage-matrix.md](./conversation-session-fault-e2e-coverage-matrix.md)
- SSE 录制回放协议：[e2e-sse-capture-replay.md](./e2e-sse-capture-replay.md)
- FS 故障注入协议：[e2e-fs-fault-injection.md](./e2e-fs-fault-injection.md)

## 枚举边界

无限空间继续用等价类收敛：

| 维度 | 等价类 |
| --- | --- |
| session.phase | `prewarming`、`running`、`compacting(manual)`、`compacting(auto)`、`completed(success)`、`completed(interrupted)` |
| queue.length | `0`、`1`、`2`、`3+` |
| active visibility | 当前 session 可见、当前 session 不可见但后台运行 |
| network phase | 请求未发出、已发出但无响应头、已有响应头但无 SSE event、已有部分 SSE event、compact streaming 主腿、compact non-stream fallback 腿 |
| retry count | `0`、`1`、`2`、`3+` |
| storage target | workspace 文件、session history、model provider settings、日志/artifact |
| app lifecycle | 切到其他 app、关闭窗口、退出 app、renderer reload/crash、host/agent crash、系统睡眠恢复 |

Review 状态：

| 状态 | 含义 |
| --- | --- |
| `decision-needed` | 产品预期未确认，不能写稳定 pass/fail 断言 |
| `accepted` | 产品预期已确认，可以写自动化 |
| `infra` | 测试基础设施行为，不是产品 case |
| `invalid` | 组合由前置规则剪掉 |
| `ignored` | 当前版本暂不覆盖 |

## 全局默认验收信号

这些不是替代产品定义的规则，而是每条 fault case 都要采集的证据层：

| 证据层 | 必看信号 |
| --- | --- |
| UI | `TID_CHAT_VIEW` 的 `data-state`、`data-runtime-status`、`data-queue-count`、错误条/toast、按钮 disabled 状态 |
| Runtime/Store | `activeInputId` 是否清理、queue 是否丢失、stopRequested/autoDrain 是否符合预期 |
| Network/SSE | 请求状态码、SSE event 顺序、是否断流、是否重试、是否重复发主请求 |
| Protocol | `session/send`、`session/compact`、`session/goal`、`session/stop` 是否按预期出现或不出现 |
| Log | UI/service/agent 是否有同一 `sessionId/inputId` 的错误和恢复记录 |
| Files | session snapshot、provider settings、workspace 文件是否落盘或保留 |

## N. 模型/API 请求故障

| ID | 前置状态 | 故障注入 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| N01 | `running`，queue 任意 | 主模型请求返回 401/403 | 是否进入 `error`，是否提示重新配置 API Key，queue 是否保留 | UI error + network status + session snapshot | decision-needed |
| N02 | `draft` 或 `completed` | provider 未配置 / API Key 缺失 | 是阻止发送还是进入设置引导；用户输入是否保留 | UI disabled/error + 无模型请求 | decision-needed |
| N03 | `running`，queue 任意 | 主模型请求返回 429 | 是否自动重试；重试期间能否继续入队；最终失败后 queue 如何处理 | network retry timeline + queue snapshot | decision-needed |
| N04 | `running`，queue 任意 | 主模型请求返回 502/503 | 是否自动重试；失败是否可 retry/edit/fork | network status + UI runtime + action buttons | decision-needed |
| N05 | `running`，queue 任意 | 主模型请求返回 500 JSON error | 进入 `error`；已接收的 queue 原样保留并暂停自动消费（`autoDrain=false`）；用户点击“继续”后按 FIFO 恢复，不因本轮错误静默清空 | UI error + network body + snapshot + recovery request | accepted |
| N06 | `prewarming` | DNS/connection refused，未拿到响应头 | 是否保留 user message；是否可继续发消息；queue 如何处理 | network error + UI phase + files | decision-needed |
| N07 | `prewarming` 或 `running` | 请求超时，长时间无响应头 | 超时阈值、是否允许 stop、是否自动失败 | timer-controlled fixture + stop action | decision-needed |
| N08 | `running` | 200 但响应不是合法模型 JSON/SSE | 按模型错误处理还是协议错误；是否可 retry | malformed fixture + UI error | decision-needed |
| N09 | 主轮成功 | title/sidecar 请求失败 | 是否完全不影响主会话；日志是否 warn 即可 | 主消息 completed + title 请求失败记录 | decision-needed |

## S. SSE 流式故障

| ID | 前置状态 | 故障注入 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| S01 | `prewarming` | 响应头已返回，但无任何 SSE event 后断开 | 是否等价于模型错误；user message 是否保留 | responseEvents 为空 + UI error | decision-needed |
| S02 | `running` | `message_start` 后断开 | 是否生成 interrupted/error assistant；queue 是否自动 drain | partial assistant + queue snapshot | decision-needed |
| S03 | `running` | 若干 text delta 后断开 | 部分文本是否保留；是否允许 fork/edit；queue 是否保留 | assistant text + action buttons + files | decision-needed |
| S04 | `running` | SSE event JSON malformed | 按协议错误终止还是忽略坏 event | malformed event + log + UI error | decision-needed |
| S05 | `running` | provider 在 SSE 中发 error event | 是否显示 provider error；是否可重试 | error event + normalized UI error | decision-needed |
| S06 | `running` | stream stall，长时间无新 event | stall 超时阈值；是否显示“重试/停止” | delayed events + runtime status | decision-needed |
| S07 | stop 后 | provider 继续发 late SSE event | late event 是否必须被忽略，不能污染新一轮 | stop inputId + late event + message order | decision-needed |

### 已确认的 S02/S06 恢复子边界

| ID | 前置与故障 | 已确认产品结论 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| S02-R1 | `running`，尚无正文和 `tool_call`；已实时展示若干 `reasoning_delta` 后发生可重试断流或 idle timeout，且 core recovery 预算尚未耗尽 | 保持当前 turn `running`；丢弃失败 attempt 的未完成 reasoning tail，不送入 provider history；从前一个 provider-safe anchor 以新 assistant message id 自动发起 SSE recovery。queue、Stop、desktop continuous 与 mobile replayable 交付边界不变；用户取消、不可重试错误和预算耗尽不进入本子用例 | Core request/history + stream recovery events + protocol retry state | accepted |

`S02-R1` 是现有 S02/S06 的有界恢复分支，不新增顶层 fault row，也不替代 S02/S06 对最终失败、queue 和操作按钮的待裁决问题。

## C. Compact 故障

这些和主路径 `F/G` 直接关联，结果定义以主 catalog 为准，此处不重复。本组已于 2026-07-05 随源 case 裁决完成。

| ID | 来源 | 故障注入 | 需要确认的产品预期 | Review |
| --- | --- | --- | --- | --- |
| C01 | F09 | 手动 compact 的 streaming 主腿与 non-stream fallback 腿均失败 | 已裁决（2026-07-05）：保持 completed + failed marker（带 retry 入口）；queue 保留不自动消费；全部操作恢复 | accepted |
| C02 | G11 | 自动 compact 连续 3 次失败 | 已裁决（2026-07-05）：继续无压缩执行 pendingAction（保持 running）；failed marker 不阻塞；circuit breaker 生效、手动 compact 成功重置 | accepted |
| C03 | G12 | 自动 compact 被 stop | 已裁决（2026-07-05）：与普通 stop 对齐——pendingAction 保留为 interrupted user message（不回 queue）；`completed(interrupted)`；marker 置 cancelled；显式追加 queue 保留不自动消费 | accepted |

## D. 文件系统/存储故障

| ID | 前置状态 | 故障注入 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| D01 | 主轮完成落盘 | session history 写入 ENOSPC | UI 是否告警；内存态是否保留；重启后如何恢复 | injected fs error + snapshot + relaunch | decision-needed |
| D02 | tool 正在写 workspace 文件 | workspace 磁盘满 | tool error 如何展示；assistant 是否继续总结失败 | tool block status + file tree | decision-needed |
| D03 | 设置页保存 provider | app data 目录 permission denied | 是否阻止保存并保留输入；是否写日志 | settings UI error + provider file | decision-needed |
| D04 | 启动恢复 session | session snapshot 文件损坏 | 是否跳过坏 session、显示恢复错误，还是阻止进入 workspace | corrupt fixture + task list | decision-needed |
| D05 | 长时间流式日志 | 日志/artifact 写入失败 | 产品流程是否继续；日志失败是否只 warn | log sink fault + main turn completed | decision-needed |

## L. App 生命周期/进程故障

| ID | 前置状态 | 用户/系统事件 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| L01 | `running` | 用户切到其他 app / 最小化 | session 是否继续运行；回来后 UI 是否追上最新流 | background + foreground snapshot | decision-needed |
| L02 | `running` | 关闭当前窗口但不退出 app | host/agent 是否继续；重开窗口后如何恢复 | window close/open + logs | decision-needed |
| L03 | `running` | 退出 app 后重新打开 | 当前轮是继续、恢复、还是标 interrupted | relaunch + snapshot + network | decision-needed |
| L04 | `running` | renderer reload/crash | continuous 链路是否重接；是否丢 queue | renderer reload + store rehydrate | decision-needed |
| L05 | `running` | host process crash/restart | 是否重建 host；session 状态如何恢复 | kill host + service logs | decision-needed |
| L06 | `running` | agent process crash/exit | UI 是否进入 error；queue 是否保留；能否 retry | kill agent + UI error | decision-needed |
| L07 | `running` | 系统 sleep/wake | SSE 断开后如何处理；是否自动恢复 | sleep simulation / network stall | decision-needed |
| L08 | `compacting` | app 关闭/退出 | compact marker 重启后是 running、interrupted、failed 还是 unknown | relaunch + marker snapshot | decision-needed |

## W. Workspace / Tool 外部变化

| ID | 前置状态 | 故障注入 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| W01 | session open | workspace 目录被删除或重命名 | 是否锁住输入、提示重新选择、还是保留只读历史 | fs mutation + UI state | decision-needed |
| W02 | tool read/write 中 | 文件被外部修改/删除 | tool error 是否准确展示；后续 assistant 是否知道失败 | tool block + file snapshot | decision-needed |
| W03 | git 相关能力 | repo 不存在或 dirty state 改变 | 是否降级为普通文件工作区 | tool/log + UI capability state | decision-needed |
| W04 | remote workspace | SSH/WSL/Docker 连接断开 | mobile replayable 和 desktop continuous 各自如何恢复 | remote disconnect + clientMode | decision-needed |
| W05 | permission request pending | 用户关闭/切换 session | pending request 是否保留、过期、还是自动 reject | permission UI + protocol | decision-needed |

## X. 跨 Session 故障隔离

| ID | 前置状态 | 故障注入 | 需要确认的产品预期 | 建议验证 | Review |
| --- | --- | --- | --- | --- | --- |
| X01 | A `running`，B active | A 主模型请求失败 | B 主视图不能被 A 错误覆盖；A 列表状态如何显示 | active DOM + task item state | decision-needed |
| X02 | A `compacting`，B active | A compact 失败 | B toolbar/sidebar 不受 A compact marker 影响 | active DOM + A snapshot | decision-needed |
| X03 | A error，B active | 切回 A | A 的 error、queue、可操作按钮如何恢复显示 | switch session + UI state | decision-needed |

## T. 测试基础设施故障

这些不是产品 case，但必须纳入工程化测试能力，否则 fault E2E 很容易误判。

| ID | 故障 | 期望 | Review |
| --- | --- | --- | --- |
| T01 | replay fixture 缺失 | 测试应失败为 infra error，不能伪装成产品 500 | infra |
| T02 | fixture 匹配顺序错误 | artifact 必须能看出命中的 fixture id 和请求顺序 | infra |
| T03 | capture artifact 包含密钥 | headers/body secret 必须被 redacted | infra |
| T04 | `replay-isolated` 容器意外出网 | 测试必须失败；CI 只能依赖 fixture | infra |

## 当前统计

| 范围 | 数量 |
| --- | ---: |
| 产品 fault row | 40 |
| 其中：新增外部故障产品 case | 37 |
| 其中：主路径 undefined 别名 | 3 |
| 测试基础设施 case | 4 |
| accepted | 4 |
| decision-needed | 36 |
| infra | 4 |

`C01-C03` 是 `F09/G11/G12` 的环境故障视角别名，不额外增加 A-J 主路径的 case 总数。`C01-C03` 已于 2026-07-05 随源 case 裁决转 accepted。N05 的 queue 口径是所有普通主 turn 终态 `TurnError` 的共同恢复不变量：错误只结束当前 turn，不撤销已经 accepted 的后续输入；错误投影把队列置为暂停态，避免错误后的自动 drain 越过用户确认。429/503 的重试次数、SSE 中途断流的部分文本展示等仍由各自 fault row 单独裁决。

合并去重后，当前不同产品决策缺口是：新增外部故障 36 条。

## 下一步确认顺序

为了尽快把 fault case 变成 E2E，建议先确认这些 P0 语义：

1. `N03/N04`：429、503 是否重试；最终失败后 queue 和按钮状态。
2. `S02/S03`：SSE 中途断开后，部分 assistant 文本是保留为 interrupted 还是进入 error。
3. `D01`：session history 写入 ENOSPC 时，用户是否必须看到错误，以及重启后怎么恢复。
4. `L03/L06`：退出 app 或 agent crash 时，running turn 的恢复/中断语义。
5. ~~`C01/C02/C03`~~ 已裁决（2026-07-05），转入待写 E2E。

## E2E Spec 映射草案

这些 spec 先作为落地边界，不代表产品预期已经确认。只有对应 case 从 `decision-needed` 变成 `accepted` 后，才可以把断言写死。

| 建议 spec | 覆盖范围 | 现有基础设施 | 还缺什么 |
| --- | --- | --- | --- |
| `conversation-session-network-fault.test.ts` | N01-N08 | DeepSeek replay 已支持 statusCode、body、delayMs | 需要产品确认 401/429/503/timeout 的 UI 与 queue 语义 |
| `conversation-session-sidecar-fault.test.ts` | N09 | replay 可按 title 请求 body 匹配失败 | 需要确认 title failure 是否完全不影响主 turn |
| `conversation-session-sse-fault.test.ts` | S01-S07 | replay 已支持 SSE events、offsetMs、`closeMode=destroy` 异常断开；`upstreamReplayServer.test.ts` 已固化正常 EOF / 异常断开的 artifact 差异 | 需要确认各类 SSE 断开后的产品状态 |
| `conversation-session-compact-failure.test.ts` | C01-C03 | compact transport legs 和 auto retry fixture 已存在 | ~~产品语义~~ 已裁决（2026-07-05），可按结论写稳定断言；断言按逻辑 compact attempt 与物理 provider request 分开计数 |
| `conversation-session-storage-fault.test.ts` | D01-D05 | 已有 fs fault injection 协议和 helper 单测，支持按 path / operation 返回 `ENOSPC`、`EACCES` 等 Node 风格错误；provider `config.json`、`setting.json`、provider display order、SQLite session DB open/write、workspace tool 的父目录创建 / 非原子写入 / 删除、tool artifact write、CLI JSONL log write、desktop main log append 已接入；workspace 默认 atomic temp/rename 路径不接入 fault hook | 需要确认产品预期，并决定是否把启动期日志目录创建失败也改为吞错 |
| `conversation-session-lifecycle-fault.test.ts` | L01-L08 | WDIO 可控制窗口、Electron 进程、relaunch | 需要定义 relaunch 后 running/compact 的恢复语义 |
| `conversation-session-workspace-fault.test.ts` | W01-W05 | WDIO 可修改 workspace 文件树 | remote disconnect 和 pending permission 需要额外 harness |
| `conversation-session-cross-session-fault.test.ts` | X01-X03 | 已有多 session helper 和 replay fixture | 需要先确定单 session fault 的目标状态，再验证隔离 |

## Fixture / Harness 能力缺口

| 能力 | 目标 case | 说明 |
| --- | --- | --- |
| HTTP status fixture | N01、N03-N05 | 已支持；fixture 直接返回 401/429/503/500 JSON body |
| response delay fixture | N07、S06 | 已支持 `delayMs` / SSE `offsetMs`；需要统一超时阈值 |
| partial SSE fixture | S01-S05 | 已支持写有限 events 后结束，也支持 `closeMode=destroy` 模拟异常断开；单测覆盖 `complete/end` 与 `error/destroy` 两种 artifact |
| late SSE after stop | S07 | 需要 fixture 在 stop 后继续写事件，并用 inputId 证明 UI 忽略 stale event |
| fs fault injection | D01-D05 | 已固化 `ZCODE_E2E_FS_FAULTS` 协议和 helper，provider/config、settings、provider display order、SQLite session DB open/write、workspace tool 的父目录创建 / 非原子写入 / 删除、tool artifact write、CLI JSONL log write、desktop main log append 已接入；workspace 默认 atomic temp/rename 路径不接入 fault hook；下一步需要确认产品语义并写具体 e2e 断言 |
| process lifecycle control | L03-L08 | 需要 WDIO helper 标准化 quit/relaunch、kill host、kill agent、renderer reload |
| remote disconnect harness | W04 | 需要针对 SSH/WSL/Docker remote host 的连接断开模拟 |
