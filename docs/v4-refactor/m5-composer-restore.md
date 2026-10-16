# M5：v4 会话 composer 还原（输入区能力收口）

## 目标

把 v4 SessionPane 的输入区从 M3 竖切的裸 textarea 还原到旧 UI 的完整能力：
Lexical 编辑器、模式选择、模型选择器、思考深度、context usage、发送键状态机、`/` 候选面板。

## 新旧分界（硬约束：UI 用老的，逻辑新写）

| 层 | 来源 | 说明 |
| --- | --- | --- |
| `LexicalChatInput`（packages/ui/src/LexicalChatInput.tsx） | 从 `b44d4a87a^` 原样恢复 | provider 读存活的 `v4/activeTaskProvider`；`ChatComposerPasteEvent` 收口本文件；保留 `enableMentionPanel` 开关；slash command 固定读取 CLI workspace catalog |
| `ChatPromptEditor` / `ChatPromptActionMenu` / `usePromptEditorDragState`（packages/ui/src/prompt-editor/） | 原样恢复 | 纯 props 展示壳；`onSubmit` 返回值透传（false=保留草稿）是唯一行为适配 |
| `CatalogSlashCommandPlugin`（packages/ui/src/prompt-editor/） | 初期迁移组件，现已删除 | 宿主静态 command 目录通道已退役，当前只保留读取 CLI workspace slash catalog 的 `SlashCommandPlugin` |
| `V4ComposerToolbar`（packages/ui/src/v4/composer/） | 新写 wiring | 复用 ModelConfigSelect / ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage 展示件；当前值读 v4 `snapshot.config` / `snapshot.usage`；写路径 v4 命令 |
| `ConversationComposer`（packages/ui/src/v4/） | 全新重写 | 发送键状态机 + held choice + Stop + dock 布局 |

## 数据面接线

- 模型/思考深度 → `switchModelConfig`。工具条只上抛语义事件
  `onSelectModel(providerId, modelId)` / `onSelectThought(thought)`（value 经
  `decodeCustomModelValue` 解码），**命令参数由 SessionPane 从 snapshotRef（最新投影）补齐**
  ——memo 子组件的 config prop 在连续操作时会落后投影一拍；CAS stale 用
  `ack.revisionAtDecision` 有界重试（连续「切模型→切思考深度」的 revision 竞态）。
- 模式选择 → **新增 additive 命令 `switchCollaborationMode`**（mode ∈ build/edit/plan/yolo，CAS）：
  - CLI handler（`commands/handlers/model-config.ts`）：`app.getMode()` 快照 → `app.setMode(mode)` →
    `runtime.emitModeChanged`（新增 core 方法，补发 `SessionModeChanged(source=command)`；
    `app.setMode` 本身不产事件）。
  - 投影：`onSessionModeChanged` → `config.mode`（additive 字段，带 default `"build"` 不破坏旧帧）。
    plan 工具路径（enterPlanMode/exitPlanMode）的 SessionModeChanged 同样被消费，UI 跟随。
- context usage → `snapshot.usage.contextWindow`（已有字段，ModelComplete 时投影写入），
  UI 复用 ChatContextUsage（`{used: usedTokens, size: maxTokens}`）。
- 模型目录（选择器选项）属配置面：暂走存活服务读（`useModelProviders` +
  `useToolbarConfigOptions(workspacePath, null)`），**死期 = 配置面 v4 化**。
- 发送键状态机（对齐旧 ChatViewComposer）：running+空草稿 → Stop（v4 `stop` 命令，
  自 header 迁入 composer）；running+有草稿 → 「加入队列」；held（inputRouting.mode=choice）→
  清空/保留两钮（M4 testid 契约不变）；pending → spinner；发送失败草稿保留。

## e2e 契约

- `TID_V4_COMPOSER_INPUT` 变为 Lexical contenteditable：`setInputValueByTestIdDom`
  增加 `__zcodeLexicalInputE2E` bridge 分支（驱动真实 editor state；Lexical update
  微任务后才 commit，写入采用轮询确认），spec 断言语义不变。
- Radix 控件驱动口径：受控 DropdownMenu 触发用 WebDriver 真实点击（element.click()
  不含 pointerdown）；Radix SelectItem 的确认合成 pointer 手势会被忽略，统一走
  「item 聚焦 + Enter」键盘路径（`selectRadixOption` helper）+ 菜单关闭校验。
- 可观测性：生产 renderer 日志关闭，v4 命令 ack 摘要写入
  `window.__zcodeV4CommandAcksE2E` 有界环形缓冲（`v4/commandAckObservability.ts`），
  spec 失败报文自动附带。
- M4 调试表单（v4-model-provider-input 等 4 个 testid）退役；`switchV4Model` helper 适配为
  驱动 `TID_CHAT_MODEL_SELECT_*` / `TID_CHAT_THOUGHT_LEVEL_SELECT_*`（真实选择器）。
- 新增 `TID_CHAT_MODE_SELECT_TRIGGER/ITEM`（模式选择 e2e 锚点）；`TID_V4_MODEL_CONFIG`
  锚点扩展 data-mode / data-usage-used / data-usage-max。
- 新 spec：`conversation-session-v4-composer-toolbar.test.ts`（slash 面板出现/过滤/选中、
  模型选择器切 secondary、模式切换投影、usage 投影非零）。

## 本期不做（入口保留，props 开关关闭）

mention/@/# 面板、附件选择/拖拽/粘贴附件、prompt history 持久化——v4 数据面就绪后打开
（`showMentionButton` / `attachmentAction` / `enableExternalFileDrop` / `enableMentionPanel` / `onPaste`）。
另：draft 期投影 `config.mode` 初值固定 `"build"`，持久化偏好非 build 时以首条
SessionModeChanged 为准（TODO M6：draft 期免 revision 的种子通道）。
