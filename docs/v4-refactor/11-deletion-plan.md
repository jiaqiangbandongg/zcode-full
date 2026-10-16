# 删除与复用清单（历史执行记录）

> **状态：V4 硬切迁移的文件级轨迹。** 表中的旧路径、行数和“待删除”来自 2026-07-05
> 至 2026-07-06 的执行上下文；大量文件已经删除、re-home 或缩减，不能用于判断当前依赖关系。
> 当前代码入口和仍存边界见 [README.md](./README.md) 与 [06-ui.md](./06-ui.md)。

当时的执行路径是：删除 UI 内持有/推导 conversation 状态的链路，改由 CLI projection 提供事实，
直接切换而不做双写。下文保留删除依据、波次和收口账，方便解释现有 V4 模块为何这样分层。

判据只有一条：

> **凡是"持有或推导 conversation 状态"的代码一律删除（职责搬进 CLI 投影）；凡是"拿到数据画出来"的纯展示代码保留，改为消费 rows。**

关联文档：[06-ui.md](./06-ui.md)（新 store / SessionPane 设计）、[09-protocol-schema.md](./09-protocol-schema.md)（新协议 schema）、[08-phasing.md](./08-phasing.md)（原分期计划；本清单按"删了重写"路径执行，等价于把 Phase 3/4 的删除动作前置，不再保留旧链路双写期）。

---

## 波次 1：UI chat 状态管理与事件拼装链路（全删）

替代物：per-session 只读 projection store + `apply()`（见 06-ui.md 与 09 §delta），预计新代码 < 1000 行。

> **M5② 收尾状态（2026-07）**：本波次最后残余已清理——`zcodeChatMessages.ts`(3,089) +
> `zcodeChatMessageHelpers.ts`(781) 删除（TaskChatMessage/TaskChatToolCall 类型 re-home 到
> `lib/taskChatMessageTypes.ts`，仅供 ToolCallBlocks/PermissionDialog/treemapping 等保留组件
> type-only 消费）；bot 广播消息回放改由 v4 conversation 投影承接；TreemappingPane 改读
> snapshot rows。zustand store 三切片未整体删除，但已剥掉全部死面
> （taskSlice 1,752→906 / workspaceSlice 1,223→811 / types 860→480 / selectors 403→312），
> 剩余为**非会话内容**的存活面，迁移阻塞原因与死期：
> - `activeTaskId` + 导航历史：v4 无原生 active-session 面（pane 层仅 split 有
>   paneLayoutStore），死期 = shell 选中态 v4 化；
> - 侧栏乐观列表/未读（optimisticTaskListByTaskId/taskUnreadByTaskId/taskListCache/
>   taskListVersion/groupedDraftTask）：sessions-index 不承载 pin/archive/unread/乐观新建，
>   仍由 legacy zcodeTaskService(sqlite) + 本 store 乐观层供数，死期 = membership 面补齐；
> - 运行态 taskRuntimeByTaskId + taskUiByTaskId（权限/问答 pending）：bot 广播与
>   remote shard 多端场景仍写入（useBotBroadcastEffects/remoteWorkspaceSessionRuntime/
>   useGlobalTaskList），死期 = bot/remote 面 v4 订阅化；
> - 配置面（configOptions/slashCommands/taskConfigOptionsByTaskId/模型切换态）：
>   workspace-config topic 尚无 renderer hook，V4ComposerToolbar 的模型目录仍读本 store
>   （该文件头自注死期 = 配置面 v4 化）。

### 1.1 zustand conversation store（约 5,072 行）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts` | 2,086 | task/session 运行态 slice |
| `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` | 1,223 | workspace 分桶 + "当前 task"单值 |
| `packages/ui/src/store/zcodeSessionStoreTypes.ts` | 961 | 上述类型 |
| `packages/ui/src/store/zcodeSessionStoreSelectors.ts` | 471 | 扫数组现算的派生态 |
| `packages/ui/src/store/zcodeSessionStoreQueueSlice.ts` | 205 | renderer-local queue（新架构 queue 在 CLI projection） |
| `packages/ui/src/store/zcodeSessionStoreNavigation.ts` | 77 | |
| `packages/ui/src/store/zcodeSessionStore.ts` | 49 | 入口 |

### 1.2 事件 reduce 成消息时间线的整条链路（lib，约 4,680 行）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `packages/ui/src/lib/zcodeChatMessages.ts` | 3,089 | 病根本体：renderer 端事件 reducer |
| `packages/ui/src/lib/zcodeChatMessageHelpers.ts` | 776 | |
| `packages/ui/src/lib/zcodeChatMessageCleanup.ts` | 50 | |
| `packages/ui/src/lib/zcodeTimelineIdentity.ts` | 116 | timeline placement 归属推导 |
| `packages/ui/src/lib/zcodeTimelineRuntime.ts` | 68 | |
| `packages/ui/src/lib/taskTimelineGroups.ts` | 131 | turn 分组 |
| `packages/ui/src/lib/zcodeTurnSteerQueue.ts` | 149 | |
| `packages/ui/src/lib/taskStreamChunkBatch.ts` | 45 | 客户端合批（新架构禁止第二层合并，合并点唯一在 CLI flush） |
| `packages/ui/src/lib/taskStreamMirrorGap.ts` | 61 | mirror 缺口补偿（缺口唯一动作变为重订阅） |
| `packages/ui/src/lib/taskRestoreRuntime.ts` / `taskRuntimeDisplayStatus.ts` / `taskRuntimePendingCommands.ts` / `zcodeTaskRuntimeMonitor*.ts` / `zcodeSessionTaskControl.ts` / `zcodeTaskMetaMerge.ts` | 合计约 1,500 | 运行态推导/合并/监控，全部由 projection 的 `control`/`availability` 替代（执行时逐个确认无非 chat 引用后删） |

### 1.3 stream 事件 hooks 链路（约 6,970 行）

| 文件 | 行数 |
| --- | --- |
| `packages/ui/src/hooks/useTaskStreamEvents.ts` | 747 |
| `packages/ui/src/hooks/taskStreamEventHandlers.ts` | 1,657 |
| `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts` | 955 |
| `packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 583 |
| `packages/ui/src/hooks/taskStreamEventConfigUpdate.ts` | 246 |
| `packages/ui/src/hooks/taskStreamEventHelpers.ts` | 196 |
| `packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts` | 204 |
| `packages/ui/src/hooks/useTaskRestore.ts` | 2,382 |

### 1.4 chat 业务 hooks（约 7,950 行，删后按新 command/projection 模型重写薄版）

| 文件 | 行数 | 去向 |
| --- | --- | --- |
| `packages/ui/src/hooks/useZCodeChatSendPrompt.ts` | 2,185 | 重写为 `sendText` command + optimistic overlay（预计 <200 行） |
| `packages/ui/src/hooks/useChatComposer.ts` | 2,265 | 输入路由判断（startNow/enqueue/guide）改读 projection.inputRouting；编辑器交互部分并入保留的输入组件 |
| `packages/ui/src/hooks/useZCodeChat.ts` | 1,274 | 订阅生命周期重写为 `subscribe(base)` |
| `packages/ui/src/hooks/useZCodeChatHistoryActions.ts` | 951 | fork/edit 改为 command，可用性读 row.actions |
| `packages/ui/src/hooks/useChatTaskControlActions.ts` | 589 | stop 等改为 command，可用性读 projection.control |
| `packages/ui/src/hooks/useChatViewEffects.ts` | 353 | |
| `packages/ui/src/hooks/zcodeChatShared.ts` | 213 | |
| `packages/ui/src/hooks/useWorkspaceActiveTaskState.ts` | 180 | "全局当前 task"概念在新架构不存在（只有 pane 绑定） |
| `packages/ui/src/hooks/chatActionHelpers.ts` | 122 | |

### 1.5 ChatView 拼装层（约 11,540 行，删后按 SessionPane 重写）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `packages/ui/src/ChatView.tsx` | 1,344 | 单例假设，重写为 `SessionPane` |
| `packages/ui/src/ChatView/`（47 个文件） | 10,198 | turn 拼装（`chatViewTurnRenderUnits.ts` 427、`chatViewMessageTurns.ts` 104）、placement、滚动恢复、timeline 诊断等全删；纯展示的小件（如 `ChatScrollToBottomControl`、`FlipMetricValue`）评估后可平移进新 pane |

### 1.6 单值导航/缓存 store（重写，不是原样保留）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `packages/ui/src/store/tabStore.ts` | 564 | `activeTabId` 单值是分屏的直接障碍，按 Layout/Focus 两层重写 |
| `packages/ui/src/store/taskQueryCacheStore.ts` | 568 | task 列表缓存，被 `sessions-index/<workspace>` topic（conflated 最新态订阅）替代 |
| `packages/ui/src/store/remoteWorkspaceSessionStore.ts` / `remotePinnedTaskStore.ts` / `remoteTimelineTaskStore.ts` | 609 | remote 场景平行缓存，多端收敛后无存在理由 |

**波次 1 合计：约 3.6 万行删除。**

---

## 波次 2：`@zcode/protocol` 重写

### 2.1 协议本体

| 文件 | 行数 | 处置 |
| --- | --- | --- |
| `packages/shared/src/zcode-protocol/index.ts` | 3,788 | 删除重写。新协议 = topic 帧信封 + ConversationSnapshot/Row/Delta + command/query（见 09、10），并且**只放 schema 类型 + coalesce 纯函数，运行时不进这个包** |

### 2.2 shared 包内衍生类型（旧协议的影子，随之处理）

| 文件 | 处置 |
| --- | --- |
| `packages/shared/src/task-realtime.ts` | 删（owner/mirror/deliveryKind 语义整体消灭） |
| `packages/shared/src/zcode-task-types.ts` | 删/并入新 schema（task→session 概念收敛） |
| `packages/shared/src/zcode-session-visible-content.ts` | 删（"可见内容"推导进 CLI projection） |
| `packages/shared/src/zcode-session-task-status.ts` | 删（状态推导进 projection.control） |
| `packages/shared/src/zcode-agent-model-state.ts` | 评估：模型状态若进 projection A 区则删 |

### 2.3 爆炸半径（重写协议后必须跟着改的消费方）

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` 及 CLI 侧协议出入口：改为产出 ProductProjection 帧 + command inbox（02、03 的实现落点）。
- CLI 侧 `protocolEventSequences` 等 per-client seq 状态表：按 01-topology 上移/重构。
- 相关测试：`packages/shared/test/zcodeProtocol.test.ts`、`apps/zcode-cli/packages/bootstrap/tests/zcode-protocol*.test.ts` 等随新 schema 重写；黄金测试（同一事件序列 × 两 profile 终态一致）作为新增测试主干。

---

## 波次 3：随协议死掉的传输/适配层

这些不属于"UI chat 状态管理"，但它们是旧协议的消费方或平行实现，协议重写后无法原样存活，列入同一执行计划：

| 文件 | 行数 | 处置 |
| --- | --- | --- |
| `packages/desktop/src/main/taskRealtimeBus.ts`（+ `packages/desktop/test/taskRealtimeBus.test.ts`） | 1,056 | 删。owner/lease/mirror 整层消灭（01-topology），所有客户端对等订阅 |
| `packages/client/src/webRemoteControlRelayProtocol.ts` | 217 | 删。全系统只留 `@zcode/rpc` 一层帧级可靠性（05） |
| `packages/desktop/src/main/webRemoteControlManager.ts` | 1,321 | 大改：去掉 base64 双层编码、bridgeSessionId 易失身份，退化为字节转发 + host attachment 调度 |
| `packages/web/src/main.tsx` | 2,141 | 大改：三条 web 链路收敛为"连一个 endpoint"（01 部署收敛） |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 5,871 | 删。task→session 适配层的存在理由（旧 UI 讲 task 语言）随旧 UI 一起消失。**注意顺序：新 UI 可用之前它必须活着**，是波次 3 里最后删的 |
| 旧协议生成目录 | — | 陈旧构建产物，清理 + 重新构建即可 |

`@zcode/rpc`（`packages/rpc/src`，3,119 行）**不删**，打两个补丁：暴露拥塞信号（`unacknowledgedBytes` + `onSaturated/onDrained`）、重放缓冲加界（见 05）。

---

## M5 收口对账（③-4 终版，2026-07-06）

M5 ③-4 是删波次 2/3 的最终收口波：把前序测绘（③-2/③-3）证实**零消费**的旧协议死词连根删除（词表/schema/CLI 实现/services 客户端/类型一体），并对旧协议词表做全量留存对账。执行红线：每词删前 `rg -w` 全仓复核，有一个活消费即不删、入留存账。

### 词表全量对账（原 56 词 → 已删 11 / 存活 45）

**已删（11 词，词表+schema+两侧实现连根）**：

| 词 | 删除面 | 备注 |
| --- | --- | --- |
| `session/steer` | 全链（wire/op/agentService/sessionService/steerPrompt facade stub/ZCodeTurnSteerSendResult 类型） | adapter steerPrompt 本就返回 unsupported |
| `session/rewind` | 全链 + adapter `rewindTurn`（全仓零调用） | v4 edit/retry 经原生 handler 直发 `/rewind conversation <messageId>` slash command |
| `session/rewindCascade` | 全链 | |
| `session/previewFileRewind` | 全链 + UI `MessageFileRewindDialog` 整删、`MessageChangeSummaryPanel` 撤销 props 收敛 `onToggleFiles` | core workspace file-rewind 机制保留（`/rewind` slash command 消费） |
| `session/applyFileRewind` | 全链 + adapter `toggleTurnFiles`（全仓零调用） | |
| `prompt/enhance` | 全簇：wire×4/ops/runPromptEnhanceJob/promptEnhanceJobs 上下文/agentService pending 表/core `methods/prompt-enhance.ts` | renderer 仅剩 i18n 文案与 modelTrajectory 历史值展示（无害保留）；transport bypass 名单收敛只剩 `session/stop` |
| `prompt/enhance/start` | 同上 | |
| `prompt/enhance/cancel` | 同上 | |
| `prompt/enhance/result` | 同上（通知 + host 分流） | |
| `plugins/marketplace/list` | 全链（wire/op/agentService/接口） | ③-3 新发现零消费；设置页市场数据走 `plugins/overview` 聚合面 |
| `session/fork`（客户端链） | agentService.forkSession/sessionService.forkSession/接口类型 | **legacy op + schema + wire case 留存**：v4 forkAssistant 已不再调用该 op；它走 stable resolver + conversation-only core copy，只暂借 child record registration。legacy `session/fork` 死期仍为波次 2 |

**同波删除的 ③-2 标死写路径死面（非词表词，但同为旧协议面）**：

- `zcodeSessionService` 死 pass-through 六件：`sendPrompt`/`compactSession`/`goalSession`/`stopSession`/`cancelBackgroundTask`/`respondPermission`（生产调用清零复核；bots 写路径走 zcodeTaskService facade → v4 命令，renderer 走 dispatchCommand）。
- `zcodeAgentService` 死客户端方法四件：`respondPermission`/`respondUserInput`（收敛 v4 resolveInteraction；反向请求登记与 permission.request/userInput.request 事件广播保留）、`stopSession`/`cancelBackgroundTask`（收敛 v4 stop/cancelBackgroundWork；wire case 留兼容）。
- 旧 UI 控制孤儿复核：`zcodeSessionTaskControl`/`zcodeBackgroundTaskControl` 全仓零残余（③-2 已删净，本波仅复核）。

**存活 45 词（留存账：消费面 + 死期）**：

| 词组 | 消费面（阻塞删除的活面） | 死期 |
| --- | --- | --- |
| `session/create·resume·list·read·messages·events·subscribe·close`（8） | 生命周期/读路径：zcodeSessionService（desktop 历史恢复/草稿）、adapter replayable 读路径、`session/subscribe` 的最后消费点 = adapter `onDynamicTaskEvent`（③-2 标注） | 波次 3（replayable v4 读路径 + adapter 退役） |
| `session/send` | adapter 附件回退分支（v4 sendText 的 attachmentRef 上传/寄存命令面未建模） | 附件命令面波次 |
| `session/stop`、`session/cancelBackgroundTask` | **客户端方法已删**；仅剩 CLI wire case 兼容（transport bypass 名单引用 sessionStop） | 旧词删除波次（波次 3）一并摘 |
| `session/fork` | op+schema = v4 fork 执行面（过渡钩子） | 波次 2（fork record 原生化） |
| `session/compact`、`session/goal` | adapter replayable facade（旧 stateRevision 与 v4 conversation revision 两套 CAS 计数器不可互换，③-2 评估） | replayable v4 读路径波次 |
| `session/setModel`、`session/setThoughtLevel`、`session/setMode` | replayable facade / zcodeSessionService（v4 switchModelConfig 缺 runtimeModel 凭据解析；setMode 的 auto 值域残留）（③-3 标注） | v4 模型目录/runtimeModel 命令面波次 |
| `session/updateRuntimeModelConfig` | provider runtime headers 热路径（请求期安全校验 headers/自定义 provider 直连） | 同上 |
| `workspace/*` 6 词 + `workspace/generateText`（7） | CLI workspaceModelCatalogs 是 workspace 运行态事实源；generateText 的 LLM 执行面在 CLI（commit message/repoWiki）（③-3 评估：workspace 域命令需独立信封） | v4 workspace 命令/查询面波次 |
| `mcp/list`、`plugins/*`（13） | 平台能力面：settings UI 经 platform 薄 service 消费（③-3 下沉），与 conversation 域无关 | 波次 3 重评（平台面 v4 化独立立项） |
| `usage/stats`、`session/usage` | 消费已清零（③-3 收敛 v4 usage query）；wire case 留兼容 | 旧词删除波次一并摘 |
| `interaction/requestPermission·requestUserInput·requestProviderRuntimeHeaders`（3） | 反向 RPC：CLI interaction-broker 竞速面（legacy 反向 vs v4 resolveInteraction）+ provider headers 热路径 | 波次 2 交互面完全 v4 化（broker 反向路径退役） |

### 三栏账

**① M5 内累计净删（基线 `68bc8b702` 后删除类提交合计，近似值）**：

| 簇 | 提交 | 净删（行） |
| --- | --- | --- |
| M5② store 收尾第一步（ChatInputToolbar/PlanModeToolPanel 等死簇） | `44a8e5e5f` | −12,013 |
| M5② zcodeSessionStore 死面 + zcodeChatMessages 本体 | `ac1b30356` | −11,752 |
| M5② useZCodeConfig/useWorkspacePrepare 死路径 + 类型 re-home | `e0cee071c` | −2,592 |
| M5② bot 广播消息面退役 | `0ac436b55` | −94 |
| ③-2 旧协议 UI 控制孤儿 | `70e887aad` | −506 |
| ③-2 onDynamicSessionEvent 清扫 | `2e5e716c0` | −298 |
| **③-4 本波（7 提交：enhance −1,048 / steer −288 / rewind 家族 −1,678 / fork 客户端 −93 / marketplace-list −59 / 死 pass-through −704 / 注释收口 +4）** | `dffa71e55`…`5514e5193` | **−3,866** |
| **合计** | | **≈ −31,100（3.1 万行）** |

（分支整体 `68bc8b702..HEAD` 净变化约 −3,200：删除被 M5④⑤ 正式 UI/composer/e2e 验收网的新增大部对冲。）

**② 剩余旧协议面（文件 + 行数 + 死期）**：

| 文件 | 行数 | 死期 |
| --- | --- | --- |
| `packages/shared/src/zcode-protocol/index.ts` | 2,450 | 波次 3 整删（词表 45 词见上表） |
| `packages/shared/src/zcode-protocol-legacy-types.ts` | 559 | 波次 3（承重类型中立文件，③b re-home 产物） |
| `packages/shared/src/zcode-task-types.ts` + `zcode-task-types-core.ts` | 230 + 1,107 | 波次 3（task→session 概念收敛） |
| `packages/shared/src/task-realtime.ts` + `task-realtime-core.ts` | 177 + 474 | 波次 3（stream-mirror 多端镜像退役） |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` + `zcodeAgent.ts` | 3,375 + 464 | 波次 3（读路径/生命周期/配置面/平台面） |
| `packages/services/src/zcode-session/zcodeSessionService.ts` + `zcodeSession.ts` | 512 + 240 | 波次 3（生命周期/desktop-continuous 面收口） |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` + `session/zcodeTaskService.ts` | 5,592 + 734 | 波次 3 最后删（replayable facade + bots 写路径宿主） |
| `apps/zcode-cli/.../zcode-protocol/server-operations.ts` + `server.ts` + `plugins.ts` | 3,808 + 455 + 402 | 波次 3（wire 面整删；fork op 段随波次 2 先摘） |
| `packages/desktop/src/main/taskRealtimeBus.ts` | 1,056 | 波次 3（owner/lease/mirror 整层消灭） |
| `packages/client/src/webRemoteControlRelayProtocol.ts` | 217 | 波次 3 |
| `packages/desktop/src/main/webRemoteControlManager.ts` | 1,373 | 波次 3 大改（字节转发 + attachment 调度） |
| `packages/web/src/main.tsx` | 2,177 | 波次 3 大改（web 链路收敛单 endpoint） |
| **合计** | **≈ 2.54 万行** | |

**③ 删本体的剩余前置清单（按波次）**：

- **波次 2 残余（会话域命令/交互面收口）**：
  1. child record registration 归 v4 原生重写 → 删 registration 过渡面；随后删除已无 v4 调用方的 `server-operations.forkSession` legacy op + fork schema + wire case；
  2. 其余过渡钩子退役（ensureModelReady/afterLegacyStateMutation/closeSession/createSessionRecord/resumePersistedSession/resolveTurnUserPrompt 数据面）；
  3. 附件命令面（attachmentRef 上传/寄存）建模 → 删 adapter `session/send` 附件回退分支；
  4. interaction-broker 反向 RPC 退役（v4 resolveInteraction 成唯一路径）→ 删 `interaction/*` 3 词与 host 端 pending 登记表。
- **波次 3（多端切端 + 旧栈整删）**：
  5. replayable v4 读路径（手机端 v4 store）→ 删 adapter 会话面（read/subscribe/compact/goal facade）与 `session/read·messages·events·subscribe` 词；
  6. v4 模型目录/runtimeModel 命令面 → 删 setModel/setThoughtLevel/setMode/updateRuntimeModelConfig；
  7. v4 workspace 命令/查询面（独立信封设计）→ 删 workspace 7 词；
  8. 平台能力面载体迁移（plugins/mcp 13 词，独立立项）；
  9. 上述清零后：usage/stop/cancelBackgroundTask wire 兼容 case 摘除 → 词表清零 → `zcode-protocol/index.ts`/legacy-types/server-operations/server 整删；taskRealtimeBus/relayProtocol/webRemoteControlManager/web main 收敛；`zcodeTaskServiceAdapter` 最后删。

---

## 保留复用清单（不删）

### 纯展示组件（改为消费 rows，结构不动）

| 目录/文件 | 规模 | 需要的改造 |
| --- | --- | --- |
| `packages/ui/src/components/ai-elements/` | 59 文件 / 15,397 行 | 剥离仅有的 store 耦合：`message.tsx`（3 处）、`mermaid-block.tsx`（2 处），改为 props 传入 |
| `packages/ui/src/ToolCallBlocks/` + `ToolCallBlocks.tsx` | 25 文件 / 6,237 行 | 剥离 `renderers/EditInlineDiffContent.tsx`（3 处 store 引用）；输入从 toolCall row 取 |
| `packages/ui/src/ChatMessage/` + `ChatMessage.tsx` | 3,228 行 | 剥离 `AssistantMessage.tsx`（1 处 store 引用）；props 从 turn units 换成 row |
| `packages/ui/src/chatMessageParts.tsx` / `chatMessageHelpers.ts` | 234 行 | 保留 |
| `packages/stream-animate/` | 1,779 行 | 保留，作为流式 markdown 增量渲染落点（06 性能预算） |

### 输入编辑器与本地 UI 态（保留，语义微调）

| 文件 | 说明 |
| --- | --- |
| `LexicalChatInput.tsx`、`SlashCommandPlugin.tsx`、`mentions/`、`chat-input-toolbar/`、`ChatInputToolbar.tsx` | 编辑器本体是本地 UI 态，保留；提交动作换成 command |
| `lib/chatComposerDraftStorage.ts` | 保留，draft 按 sessionKey 存（06 本地态归属表） |
| `lib/chatSessionScrollMemory.ts` | 保留，滚动位置改按 paneId 存 |
| `lib/chatAttachments.ts`、`ChatMediaAttachmentPreviewDialog.tsx` | 保留 |
| `PermissionDialog.tsx`、`ElicitationDialog.tsx` | 保留外观；数据源改 `projection.pendingInteractions`，应答改 `resolveInteraction` command |
| `QueuedPromptList.tsx`、`TodoPanel.tsx`、`MessageChangeSummaryPanel.tsx` 等面板 | 保留外观，数据源换 projection |

### 与 conversation 无关的 store（不动）

`mcpStore*`、`pluginStore`/`pluginManagementStore*`、`skillStore`、`subagentsStore`、`commandsStore`、`hooksStore`、`whiteboardStore`、`alertDialogStore`、`confirmDialogStore`、`codeCommentPreviewStore`、`modelTrajectoryStore` 均不在本次范围。

---

## E2E 与测试资产处置（conversation session 文档网络）

既有 conversation session 文档网络分两层，硬切下命运完全不同。**判据：描述"产品应该怎样"的语义层与实现无关，全部存活且升值；描述"怎么证明它真的这样"的验证层绑死旧 UI DOM，大面积作废重建。**

### 语义层：存活，且升级为黄金测试的直接素材

| 文档 | 处置 |
| --- | --- |
| `docs/conversation-session-case-catalog.md`（A–J 主路径 case） | **保留，权威不变**。catalog 明确声明"不以当前代码实现为准"，v4 的 CLI reducer 必须让这些 case 全部成立。新增红利：case 中大量"状态组合 → 期望行为"可以**下沉为 CLI ProductProjection 的黄金测试**（纯事件序列进、投影断言出，不需要 GUI），只有交互/展示类 case 才留在 WDIO 层——这是 02-projection 黄金测试集的第一批素材来源 |
| `docs/conversation-product-state-space.md`、`docs/conversation-protocol-declaration.md` | 保留。product-protocol 的源文档，v4 语义追溯链 |
| `docs/testing/conversation-session-decision-backlog.md` + `decision-answers*.md` | 保留。四个 PB-* 边界的裁决就走这套 worksheet 流程（Phase 1 前过完） |
| `docs/testing/conversation-session-environment-fault-catalog.md` | **保留并对接两处 v4 缺口**：它就是 design-review G-12（`fault.*` reasonCode / `SessionErrorInfo.code` 枚举表）的原料，也是 E-01 确定性网络混沌装置的故障注入清单。落新协议错误枚举时从这里取材，不要另起炉灶 |
| `conversation-session-fork/tool/goal-*-cross-product-matrix.md` 等交叉矩阵 | 保留 case 维度（组合枚举与剪枝结论是产品语义）；其中的覆盖证据列随验证层清零 |

### 验证层：随旧 UI 作废，按新架构重建

| 资产 | 处置 |
| --- | --- |
| `packages/desktop/test/e2e/conversation-session/`（41 个 spec）+ `manual-review/pending/`（11 个） | 旧 UI 删除后 DOM/testid 断言全部失效。**不删文件，先整体迁入 manual-review 语义**（复用既有"自动操作 + 人工 review"降级机制）：波次 1 删除时把主目录 spec 也标记为 pending，新 UI 竖切可用后按 catalog 逐条重写放回 |
| `docs/conversation-session-ui-testid-contract.md` | 为 SessionPane 新 UI **重发行**：pane 化后定位协议要加 paneId 维度（同 session 双 pane 时 testid 不再全局唯一），这是新 UI 骨架期就要定的契约，不能等测试期补 |
| `docs/conversation-session-validation-matrix.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md` 及各专项 coverage matrix | case 列保留，**覆盖证据列清零重建**（旧 spec 的 covered 标记不再算数）。重建时按黄金测试/WDIO 双轨记录证据类型 |
| `docs/testing/conversation-session-docker-automation-plan.md`、`manual-e2e-ci.md`、`e2e-development-workflow.md` | 方法论保留（replay 固定、Docker 隔离、manual-review 晋升流程对新 UI 同样适用），路径与门禁定义随新 spec 目录更新 |

### 工作流约束（不变）

conversation 相关 E2E 的既有工作流继续生效：**新写任何 case 前先补 case catalog 与 coverage matrix，基于已有 case 与用户确认状态组合剪枝，确认产品语义后再写测试代码**。v4 新增的黄金测试（reducer 层）同样走这个流程——它们只是把"证明手段"从 GUI 断言换成了投影断言，case 的产品语义来源不变。

## 执行顺序与护栏

> 执行节奏的权威版本是 [08-phasing.md](./08-phasing.md) 的 M0–M5 里程碑（本节 1–6 步与之对应：步骤 1≈M1、2≈M2、3–4≈M3、5≈M4/M5）。波次 1 的删除动作发生在 M3 分支上；波次 2/3 发生在 M5。

1. **先立新协议**：按 09/10 落 `@zcode/protocol` 新 schema + coalesce 纯函数 + 类型测试（此时新旧并存，旧代码尚未删）。
2. **CLI 侧产出投影**：ProductProjection reducer + command inbox + `subscribe(base)`（02/03/04），黄金测试全过。
3. **新 UI 骨架起步**：SessionDataLayer + `apply()` + 单 pane Timeline（虚拟滚动）先跑通一条"订阅→渲染→发送"竖切。
4. **删除波次 1**：新竖切可用后整批删 UI 旧链路（本清单 1.1–1.6），同批把保留组件的 store 引用剥掉。
5. **删除波次 2/3**：删旧协议本体与衍生类型、传输层收敛；`zcodeTaskServiceAdapter` 最后删。
6. 每一波删除后跑 `pnpm typecheck && pnpm lint`；conversation e2e 按上节「E2E 与测试资产处置」执行——case catalog 语义不变，旧 spec 降级 manual-review 显式标记（不静默跳过），新证据按黄金测试/WDIO 双轨重建。

风险提示：本路径放弃了 08-phasing 的双写期，删除波次 1 到新 UI 可用之间桌面端 chat 不可用，**必须在独立分支上完成到竖切可用再合并**；手机远控与 web 在波次 3 完成前保持旧链路不动。
