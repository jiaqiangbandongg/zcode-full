# Git 分支切换与创建底层能力设计

更新日期：2026-04-15

## 文档定位

本文是对现有 Git 架构与底层服务能力的增量设计，聚焦：

- 本地分支列表读取
- 分支切换
- 新建分支并切换
- 切换失败时的结构化阻塞原因返回

本文只讨论 Git 底层能力设计，不展开 UI 交互、弹窗样式、表单细节。

## 当前落地状态

截至 2026-04-15，底层能力已按本文方案落地到以下位置：

- `packages/shared/src/git.ts`
  - 新增本地分支列表、分支切换 / 创建切换的共享 DTO
- `packages/services/src/git/git.ts`
  - `IGitService` 暴露 `getLocalBranches`、`switchBranch`、`createBranchAndSwitch`
- `packages/services/src/git/repo/gitCliRepo.ts`
  - 新增 `git for-each-ref` 本地分支读取
  - 新增 `git switch --no-guess` 切换与 `git switch -c` 创建并切换
  - 新增切换前冲突 / 进行中操作检查，以及失败结果结构化映射
- `packages/services/test/gitService.test.ts`
  - 增加真实 Git 仓库集成测试，覆盖成功路径、no-op、dirty 允许切换、覆盖阻塞、冲突、进行中操作、非法分支名、已有分支、worktree 占用

## 背景

当前项目已经具备稳定的 Git 服务分层：

- `packages/shared/src/git.ts` 定义 Git DTO
- `packages/services/src/git/git.ts` 定义 `IGitService`
- `packages/services/src/git/gitService.ts` 负责高层语义聚合
- `packages/services/src/git/repo/gitCliRepo.ts` 负责 Git CLI 薄封装

现有能力已经覆盖：

- 仓库解析
- status / diff / branch comparison
- stage / unstage / discard / commit
- identity / refresh

因此，这次需求不应引入新的平台层通道，也不应绕开现有 `GitService -> GitCliRepo -> Git CLI` 链路。

## 目标

- 为 UI 提供“当前项目已拉取本地分支”的稳定数据源
- 提供真实分支切换能力
- 提供“新建分支并切换”能力
- 在切换失败时返回可驱动 UI 的结构化阻塞原因
- 保持 local / remote / web 三端统一抽象
- 保持 Git 原生行为，不人为收紧为“只要 dirty 就不允许切换”

## 非目标

- 不做 stash、force switch、discard changes 后再切换
- 不做 remote branch 浏览与拉取
- 不做 branch rename / delete
- 不做 rebase、merge、cherry-pick、submodule 等复杂 Git 工作流
- 不在本设计中直接承诺 UI 提交面板

## 核心决策

### 1. 遵循 Git 原生阻塞模型

本次不采用“只要存在未提交改动就禁止切换”的产品规则。

原因：

- Git 原生允许“存在未提交改动，但这些改动不会被目标分支覆盖”的切换
- 如果产品层一刀切，会比 Git 更保守，和用户预期不一致
- UI 需要提示的是“真实阻塞项”，而不是“仓库不够干净”

因此，切换逻辑以真实 `git switch` 的结果为准。

### 2. 不单独提供布尔型 `canSwitch` 接口

不建议增加 `canSwitchToBranch(): boolean` 这类接口。

原因：

- Git 没有稳定、完整、低成本的 dry-run 切换命令
- 仅凭 `status` 做预判，很容易和真实 `git switch` 结果不一致
- `tracked` 覆盖、`untracked` 覆盖、进行中操作等阻塞项，最好以真实切换命令结果为权威来源

因此，推荐由 `switchBranch` / `createBranchAndSwitch` 直接返回结构化结果：

- 成功：返回新的 `summary`
- 失败：返回 `issues`

如果 UI 需要在点击前做弱提示，可以继续复用现有 `summary`、`getChanges`、`getIdentity` 能力，但不能把它们当作最终准入判断。

### 3. 分支能力继续放在现有 Git 服务域内

新能力仍落在：

`Types -> Config -> Repo -> Service -> Runtime -> UI`

不新增 `IPlatformService` 能力，不新增单独频道。

## 能力范围

### 1. 本地分支列表

用于支撑 UI 展示“当前仓库已存在的本地分支”。

约束：

- 只列 `refs/heads/*`
- 不列 remote-tracking branch
- 分支是 repo 级概念，不按 workspace 子目录裁剪
- 如果当前处于 detached HEAD，则 `currentBranchName` 为空，但仍返回本地分支列表

### 2. 切换分支

输入目标本地分支名，尝试切换。

行为：

- 成功时返回最新仓库摘要
- 如果切换到当前分支，视为成功 no-op
- 如果 Git 原生阻止切换，返回结构化阻塞原因

### 3. 新建分支并切换

默认从当前 `HEAD` 创建新分支并切换。

首版只承诺：

- 用户输入分支名
- 可选传入 `startPoint`
- 不自动推断 remote branch
- 不自动设置复杂跟踪策略

## 接口设计

建议在 `IGitService` 上新增 3 个方法：

```ts
getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
```

建议新增请求类型：

```ts
export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}
```

## Shared DTO 设计

建议在 `packages/shared/src/git.ts` 新增以下类型。

### 分支列表

```ts
export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
}
```

排序建议：

- 当前分支排第一
- 其余按最近提交时间倒序
- 时间相同再按名称升序

### 切换/创建结果

```ts
export type GitBranchMutationAction = "switch" | "create-and-switch";

export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "unknown";

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}
```

语义说明：

- `ok=true` 且 `didChange=true`：真实完成切换
- `ok=true` 且 `didChange=false`：成功 no-op，例如切到当前分支
- `ok=false`：被 Git 原生规则阻止，或输入非法

## Repo 层设计

建议在 `GitCliRepo` 新增以下能力：

```ts
listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult>;
switchBranch(workspacePath: string, targetBranchName: string): Promise<GitBranchMutationResult>;
createBranchAndSwitch(
  workspacePath: string,
  branchName: string,
  startPoint?: string,
): Promise<GitBranchMutationResult>;
```

### 1. listLocalBranches

建议命令：

```bash
git for-each-ref refs/heads \
  --format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)
```

设计要点：

- 使用稳定格式，避免解析人类可读输出
- `cwd` 仍以 `repoRoot` 执行
- detached HEAD 时，`branches` 中可能没有 `isCurrent=true`

### 2. switchBranch

建议命令：

```bash
git switch --no-guess -- <branchName>
```

实际实现时，为避免 `--` 误伤命令结构，推荐使用：

```bash
git switch --no-guess <branchName>
```

设计要点：

- `--no-guess` 避免 Git 因 remote-tracking branch 自动猜测并创建本地分支
- 先做最小前置校验：仓库存在、目标分支名非空
- 真正的阻塞判断以 `git switch` 的 stderr 与 exit code 为准

### 3. createBranchAndSwitch

建议先校验分支名：

```bash
git check-ref-format --branch <branchName>
```

然后执行：

```bash
git switch --no-guess -c <branchName> [startPoint]
```

设计要点：

- 默认从当前 `HEAD` 创建
- `startPoint` 先作为底层扩展口保留，UI 首版可以不暴露
- 若分支已存在，直接返回结构化错误，不做覆盖式创建

## 阻塞模型

### 1. 应直接透传并结构化的阻塞项

#### tracked 文件会被覆盖

Git 常见提示：

- `Your local changes to the following files would be overwritten by checkout`

映射为：

- `tracked-changes-would-be-overwritten`

#### untracked 文件会被覆盖

Git 常见提示：

- `The following untracked working tree files would be overwritten by checkout`

映射为：

- `untracked-changes-would-be-overwritten`

#### 当前存在冲突

可以通过现有 `status` 里的 `isConflicted` 快速发现，也可以在失败时兜底解析 stderr。

映射为：

- `conflicts-present`

#### 仓库存在进行中操作

例如 merge、rebase、cherry-pick、revert、bisect。

建议 repo 层增加轻量检查：

- `MERGE_HEAD`
- `CHERRY_PICK_HEAD`
- `REVERT_HEAD`
- `REBASE_HEAD`
- `rebase-merge/`
- `rebase-apply/`
- `BISECT_LOG`

映射为：

- `operation-in-progress`

这样做的原因是这类状态不一定都通过 `git switch` 给出足够稳定的错误语义，提前识别更利于 UI 解释。

#### 分支正在其他 worktree 中使用

Git 常见提示中会出现：

- `is already checked out at`

映射为：

- `branch-in-other-worktree`

### 2. 不作为阻塞项的情况

- 仓库 dirty，但这些改动不会被目标分支覆盖
- 存在无关路径的 untracked 文件，且目标分支不会占用这些路径
- 切换到当前分支

这几类都应尽量遵循 Git 原生行为。

## Service 层设计

`GitService` 继续承担“高层语义收口”的职责。

建议行为：

- `getLocalBranches` 直接返回 repo 层结果
- `switchBranch` / `createBranchAndSwitch` 在 repo 成功后重新读取 `getStatus`
- 对 repo 返回的原始失败结果做统一映射，保证 UI 永远收到稳定的 DTO

建议在 service 层做一次额外收口：

- 如果当前 `workspacePath` 是 monorepo 子目录，分支操作仍然作用于整个 `repoRoot`
- 返回的 `summary.workspacePath` 仍保留当前 workspace 视角，保持 UI 与其他 Git 能力一致

## 缓存与刷新

当前 `GitCliRepo` 内部会复用进行中的：

- `resolveRepository(workspacePath)`
- `getStatus(workspacePath)`

分支切换与创建属于真实写操作，可能导致：

- `branchName`
- `trackingBranchName`
- `ahead/behind`
- `isDirty`
- diff / branch comparison 基线

全部变化。

因此建议补一个 repo 级缓存失效方法，例如：

```ts
invalidate(workspacePath: string): void;
```

并在以下操作后调用：

- `stage`
- `unstage`
- `discard`
- `commit`
- `switchBranch`
- `createBranchAndSwitch`

这样可以避免刷新过程中复用到切换前的旧快照。

## 推荐调用流

### 1. 打开分支下拉

1. UI 调用 `getLocalBranches`
2. 展示本地分支列表
3. 当前分支根据 `isCurrent` 高亮

### 2. 用户点击切换某个分支

1. UI 调用 `switchBranch`
2. 如果 `ok=true`
   - 用返回的 `summary` 更新仓库状态
   - 触发相关数据刷新
3. 如果 `ok=false`
   - 根据 `issues` 决定提示文案
   - 如果阻塞原因与未提交改动相关，可进一步引导用户进入提交流程

### 3. 用户输入新分支名并确认

1. UI 调用 `createBranchAndSwitch`
2. 成功则更新仓库状态
3. 失败则展示结构化错误

## 与提交能力的关系

本设计不需要新增 `commit` 底层能力。

原因：

- 当前服务已经具备 `stagePaths`
- 当前服务已经具备 `commit`
- 当前服务已经具备 `getIdentity`
- 当前服务已经具备 `getChanges`

这意味着 UI 后续如果要做“检测到阻塞后，引导用户先提交再切换”，底层能力已经足够。

推荐做法是：

- 先完成“切换失败 -> 返回结构化 issues”
- 再由 UI 决定是否弹出提交引导

而不是在本次设计中直接引入 `commitAndSwitch` 这类组合动作。

## 测试建议

建议在 `packages/services/test/gitService.test.ts` 增加覆盖：

- 能列出本地分支，且当前分支标记正确
- clean 仓库切换分支成功
- 切换到当前分支返回 no-op 成功
- dirty 仓库但改动与目标分支无冲突时允许切换
- tracked 文件会被目标分支覆盖时切换失败
- untracked 文件会被目标分支覆盖时切换失败
- 仓库存在 conflict 时返回结构化阻塞
- 仓库存在 merge/rebase 等进行中状态时返回结构化阻塞
- 新建分支并切换成功
- 新建分支名非法
- 新建已存在分支失败
- monorepo 子目录 workspace 下调用仍正确作用于 repoRoot

## 后续扩展点

如果后续产品继续扩展，可以在这个设计上自然演进：

- 支持 remote branch 列表与“基于远端分支创建本地分支”
- 支持 branch rename / delete
- 支持 switch 前的可选 stash 流程
- 支持更细的 branch metadata，例如 ahead/behind、最近提交摘要

这些能力都不应影响本次设计的核心边界：

- 分支操作仍属于 Git 服务域
- 阻塞判断仍尽量以 Git 原生命令结果为准
- UI 负责引导，service 负责提供真实且稳定的能力结果

## UI 落地补充（2026-04-15）

基于本文底层能力，当前 UI 侧补充了以下交互约定：

- 功能入口放在聊天输入框下方，采用独立的 branch pill 触发器，不和模型 / 模式选择混在同一行
- 触发器默认展示当前分支；`detached HEAD` 时展示 detached 状态文案
- 展开后使用带搜索的本地分支列表：
  - 当前分支高亮
  - 当前分支存在未提交改动时，展示“未提交的更改：N 个文件”
  - 底部提供“创建并检出新分支...”入口
- 点击已有分支时直接调用 `switchBranch`
- 点击创建入口后弹出轻量表单，提交时调用 `createBranchAndSwitch`
- 如果切换失败属于 `tracked/untracked changes would be overwritten`
  - 不再直接 toast
  - 改为弹出阻塞卡片，列出会被覆盖的文件及 +/- 统计
  - 用户可继续进入“提交并切换分支”弹窗
- “提交并切换分支”弹窗首版做简化：
  - 默认提交当前 workspace 内全部未提交更改
  - 不提供“包含取消暂存的更改”开关
  - 不提供 push / PR / draft 选项
  - commit 成功后自动重试 `switchBranch`
- 切换 / 创建成功后，UI 会同时刷新：
  - 当前分支入口文案
  - header Git 摘要
  - Git side pane 数据
- 切换失败时优先根据结构化 `issues` 映射用户可读提示，不直接暴露底层 Git 原始错误

这样可以保持责任边界清晰：

- service 继续只负责返回真实 Git 结果
- UI 负责入口布局、提示文案和刷新链路编排
