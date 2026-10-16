# Git UI 开发现状

更新日期：2026-07-07

## 当前目标

当前阶段已经把 Git pane 的“读真实仓库改动”主链路接上，并补回顶部轻量写操作入口。当前目标是让用户在不离开当前 workspace 的前提下，既能继续浏览改动，也能通过顶部入口完成提交或推送。

## 提交消息生成模型链路

- 顶部“提交”弹窗采用带标准 overlay 的紧凑轻量操作面板：顶部展示当前分支和本次选择范围的 `+/-` 统计，中间是提交信息输入区，底部是提交动作列表。
- 弹窗顶部的当前分支入口复用 `GitBranchSwitcher`，点击后只展开可切换的本地分支列表；切换成功后会重新读取当前分支的提交范围，避免继续展示旧分支的 staged / unstaged 快照。
- 弹窗顶部 `+/-` 统计优先复用当前对话的文件修改 summary，避免当前对话只改了少量文件时被工作区里其他未提交改动放大；没有对话 summary 时才回退到当前提交范围的 Git 统计。
- 提交信息输入区支持手动填写，也支持点击图标先生成；如果用户直接点击 `提交` / `提交并推送` 且消息为空，UI 会先生成 Conventional Commit 消息再继续执行动作。
- 提交面板默认包含未暂存更改，用户可以关闭 `包含未暂存的更改`，此时提交、统计和生成消息都只参考已暂存更改。
- 生成提交消息会随请求携带当前会话最近的用户 / assistant 文本上下文，用于让模型理解本轮修改意图；上下文按消息数和字符数裁剪，且生成结果不得显式写“根据对话”“按用户要求”等元叙述。
- 生成提交消息复用当前 workspace 的当前模型选择；Git service 只负责读取 Git status/diff、构造受限 prompt、校验 Conventional Commit 输出。
- 模型调用链路统一为 `Git service -> IZCodeAgentService -> ZCode Protocol workspace/generateText -> AgentRuntime -> modelAdapter.generateText`。
- UI 不再为提交消息生成预取 Start Plan / zcode-plan 的请求期鉴权材料，也不向 Git service 传 scoped runtime headers。
- Start Plan 的请求期 runtime headers 由 AgentRuntime 在 `modelAdapter.generateText` 每次真实请求前通过 `providerRuntimeHeaders.request` 自动刷新；该机制与普通对话、prompt enhance 等独立模型请求一致。
- Git service 不再直连 OpenAI / Anthropic 兼容 HTTP endpoint，也不解析 provider response / SSE；协议层返回纯文本后由 Git service 做输出清洗和错误收敛。

## 已完成的 UI

### 1. 顶部入口

- `WorkspaceHeader` 顶部工具栏已接入 Git 入口
- 当当前工作区能探测到 `+/-` 行数统计时，顶部会展示“Git 图标 + +/- 统计”的一体化胶囊按钮
- 这块统计在 Git pane 未打开时也会显示，避免用户必须先点开 Git 才知道当前有改动
- 点击该入口会打开或关闭右侧 Git pane

### 2. 右侧 Git pane

- Git 复用现有右侧共享 pane，与 browser / code-viewer 共用同一个槽位
- pane 顶部保留标题和关闭按钮
- 主体区已收敛为更轻的单列阅读模式，避免一开始就堆叠过多操作区

### 3. 顶部 Git 操作入口

- 在 `WorkspaceHeader` 顶部工具栏里，终端切换按钮左侧新增“提交或推送”胶囊入口
- 主按钮按当前 Git 状态优先执行 `提交`，没有未提交更改但存在可推送提交时执行 `推送`
- 入口右侧不再提供三点 / 下拉菜单，避免把提交、推送入口拆成两套并列路径
- `提交` 会打开独立提交弹窗，默认把当前 workspace 作用域内的全部未提交更改一起暂存并提交
- 提交弹窗内额外提供 `提交并推送`，成功提交后立即复用同一 Git service 推送当前分支
- `推送` 会打开独立推送弹窗，执行真实 `git push`；若当前分支尚未建立 upstream，会在首次推送时自动补 `--set-upstream`

### 4. 来源切换

- 支持 4 个来源：
  - `未暂存`
  - `已暂存`
  - `全部分支更改`
  - `上一轮更改`
- 当前选中的来源由 `App` 提升管理，保证顶部入口统计和 Git pane 内容始终来自同一来源

### 5. 文件列表与 diff

- 列表项展示 workspace 相对路径全路径
- 文件项支持展开 / 收起
- 展开后直接展示 inline diff，不再重复显示路径和 `+/-` 统计
- 非 `未暂存` 项会按 section 展示状态 badge，例如 `未跟踪`、`冲突`、`已暂存`
- diff 使用现有 `PatchDiff` 组件，并复用代码预览主题配置

### 6. 文件树侧边栏

- 点击“显示文件树”后，会在 Git pane 右侧展开一个目录侧边栏
- 侧边栏宽度支持拖拽调整，并保留最近一次拖拽后的宽度
- 侧边栏顶部提供“筛选文件...”搜索框，按当前目录树中的文件相对路径做即时筛选
- 侧边栏会展示目录和文件叶子节点；筛选时会保留命中文件的祖先目录，方便继续沿层级定位
- 选择目录后，会过滤主区文件列表
- 选择文件叶子节点后，会把主区收敛到该单文件；再次点击当前选中目录或文件可回到完整列表
- 文件树支持目录折叠 / 展开

### 7. 对话输入区底栏

- 对话输入框内部现在只保留编辑相关控件（输入区、附件、发送 / 停止按钮）
- 当前 agent、当前模型、mode 设置、token 上下文统计从输入框壳体中拆出，统一放到输入框下方的底栏
- Git 分支切换入口与这些状态控件共用同一条底栏，并固定到最右侧，减少输入框内部横向拥挤
- 当前 agent 图标优先跟随“当前正在查看的 task provider”，避免切到历史 task / fork task 时出现展示与真实会话不一致

## 当前数据来源

### 真实 Git 数据

以下来源现在已经接入真实 `IGitService`：

- `未暂存`
- `已暂存`
- `全部分支更改`

接线方式：

- `useGitRepository` 统一通过 `services.gitService` 读取 `refresh / getChanges / getBranchComparison`
- `App` 只拉一次真实仓库快照，header 和 Git pane 复用同一份状态，避免重复执行 Git 命令
- 单文件 diff 改为在 Git pane 中按需调用 `getDiff`，避免顶部入口统计也触发全量 diff 读取

### 半真实数据

- `上一轮更改` 已优先复用当前 task 在 ZCode task store 里的 per-turn 文件快照和摘要
- 这部分是当前 UI 中最接近真实 agent 输出的数据来源

## 当前交互边界

当前版本仍然不是完整 Source Control 工作台，但顶部已经放出一组轻量写操作：

- 已接入前端 `commit`
- 已接入前端 `push`
- 已接入前端 `create branch`

当前仍未放出的写操作：

- 没有前端 `stage / unstage / discard`
- 没有提交区与批量操作区

已接入的只读能力：

- 真实 `git status`
- 真实分支比较
- 真实单文件 diff
- 真实 `user.name / user.email` 读取（当前 UI 暂未展示）

`packages/ui/src/hooks/useGitActions.ts` 仍保留为占位扩展点，后续接 service 时可继续复用这层动作抽象。

## 关键实现文件

- `packages/ui/src/App.tsx`
- `packages/ui/src/v4/ConversationComposer.tsx`
- `packages/ui/src/GitBranchSwitcher.tsx`
- `packages/ui/src/GitActionMenu.tsx`
- `packages/ui/src/WorkspaceHeader.tsx`
- `packages/ui/src/GitPane.tsx`
- `packages/ui/src/git-action-menu/display.ts`
- `packages/ui/src/hooks/useGitRepository.ts`
- `packages/ui/src/lib/workspaceSidePane.ts`
- `packages/services/src/git/gitService.ts`
- `packages/services/src/git/repo/gitCliRepo.ts`

## 当前验证状态

- `pnpm typecheck`：当前仓库未完全通过，存在既有的 shared import / MCP typing 错误，非本轮 Git UI 改动引入
- `pnpm lint`：仓库级 `oxlint` 仍有既有 warning；本轮改动文件已单独通过 `oxlint`
- `pnpm exec vitest run packages/services/test/gitService.test.ts packages/ui/test/gitActionMenuDisplay.test.ts packages/ui/test/gitBranchSwitcherDisplay.test.ts`：通过

## 后续建议

1. 决定 Git pane 是否恢复 `stage / unstage / discard` 与批量操作区
2. 为顶部提交 / 推送菜单补充更多空态、失败态和权限提示
3. 继续补充 Git 为空、非仓库、Git 不可用等场景的交互打磨
