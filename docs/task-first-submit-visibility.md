# 草稿首发：任务列表与详情同时提交

## 行为与原因

用户裁决（2026-09-15）：草稿按发送、成功转圈结束时，左侧已有并选中该任务，右侧进入同一任务详情。复用已有首发生命周期，不新增协议 ACK 字段、任务状态或超时补偿。

实测首发 accepted 已返回，初始化与 SessionStart hook 仍在运行。首输入标题事件发生于 deferred 提升之前，被 CLI 列表发布器过滤；后续摘要虽已持久化，运行 phase 仍可能是 draft，又被 Host 过滤。旧侧栏还会在每个活动帧启动全树读取并废弃在途结果，放大延迟。

## 所有者和顺序

```text
CommandInbox 接受输入 → 现有 deferred 提升 → publishCurrentSummaryToIndex
                                                ↓
                         task-facts 摄入 → tasks-index 提交 → task_created
                                                ↓
                  ProjectDirectoryProvider 接受包含真实行的 readTree
                                                ↓
               同一 UI 提交：更新目录 + handleDraftSessionCreated
                                                ↓
                       首发 Promise 完成，composer 结束 pending
```

- CLI persistence 决定是否为未提交草稿，runtime phase 只表达执行状态。未提交预热不发布到 sessions-index；已提交但未 TurnStarted 的摘要允许落入 Host 索引。
- task-facts 仍是 CLI 事实摄入入口，project Host 仍拥有 projectId/pin/archive。首次摘要落库后直接发布 task_created，不为了补行读取完整会话或等待模型/Hook。
- 共享目录仍只接受 Host readTree 的真实行。首发回调等待完整 workspaceKey + taskId 匹配，目录与原导航在同次 React 提交中更新；不构造 optimistic 项目行。
- 目录刷新合并重叠请求，在途期间收到失效通知只追加一次读取。当前读取可提交，不因持续活动饿死；切换 service/attachment 或卸载后旧结果失效。
- accepted 回调仅是 UI 在途完成工作，不是第二份输入队列。读取失败向调用方报告，离开原 pane 取消导航；都不得自动重发已接受输入。重复通知不会重复导航或生成任务。
- 桌面 continuous 与手机 replayable 共用该 UI/事实链；保留原 owner/lease、CommandInbox 去重及 replay gap/snapshot 恢复，不改 main/relay 或 runtime 创建路径。远端匹配使用 workspaceIdentity，携带原 remoteSessionId。
- 无数据库迁移。不改变已有任务发送、fork、历史打开、项目归属与排序策略。

## 验收

| Case | 场景/动作 | 必须断言 | 验证层 |
| --- | --- | --- | --- |
| FSV01 | 预热草稿首发，初始化未产生下一事件 | accepted 前发布已提升摘要；未提交草稿仍不进列表 | CLI 单测 |
| FSV02 | 收到已持久化、phase=draft 摘要 | 真任务行 + task_created；零 readSession/resumeSession；重复摘要不重复创建广播 | Host 单测 |
| FSV03 | 首发完成时已有目录读取在途，持续失效通知 | 不并发堆叠、不饿死；目录含行与详情绑定同次提交；同 cwd 不同 identity 不匹配 | UI 单测 |
| FSV04 | service 切换/卸载、目录错误 | 旧响应不导航，错误可观察，不重新提交输入 | UI 单测 |
| FSV05 | 真实桌面发送草稿 | 每帧采样：首次详情帧已有侧栏行且选中；CLI/Host 存在对应事实；未首发时无任务行 | pending E2E |

文本与附件共用首发回调，分别保留 prewarm 与 createSession(firstInput) 原路径。移动端用共享组件与身份单测覆盖接线，实机回归结果单独记录。codegraph 查询因 unresolved_refs 表缺失失败，影响面按源码追踪，未完成图扫描。

## 验证记录（2026-09-15）

- CLI sessions-index：21/21；Host syncer：68/68；UI 首发/身份/取消/服务换代、目录刷新与稳定化：9/9；原 composer 连续性：8/8。
- 桌面回放 `desktop-e2e-20260915132619485-p5768-b01dc2cd458ba130`：全局、项目内首发 2/2。逐帧分别记录 231/49 帧；首个详情帧都是一条新增行、可见且选中，之前的草稿帧新增行数均为 0。同时校验 Host projectId/CLI 创建时间、真实用户消息、回复及 idle；两个主请求和两个标题请求均 200。
- `pnpm typecheck`、`pnpm lint`（47 项既有 warning，0 error）、desktop `typecheck:e2e`、bootstrap `typecheck`、本 case `e2e:fixture:check` 通过。未进行手机、Windows、Linux 实机回归；没有改变这几端的接口或传输语义。
- 修改前后架构门禁均只有既有 `root/resolveConversationWorkspaceTarget.ts` 的 unmanaged-new-file；本修复没有增加违规。bootstrap scoped lint 原有 19 个 max-lines 错误（包括既有大文件 gateway）未处理。
- 扩跑 gateway 的 93 个用例有一个既有失败：Core admission ACK 后旧 revision retry/file rewind 预期 stale，实际 executionFailed。临时移除本修复的 gateway 改动重跑仍失败，其余 92 个通过。
- 全量 case coverage audit 仍受既有 28 个 pending fixture 元数据、D19/I74/I75 缩写与生成文档统计过期阻塞；本 case fixture 检查通过，不自动晋升 formal。
- 前一次双入口运行：全局通过，项目用例重复执行初始化导致等待默认工作区失败，已改为点击真实项目新建入口；一次构建在用例启动前遇到共享输出目录 ENOTEMPTY。最终使用现有 KEEP_BUILD_CACHE 开关重新编译，并由 runner 复制到本轮独立 app 目录后通过，未跳过源码构建。
