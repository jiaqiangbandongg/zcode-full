# 对话埋点新旧版本差分与回归测试计划

本文定义 `z-code-2` 与 V4 conversation 主链路的运行时埋点差分方法，以及差分确认后必须保留的
自动化回归合同。目标不是只做一次人工抓包，而是把旧版兼容口径转成可重复执行的 golden、integration
和 Electron E2E，防止后续再次因 conversation 重构删除埋点或业务触发入口。

## 变更摘要

| 字段 | 结论 |
| --- | --- |
| 变更性质 | V4 conversation 重构后的兼容恢复与回归保护 |
| 兼容基准 | `~/workspace/z-code-2` 的实际桌面运行行为；已确认的 V4 spec 例外优先 |
| 主要 surface | V4 composer、session pane、assistant feedback、quota banner、错误 banner |
| 实际上报端 | `/event/report` 与 ARMS custom event |
| 客户端范围 | desktop `desktop-continuous` 实际上报；Web/手机仅验证 no-op 和隔离 |
| Provider 范围 | 通用埋点使用任意 scripted provider；quota 使用 Start Plan 等价类；官方版本安全校验 case 使用 `zcode-plan` endpoint 等价类 |
| 非目标 | 购买产品/周期/支付/结果、启动性能、输入框卡顿、ARMS 全局稳定性/资源/网络 |

## 澄清记录

| 轮次 | 问题 | 用户确认 | 固定边界 |
| --- | --- | --- | --- |
| 1 | 是否通过同一 case 启动新旧应用并比较最终上报 | 是 | 建立运行时差分，不以静态代码交集代替 |
| 2 | 时间戳、版本号等动态值是否要求逐值相同 | 否 | 字段存在、类型和关系必须正确；仅显式动态值允许归一化 |
| 3 | 是否先构造覆盖场景的 case | 是 | case catalog 与剪枝先于差分 runner 和 E2E 代码 |
| 4 | 是否需要恢复购买流程 | 否，只恢复对话相关入口 | quota 只验证对话 banner、提交 guard、Upgrade 面板打开和上下文交接 |
| 5 | 是否必须使用 GLM | 否 | 核心埋点 provider-neutral；只有 quota 与官方版本安全校验使用业务等价类 |
| 6 | 是否必须留下回归代码 | 是，单测或 E2E 均可 | 每个 accepted case 必须绑定至少一层自动化合同 |

## 范围

### 必须比较并回归

`/event/report`：

- `send_btn`
- `message_completion`
- `agent_step`
- `context_compaction`
- `assistant_message_feedback`

ARMS：

- `perf_ui_first_token`
- `perf_ui_message_complete`
- `perf_ui_turn_breakdown`
- `perf_ui_stream_stall`
- `perf_ui_tool_call_detail`
- `plan_request`
- `plan_ttft`
- `chat_error_banner`

对话业务入口：

- assistant feedback 的 like、dislike、toggle none、失败回滚和重开持久化。
- session quota banner 的展示、dismiss、提交 guard、entitlement refresh 和打开已有 Upgrade 面板。
- 官方版本安全校验在模型调用内的有界恢复（仅官方版本适用）。

### 明确不纳入

- `purchase_product_select_ck`、`purchase_billing_cycle_select_ck`、`purchase_pay_ck`、
  `purchase_result` 及其支付后端行为。购买 telemetry 实现未因 V4 conversation 重构缺失。
- `perf_ui_launch_*`、`perf_ui_input_lag`、ARMS main stability/resource/network。
- Web/手机真实网络上报。
- 真实模型输出质量、供应商 SLA、线上账号 entitlement 正确性。
- 对历史 session 补报，或把 telemetry 状态写入 snapshot/transcript。

## 状态与证据链

```text
case-local provider fixture / synthetic fault
                   |
                   v
        +----------+----------+
        |                     |
        v                     v
 legacy z-code-2        current z-code V4
 isolated E2E home      isolated E2E home
        |                     |
        +----------+----------+
                   |
          capture final boundaries
          |                    |
          v                    v
 /event/report HTTP body   ARMS main sendCustom
          |                    |
          +---------+----------+
                    v
          normalize explicit dynamics
                    |
                    v
 inventory -> keys -> types -> values -> relations -> order
                    |
                    v
        approved legacy golden + regression tests
```

状态 owner 与证据：

| 状态/事实 | 权威 owner | 镜像/缓存 | 回归证据 |
| --- | --- | --- | --- |
| session/turn/tool/terminal | CLI V4 runtime | host live fact、renderer supervisor | provider replay、protocol fact、最终 payload |
| prompt seed/sourceCommandId | renderer workspace supervisor | 仅内存 | command ACK、talk/message 关系、exactly-once |
| foreground session refs | renderer workspace supervisor | pane visibility refs | UI/pane 状态、ARMS 有无 |
| `/event/report` body | telemetry service 最终 fetch | 无业务持久化 | Electron `net.fetch` mock calls |
| ARMS custom body | desktop main IPC bridge | E2E-only bounded buffer | `armsRum.sendCustom` 调用参数 |
| feedback | assistant row + CLI 持久化 | UI optimistic state | command ACK、row、重开、event body |
| quota | usage entitlement service + session provider/error | hook local dismiss state | banner DOM、composer guard、dialog context |

## 状态维度与等价类

| 维度 | 纳入值/等价类 | 剪枝方式 |
| --- | --- | --- |
| prompt admission | draft create ACK、direct、queued、promotion、rejected | rejected 不产生 send；promotion 与原 command 合并 |
| terminal | success、failed、interrupted、stop 无 terminal | stop 无 terminal 只做零上报负向 case |
| stream shape | text、thought、generation、tool success、tool failed、permission wait、parented child chunk | 工具名不全排列，以 lifecycle/perf 等价类代表 |
| visibility | foreground、background、pane closed、split pane | 同 session 多 pane折叠为一次；不同 session 可独立前台 |
| delivery | live、duplicate live、initial、hydration、recovery | 只有 live 可产生 fact |
| timing | first token 负值、stall 3000/3001、tool 清除 stall、permission wait | 精确边界用 fake clock/recorded stream，不复制所有耗时值 |
| model network | started、completed、failed、retry_scheduled、stream_stalled | 不从 accepted/queued/apiRetry 推断 |
| provider | generic、custom hostname、Start Plan、`zcode-plan` endpoint | 不按具体模型名或供应商品牌全排列 |
| compaction | success、failed、interrupted、non-terminal、duplicate | terminal status 做 golden；前后台做代表 E2E |
| error banner | visible、suppressed、same-key duplicate、new key、3007 | mount 内去重；不可见不报 |
| workspace | local、相同 path 不同 identity/remoteSession、service generation replacement | 路径展示不与身份隔离混用 |
| client | desktop continuous、web remote replayable | Web/手机只做 no-op/不可订阅负向证明 |

## 剪枝决定

| ID | 剪枝组合 | 不变量/原因 | 代表覆盖 |
| --- | --- | --- | --- |
| TDP-P01 | 所有具体 provider × 所有模型 | conversation telemetry 对模型品牌无业务 guard | generic + custom hostname；quota/官方版本安全校验专项等价类 |
| TDP-P02 | theme × locale × terminal | 不改变事件状态机；locale/timezone 字段由 builder golden 覆盖 | 单一 E2E locale，context golden |
| TDP-P03 | OS × 每个 Electron case | payload 平台字段由 shared normalizer 负责 | 当前平台 E2E + shared 单测/CI 平台矩阵 |
| TDP-P04 | tool family 全排列 | 埋点只关心 lifecycle、permission、perf allowlist 和父子关系 | tool success/fail/permission/parented 代表 |
| TDP-P05 | Web/手机重复所有桌面 case | 旧口径不在 Web/手机网络上报 | reporter no-op + telemetry subscription guard |
| TDP-P06 | purchase product/cycle/pay/result | 购买实现未缺失，不属于 conversation 重构恢复 | quota dialog context 交接即停止 |
| TDP-P07 | background UI ARMS、background compaction | 已确认旧口径为零上报 | 专门负向 case |
| TDP-P08 | accepted/queued 推断 `plan_request` | V4 spec 已明确只消费真实模型网络状态 | network status case + 辅助状态零上报 |

## Accepted 回归 case

以下 `TDP` 是 `TEL01-TEL09` 的原子化执行 case。2026-07-18 已为 TDP01-TDP19 每条启动旧版/current
两个真实 Electron 实例，使用同一受控事实序列并比较最终 `/event/report` HTTP body 与 main ARMS
payload。这里的“已验证”不等于 formal E2E 晋升：新差分 spec 仍保留在 pending review。

| ID | 对应 TEL | Setup / Action | 关键断言 | 自动化合同 |
| --- | --- | --- | --- | --- |
| TDP01 | TEL01 | 新 draft 首次发送，create ACK 后完成纯文本 | send 保留原动作时间；talkId 在 ACK 后确定；send/completion/step 共用 sourceCommandId；各一次 | Electron E2E + full-payload golden |
| TDP02 | TEL01 | 同一 session 连续两轮纯文本 | talkId 相同、messageId 不同；第二轮 step/count 不累计首轮 | 新旧差分 Electron E2E；复用现有 TEL01 fixture |
| TDP03 | TEL03 | running 时提交 queued prompt，再 promotion | send 只在首次接纳时一次；promotion 不重发；terminal 前无 completion | controlled-stream E2E + supervisor fake clock |
| TDP04 | TEL01 | prompt success，包含 usage/model request/文本终态 | completion success 完整旧字段；token/model/provider/hostname 正确 | builder golden + service integration |
| TDP05 | TEL01 | prompt failed，终态带/不带 usage 与 error detail | fail 字段、空字符串、累计 usage 与旧版一致；无 success-only 字段污染 | full-payload golden |
| TDP06 | TEL01 | interrupted terminal；另一路 stop 后无 terminal | interrupted completion 按旧口径；无 terminal 时不合成 completion | full-payload golden + controlled-stream E2E |
| TDP07 | TEL05 | thought -> text -> terminal | reasoning 与 generation step 次序、loop_index、duration、tail finalize 正确 | fake-clock golden |
| TDP08 | TEL05 | tool-first、tool success、tool failed、permission wait、parented child text/thought、terminal | 首个主工具可成为 first token；tool step status/waiting；completion 汇总；有 perf 才发 tool detail；parented text 不算 generation 但保留旧 TTFT/stall，parented thought 保留旧 reasoning/TTFT/stall | fake-clock golden + representative tool E2E |
| TDP09 | TEL02 | A 流式运行，切到 B、关闭 A pane、超过 keep-warm，A terminal，再重开 | completion/step 后台各一次；UI ARMS 为零；重开 initial 不回补 | controlled-stream Electron E2E |
| TDP10 | TEL05 | text/tool/no-token first token、3000/3001ms gap、tool clear、split pane | first token 负数归零；无 token 的旧 `-1` 仍镜像 UI value=0 但不发 plan TTFT；3000 不报、3001 报；tool 清 tracker；同 session 多 pane一次 | fake-clock + recorded-stream Electron E2E |
| TDP11 | TEL04 | compact success/failed/interrupted/non-terminal/duplicate；custom model；仅 compactReason；前后台切换 | 三种 terminal 完整 payload；custom model 使用旧 UI 编码；compactReason 不回填旧 reason；non-terminal/duplicate/background 零额外事件 | full-payload golden + representative Electron E2E |
| TDP12 | TEL05/TEL09 | 五类真实 model network status，前后台各到达；辅助 accepted/queued/apiRetry | `plan_request` 次数、status/value/脱敏 hostname 正确；辅助状态零上报 | full-payload golden + host live integration |
| TDP13 | TEL05 | plan TTFT 正常、负值、provider 缺失、后台 | 仅前台有效值上报；负值/缺 provider/background 不报 | fake-clock golden |
| TDP14 | TEL06 | 普通错误可见、被 quota/本地错误抑制、same key 重渲染、新 key | 真实可见一次；抑制零次；同 mount 同 key 一次；trace/detail 截断与类型正确 | component test + Electron E2E |
| TDP15 | TEL07 | like、dislike、同 reaction toggle none、command failure、重开 | 即时旧 payload；entityId messageId；失败回滚；成功持久化 | component + command/projection integration + reopen E2E |
| TDP16 | TEL08 | Start Plan quota snapshot/错误触发 banner，dismiss、阻断/非阻断、refresh、Upgrade | 阈值/优先级与旧版一致；dialog 真正打开；`upgradeSource=session_quota_alert`；不验证下游购买事件 | state/component integration + Electron E2E |
| TDP17 | TEL06 | 内置 Start Plan 的模型调用返回 3007（官方版本安全校验拒绝） | 仅官方版本适用；断言随官方版本的安全校验规格维护 | adapter/service integration + fault-stream E2E |
| TDP18 | TEL09 | live 与 duplicate/initial/hydration/recovery 并存；renderer reload | live exactly-once；其它来源零上报；reload 不补发历史 seed/terminal | gateway/service integration + Electron reload E2E |
| TDP19 | TEL09 | 相同 workspacePath 的不同 identity/remoteSession；service generation replace；Web reporter | supervisor 隔离、旧 generation 销毁；Web/手机 reporter no-op 且不可订阅真实 feed | service integration + desktop/remote boundary test |

## Provider 与账号策略

- TDP01-TDP15、TDP18-TDP19 默认使用本地 scripted provider；不需要真实账号、API key 或 GLM。
- custom provider case 只需要 endpoint hostname/path 的 fixture，用于证明只上报 hostname、不泄漏 path/query。
- TDP16 使用 Start Plan provider ID 与 entitlement fixture；不依赖真实 quota 账号。
- TDP17 使用 endpoint 以 `/zcode-plan` 或 `/zcode-plan/anthropic` 结尾的 provider fixture；
  安全校验配置与 3007 由本地服务模拟，不要求模型名为 GLM（仅官方版本适用）。
- 真实账号/模型只用于全部自动化通过后的可选 production smoke，不进入 CI 合同。

## 双版本捕获与比较合同

### 隔离运行

旧版和当前版本使用独立的 `ZCODE_E2E_HOME_DIR`、network capture、artifact 和 runtime log 目录。
同一 case 配对串行运行，避免端口、协议注册、provider replay 与机器负载互相干扰。每次 artifact 记录：

- legacy/current git SHA、构建版本和 case ID。
- fixture SHA 与 timing strategy。
- OS、locale、timezone、screen size。
- 捕获到的目标事件 inventory。

### 捕获点

- `/event/report`：Electron `net.fetch` mock 的最终 request body。
- ARMS renderer：当前测试构建已有的有界 ring buffer，用于定位 builder/IPC 前差异。
- ARMS main：在 `armsRum.sendCustom` 前增加 E2E-only 有界捕获，比较 main 补齐公共维度后的最终参数。
- 旧仓库只使用临时 E2E instrumentation；运行后恢复干净，不把测试钩子当旧行为修改。

生产构建不得创建捕获全局变量、持久化 buffer 或暴露读取 IPC。测试捕获不得真正发送到线上
`/event/report`/ARMS。

### 归一化白名单

允许值不同但字段必须存在、类型必须正确：

- event/request UUID、capture timestamp。
- `app_version`、build/git SHA。
- `device_mid`、`renderer_id`。
- session/message/turn/tool/request 等不透明 ID。
- 独立双进程实际执行产生的正墙钟耗时，包括 tool `total_ms` 和 recorded-stream
  `stall_ms`；仍逐份验证 `> 3000ms`、`value=metric_value`、分项不超过 total 等公式。
- compaction 的 runtime context token 水位；新旧 runtime prompt/template 可导致少量 token
  差异，字段、非负类型、`post/pre` ratio 与 `true_post` 关系仍必须验证。普通 main-turn
  `message_completion` usage 不归一，sidecar/title 泄漏仍按失败处理。

ID 不删除，按首次出现映射为 `SESSION_1`、`MESSAGE_1`、`TOOL_1` 等稳定别名，继续验证跨事件关系。
`input_id`、`query_id`、`request_id` 各用独立别名空间，分别验证 started/completed 间稳定；
不比较三种 ID 是否彼此相等。旧版分别生成 UI message/input/query ID，而已批准的 V4 command
协议以同一 `sourceCommandId` 作为 input/query 锚点，这属于不透明值生成策略变化，不是上报字段或
触发关系变化。
未知字段不会自动加入白名单；新增归一化规则必须更新本 spec 并说明原因。

以下差异一律失败：

- 事件缺失、重复或目标范围内意外新增。
- key set、字段名、string/number/boolean 类型不同。
- `""`、missing、`null`、固定零值不同。
- status/result/model/provider、event region/type/text 不同。
- talk/message/tool/sourceCommand 关联或稳定业务顺序不同。旧版同一 terminal 的
  `agent_step`/`message_completion` 通过两个 fire-and-forget 异步调用发送，二者网络完成的相对顺序
  本来就不稳定；差分按事件名与同名 occurrence 配对，不把这类异类 terminal 交错当成口径差异。
  同名事件内部的业务阶段顺序（例如 `plan_request started → completed`）仍必须一致。
- foreground/background、live/recovery、3000/3001 等触发边界不同。
- 旧版固定零值被 V4 runtime 新字段改成非零，或 `compactReason` 等新字段改变旧空字符串。

耗时字段不整体擦除。受调度影响的 duration 使用 fixture 窗口与不变量比较；固定零值、负值钳制、
分项和总项关系、stall threshold 和 permission waiting 必须精确满足旧公式。controlled fixture
会给 reasoning phase 显式留出正间隔；但双版本重复实跑证明旧 renderer 的两次 `Date.now()` 仍可能
被事件循环压到同一毫秒，所以仅 `reasoning agent_step.duration_ms` 允许在非负整数范围内归一。
`generation`、`tool_call` 等 step 的零值/正值差异仍然失败。

### 差分产物

```text
packages/desktop/.e2e-artifacts/telemetry-parity/<run-id>/<case-id>/
├── legacy/capture.raw.json
├── legacy/arms-final.raw.jsonl
├── current/capture.raw.json
├── legacy.normalized.json
├── current.normalized.json
├── diff.json
└── legacy|current/{home,network,wdio}/
```

`capture.raw.json` 同时保存目标 `/event/report`、final ARMS 与捕获阶段；`diff.json` 保存 case/run、
legacy/current commit、capture path、捕获阶段和结构化 differences，因此不再重复生成独立 manifest。

Diff 分类固定为：`MISSING_EVENT`、`EXTRA_EVENT`、`MISSING_FIELD`、`EXTRA_FIELD`、
`TYPE_MISMATCH`、`VALUE_MISMATCH`、`RELATION_MISMATCH`、`ORDER_MISMATCH`、
`TIMING_INVARIANT_MISMATCH`。

原始 artifact 只留本地且不得提交。经隐私检查、ID 别名化的 legacy normalized payload 才能晋升为
当前仓库的 golden。prompt 正文、tool input/output、URL path/query、token/header 若出现在 fact 或 golden，
测试直接失败。

## 实施与晋升顺序

1. **Vertical slice**：以 TDP02 建立双仓 runner、最终捕获点、归一化器和结构化 diff。
2. **Golden 完整性**：完成 TDP04-TDP08、TDP10-TDP13 的完整 payload/fake-clock 测试。
3. **生命周期 E2E**：完成 TDP01-TDP03、TDP09、TDP11、TDP14-TDP19 的 pending specs。
4. **旧版认证**：逐 case 运行 `z-code-2` 与当前版本，处理所有非白名单 diff。
5. **Legacy golden**：人工 review 后提交脱敏 normalized golden；日常 CI 只跑当前版本，不依赖
   `~/workspace/z-code-2`。
6. **正式晋升**：pending fixture check -> explicit replay -> default replay -> isolated Docker ->
   human review/promotion -> Docker preset admission。
7. **最终验证**：运行 focused tests、desktop E2E typecheck、`pnpm typecheck`、`pnpm lint`，再做一次
   production desktop runtime smoke，并记录仍无法覆盖的外部条件。

### 2026-07-18 执行结果

- `20260718-tdp-all-final/TDP01..TDP19`：19 个 case 均从 Electron `net.fetch` 捕获最终
  `/event/report` HTTP body，并从 main process 的 `armsRum.sendCustom` 前捕获最终 ARMS payload；19 份
  `diff.json` 均为 `equal=true`、`differences=[]`。
- 覆盖 direct/queued/terminal、thought/text/tool/permission、foreground/background、3000/3001ms
  stall、compact 三终态、model request 五态、可见/抑制错误、feedback、quota、官方版本安全校验、live-only/
  recovery、workspace/remote/Web no-op。TDP16/TDP17/TDP19 另外执行 production quota/安全校验/Web 状态
  正断言，禁止用“两侧都为空”冒充通过。
- `20260718-tdp02-final/TDP02` 与 `20260718-core-i/TDP-CORE` 继续作为真实 provider/replay 代表性运行
  证据，覆盖连续两轮、工具成功、compact success、reasoning、3001ms stall 与 interrupt，diff 仍为 0。
  原子 case 使用受控事实序列，是为了稳定制造失败、权限等待和精确毫秒边界等 provider 不稳定条件。
- 目标 inventory 与旧仓 production 调用点审计一致：`/event/report` 只有 `send_btn`、
  `message_completion`、`agent_step`、`context_compaction`、`assistant_message_feedback`；ARMS 只有五项
  `perf_ui_*`、`plan_request`、`plan_ttft`、`chat_error_banner`。购买模块内部事件不属于本轮范围。
- focused 回归 14 个文件、152 项通过；fixture check、全量 typecheck、全量 lint 均通过。

双轮抓包也证明旧版 `agent_step`/`message_completion` 的网络完成顺序会在相邻轮次间互换，因此 runner
只比较稳定业务顺序，不把 fire-and-forget 并发抖动误判为口径差异。差分 spec 仍位于
`manual-review/pending`，只计已执行自动化证据，不提前计 formal gate。原始 artifact 只留本地。

## 完成定义

- TDP01-TDP19 每条都有旧版/current 双 Electron 最终出口捕获与独立 diff；预期零上报的 case 还有
  production 状态确实到达的正向断言。
- `/event/report` 与 ARMS 的旧版目标事件在当前版本无缺失、无重复、无字段/类型/关系错误。
- Web/手机、initial/hydration/recovery、background UI ARMS 等负向边界有自动化证明。
- quota 回归止于 conversation Upgrade 入口交接，不把购买流程伪装成本次恢复成果。
- case catalog、coverage matrix、fixture manifest 与实际 spec 状态同步；pending 不计 formal gate。
- 原始差分 artifact 不提交，脱敏 golden 通过隐私测试。
