# Todo139：分享导入复用普通新任务的模型与模式初始化

状态：已实现，本地单测、浏览器交互与 review 完成（2026-09-12）；完整分享服务端／原生首条 RPC 联合验收尚未完成。

## 目标与根因

分享导入创建的新任务，应与接收方普通新建任务保持相同的选择行为，包括 Provider、模型、思考档位及模式／权限；不继承分享者的执行设置。

调查基线：本地 `9ea22ec1f0`；已 fetch 的 `origin/staging` 为 `eb71ba51c2`。相关新任务初始化代码一致，已包含 `baef1544c5`、`18a963c078` 的最近提交模式继承修复。没有为本次调查合并新的 staging。

当前缺口：`ConversationShareService.importShare()` 调用 `createSession()` 时未传模型／模式选择；导入后直接激活真实 Session。Composer 仅在 `sessionId === null` 时读取新任务偏好，已有 Session 则读取会话选择并保留明确空态。首次分享导入因而跳过新任务初始化，不会自动获得普通新建任务的选择。

## 已确认规则

| 项目                     | 优先顺序                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Provider、模型、思考档位 | 目标工作区已初始化的新任务草稿 → 最近已接纳提交的完整 ModelSelection → 公共默认选择 |
| 模式／权限               | 目标工作区已初始化的新任务草稿 → 最近已接纳提交的模式 → 产品默认 build              |

- 提取或复用普通新任务的初始化入口，两种入口共用规则，不在分享服务内复制默认模型算法。
- “已有草稿优先”包含其明确空选择；不能把用户清空或失效的选择误当成不存在，自动换成默认模型。沿用当前公共 effective selection 解析与校验，不另建 fallback。
- 只复制选择配置，不复制正文、编辑器内容、提及、附件；不删除或迁走普通新任务草稿。
- 按导入实际落地的 `workspaceIdentity?.trim() || workspacePath` 读取偏好。远程 workspace 回退本地时，使用最终本地工作区，不沿用远程来源偏好。
- 只初始化首次创建的导入任务。重复导入复用 Session、再次打开或恢复历史，不覆盖该会话已保存的选择与草稿。
- 初始化只准备本会话的 Composer 草稿；后续完整 Submission 仍是执行配置提交边界。导入成功不等于消息已提交，不能因此刷新 Recent。
- 无模型、Registry 暂未就绪或选择不可执行时，分享内容仍可导入和打开；待公共读取就绪后完成必要初始化，发送前按已有门禁要求选择有效模型。不使模型请求成为导入前置条件。

## 所有权与时序

```text
普通新建 ───────────────────┐
                           ├→ 共用新任务选择初始化
首次分享导入 → 实际工作区 ──┘    → 独立 Session Composer 草稿
                                → 用户发送完整 Submission
                                → 原接纳、执行及持久化链路

重复导入／恢复已有会话 → 保留已有 Session 选择和草稿
```

- Renderer 持有草稿与 Recent；Host 提供公共默认及有效选择 View；导入服务继续负责内容／产物／Session 的原子导入，不直接访问 Renderer 存储。
- 初始化只发生一次；Registry 回包、导入重试、迟到结果不得覆盖用户已编辑的草稿，不能串到后来切换的工作区／Session。沿用现有 scope 与初始化机制，不加超时补丁或第二套同步状态。
- 导入与初始化可分离；初始化延后不能因已有空 Session snapshot 先到而永久封住。具体接线在实施前写清，不能只靠“Session 没模型”判断这是首次导入。
- 不更改 shared-host、desktop continuous／mobile replayable、CommandInbox、账号同步或执行中模型绑定；不做历史数据迁移，不批量补写旧导入会话。

## 主要定位

- `packages/services/src/conversation-share/conversationShareService.ts`：导入与 Session 创建。
- `packages/ui/src/root/useRootPlatformEffects.ts`：导入完成后的工作区／Session 激活。
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`：普通新任务与已有 Session 的初始化分支。
- `packages/ui/src/lib/composerRecent.ts`、`packages/ui/src/v4/composer/composerDraftStore.ts`：最近已接纳偏好、草稿存储与隔离。
- [分享功能规范](../../../conversation-share-v1.md)、[Todo71](todo-71-persistent-composer-draft-and-submission-state.md)：实施前同步首次分享导入边界，不推翻已有历史空选择保护。

## 执行与验收

- [x] 更新相关 spec，确定共用初始化入口、首次导入标识与激活时序；先测试再实现。
- [x] 同一工作区对照普通新任务／分享导入：已有草稿、仅 Recent、仅公共默认三种情况，模型身份、思考档位和模式一致；空草稿意图不被默认填满。
- [x] 覆盖无可用模型、Registry 延迟就绪、失效选择、用户先编辑后回包；内容可打开，初始化不覆盖用户意图。
- [x] 覆盖实际目标工作区、远程回退本地、同路径不同 identity；原普通草稿正文及配置均保留。
- [x] 覆盖重复导入和重新打开：保留 Session 草稿／保存选择，不重置已继续对话的任务，不在导入时更新 Recent。
- [ ] 交互用例验证导入打开后工具栏的模型／档位／模式，以及首条提交的完整 modelSelection/mode 和分享 context_refs，不仅检查菜单文案；保持现有 E2E pending／晋级规则。
- [x] 批量运行相关单测、浏览器或可运行 E2E、类型、lint、架构检查；复审全部要求及普通新任务／历史恢复回归，记录多端验证限制后提交。

调查中现有导入服务与 Composer 初始化测试共 27 项通过；它们证明现状相关边界，不代表本 Todo 已实现或新行为已验收。

## 2026-09-12 实施与复审

真实 Hook 与浏览器 10 组通过，Root／Recent／默认、明确空选择、延迟与用户抢先改选、实际 identity、重复导入不覆盖均验证。首条 modelSelection/mode 使用真实冻结函数验证；context_refs 保留通过代码复审与既有单测核对，完整分享服务端→原生 RPC 未实跑，该验收项仍保留。

合批证据、既有失败分类及多端限制见[本轮复审记录](../research/todos-136-139-140-review-20260912.md)。不把未测范围写成通过；未自动 push。
