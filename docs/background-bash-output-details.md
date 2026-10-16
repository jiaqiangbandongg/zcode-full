# 后台 Bash 输出详情

## 合同

后台 Bash 条目可打开右侧 `bash-output` 标签页；同一 workspace scope、root session、
实际 session、workId 复用标签页。标签页只在内存中存在，不恢复到新 runtime。
子代理中的入口读取子会话自己的 Bash，不向根会话复制后台任务目录。

```text
Bash -> canonical output file
                 ^
visible selected tab -> scoped service -> V4 readonly query -> runtime -> execution port
                 |
                 +-> current status + bounded tail (8192 raw bytes)
```

打开/重新激活立即查询，之后每秒查询，最多一个请求在途。隐藏、切换工作区或关闭停止
查询并丢弃迟到结果；关闭不取消任务。向上滚动冻结当前显示，继续获取最新尾窗与状态，
最多持有冻结窗口和最新窗口两份有界文本；手动滚回底部（沿用 8px 容差）或点击悬浮下箭头，均立即查询并恢复跟随、隐藏箭头。
终态必须在终态已经确认后读一次尾部，然后停止轮询、保留标签页。暂停阅读期间不跳动。
文件空与读取失败严格区分；失败保留最后成功内容，停止轮询并提供重试。

详情使用 Bash 风格背景的纯文本输出区域，仅在运行中显示轻量状态提示。
不展示命令头、耗时、停止按钮、行数或字节数；停止沿用原后台条目入口。
顶部状态条仅显示运行中状态和完整文件链接，使用 space-between 两端对齐：状态靠左，链接靠右（复用 Code Viewer），两者使用相同的弱化文字色。不展示尾窗省略旧内容的提示，中英文一致；任务结束或窄屏换行后链接仍靠右，路径使用标签页冻结的工作区。8 KiB 尾读和完整文件保留合同不变。
暂停跟随时，输出窗口底部中央独立显示圆形下箭头按钮，沿用对话“回到底部”的尺寸、outline 样式和主题 token。
按钮不占状态条或正文布局空间，位于 mask 外；只有图标，可访问名称及 title 使用已有“回到底部”翻译。
点击继续执行原有 resume：立即查询最新窗口并恢复跟随，不引入另一套滚动/查询状态。
正文滚动区域复用共享 `ScrollFadeViewport` 的上下 24px 渐隐（从现有反馈组件提取），只淡出仍有隐藏内容的一端。
CSS mask 固定在视口边缘，文字滚出窗口时逐渐透明，mask 不随正文滚动。
无溢出不淡出，到顶/到底分别保留首行/末行；中间位置两端淡出。滚动或尺寸变化更新 mask，
不改变暂停跟随、恢复、查询及终态合同；mask 不覆盖顶部状态、文件链接或悬浮按钮，兼容共享 UI 的主题与手机布局。
前后台均恢复组件内基于滚动位置的简单判断；尺寸变化引起的误恢复仍为已知问题，边界见 [前台输出视口与跟随](bash-background-parity.md#前台输出视口与跟随2026-09-10)。隐藏详情不查询。

```text
top: running                              full-file link
output viewport -> scroll up -> paused -> floating down arrow
                                          | click / scroll to bottom
                                          v
                            existing resume -> latest output -> follow bottom
```

## 只读边界

新增 `v4/conversation/backgroundBashOutput`，请求只有 sessionId/workId；服务层注入可信连接
并按 workspaceIdentity/remoteSessionId 路由。执行层固定尾读 8192 bytes，复用 Bash 解码，
不接受用户提供文件路径或读取上限。Runtime 委托执行记录校验 Bash 类型、所属会话和后台身份。
成功响应只包含 kind、workId、status、output、truncated、outputPath；不重复传输详情不展示的
命令、开始/结束时间、退出码和文件大小。执行记录仅保存 Bash 类型标记，不为查询保留命令文本。
错误区分 unavailable/unsupported/read_failed。读取前记录状态，避免终态响应携带退出前尾窗。
必需的 app facade 方法直接调用；可选 execution capability 和旧协议边界仍返回 unsupported。
Desktop Host 的成功轮询 RPC 日志走现有 debug logger，普通运行不落盘；失败仍走原 warn 路径，
其他 RPC 日志级别不变。不新增日志协议或配置。

输出编码由 execution adapter 的 `run()` 在取消检查后解析一次；任务记录仅保存这次解析的
编码值，供前后台切换及终态详情复用，不在创建记录或查询时重新执行 Windows `chcp`。
记录不持有 collector 或完整输出 buffer，文件直写与有界读取保持不变。

观察只复用 existing-only runtime，不启动/恢复会话、不改变通知消费状态、不产生模型请求。
终态从活动列表消失后已有 execution/runtime 记录仍可查询；记录不可用明确报错。
正文不进入 snapshot、event log 或持久化。已有 TaskOutput、前台 progress、平台 flags、
5 GiB/5 秒 watchdog、主动 Stop/close 杀树及自然退出合同不变。

Desktop continuous 与 mobile replayable 仍由 attachment 决定；查询不创建 topic/replay 事件。
共享 Side Pane 在手机使用已有 overlay。TUI 不变；通用文件服务不扩展。

## 验收

| ID | 场景 | 断言 |
| --- | --- | --- |
| BGV01 | 显式后台、分两段 barrier 输出 | 退出前看到两段；重复点击复用 tab；无新增模型查询；普通运行不记录成功轮询日志 |
| BGV02 | 超时转后台、超过 8 KiB、多行输出 | 新尾部可见，旧头部淘汰，完整文件不截断 |
| BGV03 | 向上滚动、隐藏/激活、任务完成 | 暂停不跳动，回到最新恢复；隐藏无查询；终态保留并停止刷新 |
| BGV04 | 多 session/workspace、子会话与远程 scope | 请求始终命中冻结 scope，不串输出；外来任务/路径拒绝 |
| BGV05 | 文件丢失、慢响应、关闭、runtime 退出 | 明确错误且保留上次内容，无重叠/迟到更新，不启动 runtime |
| BGV06 | 原条目 Stop 后观察详情 | 详情无 Stop；原入口取消后保留终态输出，进程退出 |

单测覆盖 schema、runtime 授权、adapter 真文件尾读与编码、标签页隔离以及 hook 时序。
Desktop E2E 使用 case-local provider/file fixtures 与 barrier；2026-09-10 用户确认实时演示后按 promotion 流程转正。
上下渐隐复用验证：`desktop-e2e-20260910-142038-231` 中 BGV03 与前台 BDO07 共 2/2 通过，
覆盖固定视口 mask、滚动边缘方向、隐藏/激活及暂停/恢复；共 23 项相关 UI 单测通过。
顶部状态条与悬浮按钮验证：`desktop-e2e-20260910-144308-382` 中 BGV01/02/03 共 3/3 通过，
覆盖状态条位于正文上方、圆形图标按钮居中悬浮且不受 mask 影响、原有暂停/终态/恢复行为；
截图 `background-bash-paused.png` 已核对。相关单测 10/10、typecheck、E2E typecheck、架构检查通过；
lint 为 43 条既有 warnings、0 errors。该轮为 macOS Desktop 验证，未执行真实手机 UI。
手动到底恢复验证：`desktop-e2e-20260910-151014-649` 在修复前复现 bottomGap=0、following=false；
修复后 `desktop-e2e-20260910-151207-002` 的 BGV01/02/03 共 3/3 通过，覆盖链接同色、手动到底隐藏箭头后继续刷新、再次上滚冻结及终态按钮恢复。
回归现有 Bash 前后台、TaskOutput、5 GiB、Stop 和前台展开合同；不运行全局 E2E。

### 子会话的执行归属

运行中的 subagent 共享祖先 execution port；后台执行记录一直由该 adapter 持有，不因子会话完成而迁移。
子会话 publisher 释放后，普通会话订阅可以冷恢复出持有新 adapter 的独立 bootstrap record；
因此现存 record 不等于任务 owner。输出查询从请求会话沿持久化 parentID 遍历现存 record，
逐个调用已有 readBackgroundBashOutput(workId, 原始 sessionId)：仅 unavailable 时继续向祖先查找，
output、read_failed、unsupported 直接返回；无匹配任务时返回 unavailable。查询本身不得 cold resume。
执行记录冻结启动时的 trace.sessionId，查询必须同时匹配 workId、原始 sessionId 和后台 Bash 类型。
不新增 owner 索引、任务迁移或 runtime 保留；详情完全只读，不扩展命令 admission 或子会话停止能力。
BGV04 从运行时入口保留输出 tab，关闭子会话详情并等待 publisher 释放；展开父会话执行历史，
通过 Agent 摘要冷恢复子会话后重新激活已有输出 tab。冷恢复不新增历史后台任务目录。
该 case 使用真实 120s grace / 60s 清理节拍；WDIO 在 test body 之前包装超时，故只为这份
spec 配置 360s 外层预算，不能仅依赖用例中的 this.timeout，也不修改产品定时器。

```text
child query -> live child adapter -> unavailable -> existing ancestor adapter -> output
                       每层均使用原始 child sessionId 校验任务归属
```

### 冷恢复查询回归（2026-09-11）

- 修复前 owner 回归测试返回 unavailable；修复后相关 adapter/runtime/bootstrap 单测 27 项和 gateway 生命周期测试 5 项通过。
- 真实 Node adapter 探针确认：加入新 child adapter 前后，原 workId 均返回 output/running。
- macOS / Node 24.14.0 Desktop BGV04：`desktop-e2e-20260910-190613-523` 通过。日志依次记录
  `19:11:22.806Z` 释放 child publisher、`19:11:25.112Z` 创建冷恢复、`19:11:26.059Z` 完成冷恢复。
  同目录 `background-bash-cold-resume.json` 保存子/父会话、原 workId、请求计数和两段新输出证据；
  用例另断言 producer 退出前存活、查询不增加模型请求、结束后保留最终输出。
- 初期运行分别被 runner 的 120s 外层预算、未展开的历史入口及冷恢复不重建后台目录的前置条件阻断；
  修正测试操作后独立回放通过，不把这些失败尝试计入通过。首轮同文件另外 6 项 BGV 回归通过。
- 根/CLI bootstrap/E2E typecheck、fixture check、architecture（0 violations）通过；lint 41 条既有 warnings、0 errors。
  本轮未重复 Windows/Linux 或手机远控 UI 验证；未改协议、平台文件读写和 continuous/replayable 边界。

## 本轮验证（2026-09-09）

本地报告保存在 `packages/desktop/.e2e-artifacts/`；fixture 用例固定 provider 工具调用，Bash、文件、barrier、进程和 UI 为真实运行。

| 验证 | 结果 / 报告目录 |
| --- | --- |
| 新增只读详情，纯输出 UI | 7/7，`desktop-e2e-20260909-121113-619`（含 `background-bash-live.png`） |
| 运行中提示移至底部 | BGV01 1/1，`desktop-e2e-20260909-122021-611`；断言位于输出区域下方、紧邻截断提示之前，终态后消失 |
| Bash 直写 / 前台刷新 / TaskOutput | 8/8，`desktop-e2e-20260909-120207-834` |
| Bash 生命周期筛选回归 | 8/8，`desktop-e2e-20260909-120412-010` |
| V4 既有后台停止 | 1/1，`desktop-e2e-20260909-120552-318` |
| 真实 5 GiB | 前后台分别实写：5 GiB 等待 5.5 秒仍存活；追加 1 byte 后 watchdog 终止，进程退出、诊断与单次通知通过 |
| 跨平台真实查询 | macOS/Linux Node 24.14.0 各 2/2；Windows Git Bash/CMD × 显式/超时后台，Node 24.14.0 与 25.9.0 各 4/4；尾窗淘汰、中文/CRLF/无换行、终态、文件删除通过 |
| 单测与检查 | adapter/runtime/gateway/service/schema/hook/tab 定向单测通过；typecheck、CLI build、architecture（0 violations）、lint（0 errors，46 条既有 warnings）通过 |

Windows 使用测试目录内独立 Node 24.14.0，不切换默认 Node 25；原始平台 JSON 报告在 `.tmp/background-output-{macos,linux,windows24,windows25}.json`。子会话只读查询沿已有 parentID 找现存 owner，不修改 CommandInbox 或停止流程。

隔离 Node 的既有 shutdown timeout 用例在一次并行测试中出现 `Worker did not start`（2 秒执行 timeout）；未改生产逻辑或测试阈值，原样独立重跑 5/5 通过。记录该次失败，不把它算作一次通过运行。

边界：未执行 Desktop 远程工作区/手机远控完整 UI E2E；scope 与 continuous/replayable 用 service 单测验证。Windows/Linux 验证的是实际执行/查询链路，非完整 Desktop UI。新增 E2E 已于 2026-09-10 经用户确认转正，尚未做 Docker admission。当前无 codegraph，影响面按实际调用链与功能图核对。

编码复用修复：新增 5 个回归用例先复现重复解析和取消前探测，修复后相关 CLI 回归
155 passed / 3 platform skips；新 start 用例的异步文件 barrier 在并行运行时超过默认 1 秒，
测试改为最多等待 5 秒后全组通过。真实 adapter 探针在 macOS Node 24.14.0 上 5/5，
Windows Node 24.14.0 / 25.9.0 上分别 10/10（Git Bash/CMD）；未设置编码覆盖项，
统计真实 `chcp` 调用：前台、显式/超时后台和 start 均一次，启动前取消零次，多次详情查询
不再探测。原始记录在 `.tmp/encoding-reuse-{macos,windows24,windows25}.json`。
本次修复不涉及 UI 或协议字段，未重跑 Desktop E2E。

### 查询收敛验证（2026-09-10）

- 精简响应、Bash 类型校验、scope、hook、日志分级及可选能力相关定向单测共 75 通过；CLI 的 22 个用例使用 Node 24.14.0 复跑通过。
- Desktop BGV01–BGV06 共 7/7 通过，报告 `desktop-e2e-20260909163455688-p59507-a912dda0f382e864`。新增 BGV01 断言确认实际刷新期间成功轮询不落盘；整场 Desktop 日志包含 334 条其他 RPC 记录，后台输出成功轮询为 0 条。
- 根 typecheck、Desktop E2E typecheck、CLI adapter/bootstrap typecheck、架构检查和格式检查通过；根 lint 为 46 条既有 warnings、0 errors。额外直接 lint CLI 文件时，v4-bridge 的既有 max-lines 问题仍存在（HEAD 1579/current 1585，本次清理删除 1 行）；其余受影响 CLI 文件无警告或错误，未放宽仓库规则。
- 本次不修改 UI 交互、执行生命周期或跨平台文件操作；未新增 Windows/Linux 或远程/手机 UI 验证，既有验证边界不变。

### 正式用例提交验收（2026-09-10）

- 用户确认长时间实时演示后，经 promotion dry run、apply 和 coverage audit 转正 BGV01–BGV06，共 7 个测试；未加入 Docker preset。
- 转正后仅使用 common + case-local fixture 回放 7/7 通过：`desktop-e2e-20260909-171215-094`；默认 fixture 回放同样 7/7 通过：`desktop-e2e-20260909-171508-564`。两次均为 macOS Node 24.14.0。
- 最终根 typecheck、Desktop E2E typecheck、architecture（0 violations）、diff check 通过；lint 为 46 条既有 warnings、0 errors。Fixture check 通过，`E2E_BGV_PARENT_DONE` 为收尾输出标记而非请求 matcher，保留该检查提示。
- 远程工作区/手机完整 UI、Windows/Linux Desktop UI 和 Docker admission 仍未补测，以上验收不扩大既有验证边界。

### staging 集成前置条件（2026-09-10）

Provider 重构后的新草稿恢复 build 模式，BGV/BDO 用例必须在每次新建草稿后显式设置
Full access。仅在 suite 的 before 设置一次会让第二条用例停在权限审批，不能据此判断
输出刷新失败。此项仅固定已有生命周期测试的前置条件，不改变产品权限策略。

集成 `origin/staging` `beb9751d9f` 后：

- 补回 Host 后台轮询仍使用的 `createServiceLogger` 导入；首次类型检查捕获缺失，修复后根/E2E typecheck 通过。
- 相关单测共 207 个通过；其中 direct execution 的一次并行运行在 5 秒超时，原样单独复跑该文件 16/16 通过，未调整超时。
- 真实 Desktop BGV 全部 7 条、前台 loading/展开 1 条、BDO02/03/07 共 3 条均通过：`desktop-e2e-20260910-073512-809`（macOS / Node 24.14.0）。修复前的 `desktop-e2e-20260910-073014-129` 明确记录新草稿 `build` / `mode.build.highRisk` 审批阻塞，不计为通过。
- Lint 43 warnings / 0 errors，architecture 0 violations；本次未补测跨平台、远控或完整上游功能集。
- 全局 conversation coverage audit 未通过；将纯 staging `beb9751d9f` 导出后独立运行，附件 fixture 元数据、I03/I04 旧引用、统计和生成文档共 9 项错误与合并后完全相同，未在本次合并中修改无关审计内容。
