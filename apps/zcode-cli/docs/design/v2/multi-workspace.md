# Multi-Workspace / `--add-dir` 设计草案 v2

## 目标

给 ZCode CLI 增加显式多工作区能力，让一次 session 可以同时面向一个主工作区和多个额外工作区。

第一目标不是“允许访问更多路径”，因为当前实现本来就没有在 core 路径层严格拦 workspace 外路径；第一目标是把多工作区变成一等状态：

- 有明确的 session/runtime/permission/context 契约。
- 有稳定的 CLI/TUI/ZCode app-server 入口。
- 有可持久化、可恢复、可审计的 workspace scope。
- 后续 sandbox、resume、skills、AGENTS.md、MCP 可以逐步接上，而不是继续把语义散落在 `cwd` 特判里。

## 语义选择

`--add-dir` 有两种可能的语义：

- 窄语义：“额外可写根目录”。CLI 把目录按 `cwd` 解析成绝对路径，并入 sandbox / permission profile 的 writable roots；当前有效权限不支持扩展 writable roots 时直接报错或警告，不假装生效。侵入点少，但不负责额外目录的 instruction、skills、plugin、session 归组。
- 宽语义：“把目录加入当前 workspace scope”。目录同时并入 tool permission context 和 sandbox allowWrite，参与 instructions、rules、skills、plugin settings 的加载，交互态支持 `/add-dir` 并区分 session-only 与持久化到 local settings。语义完整，但和 trust / permission / sandbox / context 深度耦合，用户感知更像“把另一个 repo 加进当前工作台”。

## 对 ZCode 的建议

不一次性做成宽语义，也不停留在窄语义。建议分阶段推进：

- 状态模型按宽语义设计：把“workspace roots”做成显式 session/runtime 状态。
- 落地节奏从窄处开始：先把 CLI、runtime、session、permission、context 契约打通，再逐步接 skills、AGENTS.md、sandbox、resume。

核心判断：

1. 当前 ZCode 只有单一 `workingDirectory` 一等公民。
2. 当前 `workspaceRoot` 只是 tool context 里的一个单值别名。
3. 当前权限规则只会记 `allow/deny/ask`，没有“额外工作区根目录”的专门契约。
4. 当前路径策略和测试明确允许 workspace 外路径，所以现在加一个 `--add-dir`，如果不先做状态建模，功能价值会很弱，也会误导用户以为这是权限边界。

所以第一步应该是先引入 `WorkspaceScope`，而不是先堆 flag。

## 目标语义

建议把多工作区定义为：

- 一个 session 始终有一个 `primaryRoot`。
- 一个 session 可以有零到多个 `additionalRoots`。
- 一个 session 始终有一个当前 `workingDirectory`，它必须落在某个 root 内。
- 文件工具、grep/glob、bash `cwd`、skills、instructions、resume 策略都读取同一个 `WorkspaceScope`。

建议不要把“多工作区”定义成“多个 session cwd 同时活跃”。活跃 cwd 仍然保持单值，避免把 tool 执行、context 展示和 session 恢复复杂度一下推高。

## 非目标

第一阶段不做：

- 自动发现 sibling repo。
- 像 IDE 一样同时维护多个 active cwd。
- 自动把所有额外目录的完整 git 状态灌进 prompt。
- workspace 级完整 trust UI。
- 基于 workspace roots 的硬性 filesystem deny，除非 execution/fs adapter 也同步接入。

## 推荐的数据模型

新增一组 contracts：

```ts
type WorkspaceRootRole = "primary" | "additional";

interface WorkspaceRoot {
  path: string;          // canonical absolute path
  role: WorkspaceRootRole;
  label?: string;        // basename by default
}

interface WorkspaceScope {
  workspaceId: WorkspaceId;
  primaryRoot: string;
  additionalRoots: string[];
  allRoots: string[];
}
```

建议约束：

- `primaryRoot` 必须是 `allRoots[0]` 的稳定语义来源，但不要求数组顺序对外可见。
- `allRoots` 必须 canonicalize、dedupe、去掉被已有 root 包含的子目录。
- `workingDirectory` 必须满足“位于某个 root 内”。
- `workspaceId` 由 `primaryRoot + sorted(additionalRoots)` 稳定哈希生成。

## 持久化建议

不要第一步改 SQLite schema。

仓库已经有：

- `session.workspace_id`
- `local_setting(scope, scope_id, namespace, key, value, ...)`

因此建议：

- session 继续写 `directory`，但开始填充 `workspaceID`。
- workspace roots 元数据放到 `local_setting`：
  - `scope = "workspace"`
  - `scope_id = workspaceId`
  - `namespace = "workspace"`
  - `key = "roots"`

value shape：

```json
{
  "version": 1,
  "primaryRoot": "/abs/project-a",
  "additionalRoots": ["/abs/project-b"]
}
```

好处：

- 不需要新 migration 就能先跑通。
- 现有 `workspace_id` 列终于有实际用途。
- 后续如果要加 workspace title、recent root、trusted roots，也能继续走同一存储入口。

## CLI / TUI / ZCode app-server 入口

### CLI

第一阶段增加 `--add-dir <path>`，repeatable。

行为：

- 相对路径按 CLI `--cwd` 解析后的主工作目录求绝对路径。
- 启动时建立 `WorkspaceScope` 并注入 runtime。
- 非法目录、重复目录、被已有 root 覆盖的目录给出稳定 warning 或 error。

### TUI

不要一开始做 `/add-dir`，建议直接做：

- `/workspace`
- `/workspace add <path>`
- `/workspace remove <path>`
- `/workspace list`

原因：

- 后续还会有 active root、display、resume、trust 等动作。
- `/add-dir` 太像一次性路径白名单，不利于长期演进。

如果要兼容迁移，可以后续给 `/add-dir` 做 alias 到 `/workspace add`。

### ZCode app-server

ZCode app-server session/new 后续建议允许客户端传 `cwd` 和 `additionalDirectories`。

但第一阶段可以只打通本地 CLI/TUI，ZCode app-server 先维持单工作区。

## Core / Contracts 改动建议

### 1. Runtime 配置

`AgentRuntimeConfig` 不应继续只靠 `workingDirectory` 表达工作区。建议新增：

```ts
interface WorkspaceRuntimeConfig {
  primaryRoot: string;
  additionalRoots: string[];
}
```

并保留：

- `workingDirectory`

作为当前活跃目录，而不是唯一工作区定义。

### 2. ToolExecutionContext

当前只有：

- `workingDirectory`
- `workspaceRoot`

建议演进为：

```ts
workingDirectory: string;
primaryWorkspaceRoot: string;
workspaceRoots: string[];
workspaceRoot: string; // 兼容字段，暂时等于 primaryWorkspaceRoot
```

这样可以分阶段迁移 tool handler，避免一次性改所有工具。

### 3. ContextSourcePort

当前 `ContextSourceRequest` 只有单一 `workingDirectory`。

建议新增：

```ts
workspaceRoots?: string[];
primaryRoot?: string;
```

并扩展 context snapshot，让 instruction / project context 可以按 root 解析。

### 4. ExecutionSandboxPolicy

当前 execution sandbox 契约无法表达额外 roots。建议新增：

```ts
workspaceRoots?: string[];
writableRoots?: string[];
```

即使第一阶段 Node adapter 先不强 enforcement，也要先把契约补齐，否则后面 execution adapter 只能继续吃隐式全局状态。

### 5. Permission 契约

不要把额外目录塞进现有 `PermissionRuleset.allow/deny/ask`。

建议新增独立的 workspace update 契约，例如：

```ts
type PermissionUpdate =
  | {
      type: "addRules";
      behavior: "allow" | "deny" | "ask";
      rules: PermissionRuleValue[];
    }
  | {
      type: "addWorkspaceRoots";
      roots: string[];
      destination: "session" | "workspace";
    }
  | {
      type: "removeWorkspaceRoots";
      roots: string[];
      destination: "session" | "workspace";
    };
```

这样 TUI 审批和未来 `/workspace add --remember` 可以走同一条更新链。

## Context / AGENTS.md / Skills

### 推荐策略

第一阶段：

- `EnvInfo` 仍只展示当前 `workingDirectory` 对应环境。
- `AGENTS.md` / `CLAUDE.md` 继续优先读 active cwd 上溯链。
- 额外 roots 只以“附加 workspace instructions”方式加载各自 root 顶层说明文件，设置单独预算。

第二阶段：

- skills discovery 把每个 additional root 的 `.zcode/skills`、`.agents/skills`、`.claude/skills` 加入 root 列表。
- project context 可以按 root 生成摘要，但不要把每个 root 的完整 package scripts / git status 全塞进 prompt。

### 为什么不建议第一阶段直接接入全部动态上下文

因为 ZCode 当前 context builder、skills adapter、resume、permission 都还是单工作区抽象。一次性把 additional roots 接进所有动态上下文，会放大 prompt 体积、cache miss 和恢复复杂度。

## Resume / Session 归组

当前 `--continue` 和 session list 基本按 `directory` 精确匹配。

建议分两步：

### Phase 1

- session 持久化开始写 `workspaceID`。
- `--continue` 行为先保持对主目录兼容。

### Phase 2

- 如果当前 cwd 落在某个 workspace roots 中，则 `/continue` 和 session list 能按 `workspaceID` 或 “cwd belongs to workspace roots” 查找。
- 旧 session 没有 `workspaceID` 时，回退到当前 directory 逻辑。

## 对现有实现的关键提醒

### 1. 现在的 `--add-dir` 不能拿来宣称安全边界

当前 core path policy 和测试明确允许 workspace 外路径；Bash `cwd` 也允许跳出 root。
所以在 execution/fs adapter 真正吃 `workspaceRoots` 之前：

- `--add-dir` 主要是 workspace membership 语义。
- 不是 filesystem enforcement 语义。

### 2. project permission 和 workspace membership 先分开

project permission 当前是“工具规则”，不是“工作区拓扑”。

如果把 roots 硬塞进 `PermissionRuleset`：

- 会让 `allow/deny/ask` 规则和 workspace topology 混在一起。
- session resume、list、UI 展示也拿不到干净的 workspace 元数据。

## 分阶段实施

### Phase 0: 规格与契约

- 新增本 spec。
- 明确 `WorkspaceScope` / `WorkspaceRoot` contracts。
- 明确 `ExecutionSandboxPolicy`、`ToolExecutionContext`、`ContextSourceRequest` 的增量字段。
- 明确持久化走 `workspace_id + local_setting(scope=workspace)`。

### Phase 1: 最小可用多工作区

- CLI 支持 `--add-dir`。
- bootstrap 构造 `WorkspaceScope`。
- runtime/tool executor/context source 能拿到 `workspaceRoots`。
- session 持久化写入 `workspaceID` 和 workspace roots 元数据。
- TUI 至少能展示当前 workspace roots。

### Phase 2: Workspace-aware context

- 额外 roots 的 AGENTS.md / CLAUDE.md 接入预算化加载。
- skill discovery 支持 additional roots。
- session list / continue 支持 workspace 归组。

### Phase 3: Workspace-aware permission and sandbox

- PermissionUpdate 支持 add/remove workspace roots。
- `/workspace add/remove` 打通 session-only 与 remember。
- execution adapter / sandbox adapter 开始真正消费 `workspaceRoots` / `writableRoots`。

### Phase 4: 深水区能力

- ZCode app-server 多工作区注入。
- workspace-level trust / remember policy。
- active root 切换。
- workspace 级 MCP / plugin / memory 策略。

## 测试清单

第一阶段至少补这些测试：

- CLI `--add-dir` 可重复传入，路径按 `--cwd` 正确归一化。
- 子目录、重复目录、被父目录覆盖的目录会被 dedupe。
- runtime/tool context 能看到 `workspaceRoots`。
- session 首次持久化时写入 `workspaceID`，并能读回 workspace roots 元数据。
- old session 没有 `workspaceID` 时不影响 resume。
- context source 在不传 additional roots 时行为与当前完全一致。

后续阶段再补：

- `/workspace add/remove/list`
- skill roots 叠加
- AGENTS.md 多 root 加载
- execution sandbox roots enforcement
- 从 additional root cwd 恢复同一 workspace session

## 推荐落地顺序

如果马上开始做，我建议顺序是：

1. contracts 先补 `WorkspaceScope` 相关类型。
2. bootstrap/runtime/session persistence 打通 workspace 元数据。
3. CLI `--add-dir` 接入。
4. context / skills / TUI 再逐个接。
5. 最后才做强约束 sandbox。

## 结论

对 ZCode 来说，`--add-dir` 不应该只是“多几个 writable roots”，否则收益太小；也不适合第一刀就做成“全系统深耦合 workspace trust”。

最合适的路径是：

- 先把 `WorkspaceScope` 变成一等状态。
- 再让 `--add-dir` 成为这个状态的一个显式入口。
- 然后按 session/persistence/context/skills/permission/sandbox 的顺序渐进接线。

这样既能尽快得到可用的多工作区能力，也不会把当前单 `cwd` 假设在一次改动里全部打碎。
