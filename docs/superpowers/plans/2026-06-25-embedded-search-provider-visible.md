# Embedded Search Branch 实施计划

> For agentic workers: REQUIRED SKILL: Use superpowers:executing-plans to execute this plan step-by-step.

> 2026-06-25 复核修正：ZCode 默认启用 embedded search branch（embedded search gate 开启且 Bash 可用）。provider-visible request 以 embedded branch 合同测试为证据；direct Glob/Grep short description 由 dedicated contract baseline 单独校验。

> 2026-06-25 临时运行时策略：provider-visible embedded branch 继续保持默认开启，但 Bash 执行层暂不注入 `find()` / `grep()` prelude。模型仍会看到并优先使用 Bash 中的 `find` / `grep`，实际命令先依赖用户本地 shell 环境；如果是 CMD 或缺少命令，由首轮 Bash 错误反馈给模型自适应。prelude builder、backend 类型和 adapter 支持代码保留，后续可通过开关恢复。

## 目标

将 ZCode 的 main agent、Agent/Explore subagent、Glob/Grep 工具描述，以及 Bash 中 `find`/`grep` 的运行时行为，统一切换到默认的 **embedded search 分支**。

当前默认 baseline 是 embedded search branch：

1. provider-visible 层：默认不向模型暴露 `Glob` / `Grep` direct tools。
2. Bash prompt：默认不再提示避免用 Bash 直接跑 `find` / `grep`。
3. Plan prompt：默认使用 ``find``/Glob, ``grep``/Grep, and Read。
4. runtime 层：当前临时不注入 embedded search `find()` / `grep()` prelude，先依赖用户本地 `find` / `grep`。

## Embedded search branch 目标行为

- embedded search gate 默认开启；本地 agent 入口等非默认场景可关闭。
- gate 开启且 Bash 可用时：
  - main system broad exploration guidance 使用 ``find`` / ``grep`` via Bash tool。
  - Explore prompt 使用 Bash 下的 `find` / `grep` 指引。
  - Bash prompt 的 avoid list 不再要求避开 `find` / `grep`。
  - Bash 初始化时注入 `find` / `grep` function，由 embedded search backend 执行（bundled 形态下分发到 `bfs` / `ugrep`）。
  - `grep` function 走 `ugrep -G --ignore-files --hidden -I`，并默认排除 `.git/.svn/.hg/.bzr/.jj/.sl`。
  - `grep` 遇到 `-*-filter*`、`-*-pager*`、`-*-view*`、`-*-format-open*`、`-*-config*`、`---*`、`-@*`、`-*-save-config*` 时绕回系统 `grep "$@"`。
  - `find` / `grep` function 在内部 binary 不可执行时会 fallback 到系统命令。
- Windows/Git Bash 分支：
  - 仍要求 POSIX shell 语义，不往 CMD 注入 `find()` / `grep()` function。
  - Git Bash/MSYS/Cygwin 下 `find` / `grep` function 使用 `ARGV0=... "<binary>"` 形式调用，不依赖 Linux/macOS 的 `exec -a`。
  - shell snapshot 会把 Windows 宿主路径转换成 Git Bash 路径，例如 `C:\repo` -> `/c/repo`，并过滤 Git Bash 自动生成的 `winpty` aliases。
- Glob/Grep 工具 prompt 另有 simple/short description 分支：
  - 默认模型属于 short description 分支。
  - 该点只影响 direct Glob/Grep tool description，不等同于 embedded search gate。

## 第一版实现取舍

以下取舍是为了降低第一版实现成本，允许保留，但必须在代码和测试中清楚体现：

- 第一版不实现 `ARGV0=bfs/ugrep` 自分发二进制。
  - ZCode 第一版使用 `internal-cli` backend 接管 `find` / `grep`。
  - 架构事实必须叫 embedded search backend，而不是 internal search shim。
  - 默认 provider-visible 行为保持 embedded search；模型看到并调用 Bash 中的 `find` / `grep`。
  - 预留 `argv0-dispatch` backend 口子，未来可以替换成单 binary 自分发实现，不改 prompt/tool exposure。
  - `internal-cli` 仍然调用宿主真实 `find` / `grep`，但 `grep` 会补齐低成本的默认参数：`-G -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl`。
  - `grep` shell function 和 `internal-cli grep` 必须保留上述特殊参数 bypass 列表，避免把默认参数混入 filter/pager/view/config 等特殊模式。
  - `internal-cli` 不解析或裁剪真实 `find` / `grep` 参数；除上述默认参数和 bypass 外，argv、stdin、stdout、stderr、exit code 必须透明透传。
- 不做 provider/source 判定 gate。
  - 本目标内 gate 不区分 provider/source/variant，统一视为启用。
  - embedded search branch 判断函数必须接收模型信息，形态参考 MCS capability helper。
  - 一期用全局 feature flag 短路判断；后续可以在同一个函数里按模型决定是否进入 embedded search branch。
  - 不读取 provider/source 来判断是否启用。
- 保留 direct Glob/Grep tools 的实现。
  - embedded branch 不暴露 direct tools。
  - non-embedded/direct branch 用于 global flag 关闭或 Bash unavailable 等非默认降级，继续使用现有 Glob/Grep 工具。

## 全局约束

- 先更新/新增 docs，再实现代码。
- 所有新增逻辑要有自动化测试覆盖 provider-visible prompt/tool schema 和 runtime shell wrapping。
- 不改 UI，不触碰 mobile/web remote realtime 语义。
- 不把 provider/source 判定做成可变 gate；当前目标内 gate 统一视为启用。
- embedded search branch 必须通过一个模型感知的 capability 函数判断，不能在 prompt/tool 注册调用点散落判断。
- capability 函数同时接收 Bash shell selection，为后续模型/运行时策略保留上下文；当前 provider-visible embedded branch 不再按 shell dialect 回退。
- 不用 patch-on-patch 的零散判断，统一抽出 branch capability、backend 和 prelude helper。
- 注释如需解释 bug/差异原因，用中文。
- 提交前必须执行：
  - `pnpm --filter @zcode/core typecheck`
  - `pnpm --filter @zcode/core lint`
  - `pnpm --filter @zcode/adapters typecheck`
  - `pnpm --filter @zcode/adapters lint`
  - 相关单测

## Provider-Visible 合同边界

本任务的 provider-visible 验收口径是最终请求体中模型能看到的全部内容，而不是只看 system prompt 的几行文案。默认模型的 embedded branch 必须整组满足以下内容：

1. `tools[]` 默认不暴露 direct `Glob` / `Grep`。
   - main agent 的 provider-visible tools 不应包含 `Glob` / `Grep`。
   - Explore subagent 的 provider-visible tools 不应包含 `Glob` / `Grep`。
2. Bash tool description 默认走 embedded search 分支。
   - `Avoid using Bash to run ...` 中不包含 `find` / `grep`。
3. Explore prompt 默认走 embedded 分支。
   - 使用 `Use \`find\` via Bash for broad file pattern matching`。
   - 使用 `Use \`grep\` via Bash for searching file contents with regex`。
   - Explore allowlist 不包含 direct `Glob` / `Grep`。
4. Plan prompt 默认走 embedded 分支。
   - 使用 ``find``, ``grep``, and Read 查找 patterns/conventions。
5. Agent tool description 默认不列出 direct search tools。
   - Explore description 不能写 `(Tools: Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite)`。
6. Main system guidance 默认不输出 Agent/Explore session guidance。
   - embedded branch 的 simple guidance 不包含这两行；ZCode 保持注释不输出。

当前临时策略下，CMD / legacy shell fallback 不再改变 provider-visible branch：仍默认隐藏 direct `Glob` / `Grep`，Bash prompt 仍允许模型使用 `find` / `grep`。执行层不注入 Bash prelude；如果本地 shell 不支持这些命令，由首轮 Bash 错误反馈给模型自适应。

## 三层架构边界

实现必须拆成三层，避免第一版 `internal-cli` 策略污染 provider-visible contract：

1. Provider-visible branch capability
   - 用一个模型感知函数决定是否进入 embedded search branch，形态参考 MCS 的 `evaluateMidConversationSystemCapability`。
   - 控制 direct Glob/Grep 是否暴露、Bash prompt、Explore prompt、Plan prompt、Agent description、main system guidance。
   - 不关心 Bash 里的 `find` / `grep` 最终由哪种 backend 执行。
2. Bash prelude builder
   - 只负责生成 shell function：
     ```bash
     find() { ... "$@"; }
     grep() { ... "$@"; }
     ```
   - 接收 `EmbeddedSearchBackend`，不硬编码 `zcode __internal-search`。
3. Embedded search backend
   - 第一版使用 `internal-cli` 降低实现成本。
   - 未来允许切换到 `argv0-dispatch`。
   - 切换 backend 不应影响 provider-visible branch capability、prompt tests、tool exposure tests 和 Bash handler 的大部分 wiring。

## Windows Shell 适配边界

- Git Bash：
  - provider-visible policy 可以启用 embedded branch。
  - adapter/prelude 负责把 backend command 与 Windows 绝对路径参数转换为 Git Bash 路径。
  - 当前 backend 仍是 `internal-cli`；未来切到 `argv0-dispatch` 时复用同一 prelude 边界。
- CMD / legacy shell fallback：
  - 当前不禁用 provider-visible embedded branch。
  - 执行层不注入 POSIX function，直接依赖本地 shell 的命令可用性。
  - adapter 层即使收到 `bashPrelude` 也不能向 CMD 注入 POSIX function，作为防误用兜底。
- 本阶段不实现完整 shell snapshot `.sh` 文件生成；该问题单独留到 shell snapshot/prelude 任务。
- 当前临时禁用 Bash prelude 注入；CMD / legacy shell fallback 不再作为 provider-visible branch 的关闭条件，执行层统一先让本地 shell 报错或成功。

## 受影响文件

预期新增：

- `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`
- `apps/zcode-cli/packages/core/tests/runtime-embedded-search-capability.test.ts`
- `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
- `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`
- `apps/zcode-cli/packages/cli/src/internal-search/embedded-search-cli.ts`
- `apps/zcode-cli/packages/cli/tests/internal-search.test.ts`

预期修改：

- `docs/plan/trajectory/embedded-search-provider-visible.md`
- `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
- `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- `apps/zcode-cli/packages/core/src/tool/types.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-prompt.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts`
- `apps/zcode-cli/packages/core/src/subagent/explore.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- `apps/zcode-cli/packages/core/tests/context-builder.test.ts`
- `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
- `apps/zcode-cli/packages/cli/src/run.ts`

用户补充约束：本轮完成后不要自动 commit、不要 push、不要 stage；所有改动留在 unstaged 工作区中等待 review。

## Phase 0：建立实现前基线

### 0.1 检查工作区状态

执行：

```bash
git status --short
```

期望：

- 如果有用户未提交改动，记录文件列表。
- 后续只修改本计划列出的文件。

### 0.2 记录当前 provider-visible 行为

执行：

```bash
pnpm --filter @zcode/core test -- tool-contracts.test.ts context-builder.test.ts
```

期望：

- 当前测试通过。
- 如果失败，先记录失败项，不在本任务中顺手修无关问题。

### 0.3 新增设计文档

创建：

```text
docs/plan/trajectory/embedded-search-provider-visible.md
```

文档内容包括：

- embedded search branch 目标行为：
  - embedded search gate。
  - Bash 初始化注入 `find` / `grep`。
  - main/Explore/Bash prompt 的 embedded 分支。
  - Glob/Grep short description 分支与 gate 的关系。
- ZCode 的实现策略：
  - provider-visible branch capability。
  - provider-visible branch。
  - Bash prelude。
  - embedded search backend。
- 实现取舍：
  - 第一版 backend 使用 `internal-cli`，不直接实现 `ARGV0=bfs/ugrep` 自分发。
  - 预留 `argv0-dispatch` backend，未来可切换到单 binary 自分发实现。
  - gate 统一视为启用，不做 provider/source 判定。
  - branch capability 接收模型信息，一期由全局 feature flag 短路。

验证：

```bash
test -f docs/plan/trajectory/embedded-search-provider-visible.md
```

## Phase 1：抽出 embedded search branch capability

以下 Phase 1-5 是默认 embedded branch 的实现步骤；CMD / legacy shell fallback 会回到 direct Glob/Grep 分支。

### 1.1 编写失败测试

新增：

```text
apps/zcode-cli/packages/core/tests/runtime-embedded-search-capability.test.ts
```

测试覆盖：

- capability input 必须接收 `ModelRef`。
- 默认不传 `embeddedSearchBranchEnabled` + Bash available 启用 embedded search。
- 显式 `embeddedSearchBranchEnabled: true` + Bash unavailable 不启用 embedded search。
- global flag 关闭时短路为 disabled。
- decision context 保留安全的模型信息，形态参考 MCS：
  - `context.modelRef`
  - `context.modelId`
  - `context.providerId`
  - `context.providerKind`
  - `context.baseURL`
- 一期不按 model id/provider/source 判断开关，但测试要证明模型信息已经传入 decision context。

测试命令：

```bash
pnpm --filter @zcode/core test -- runtime-embedded-search-capability.test.ts
```

期望：

- 测试先失败，提示模块不存在或函数不存在。

### 1.2 实现 branch capability helper

新增：

```text
apps/zcode-cli/packages/core/src/embedded-search/capability.ts
```

导出：

```ts
import type { ModelConnectionInfo, ModelConnectionPort, ModelRef } from "@zcode/contracts";

const ENABLE_EMBEDDED_SEARCH_BRANCH = true;

type SanitizedModelConnectionInfo = Omit<ModelConnectionInfo, "apiKey" | "headers">;

export interface EmbeddedSearchBranchCapabilityContext {
  bashAvailable: boolean;
  connection?: ModelConnectionInfo;
  embeddedSearchBranchEnabled?: boolean;
  modelRef: ModelRef;
}

export interface ResolvedEmbeddedSearchBranchCapabilityContext {
  baseURL?: string;
  connection?: SanitizedModelConnectionInfo;
  modelId: string;
  modelRef: ModelRef;
  providerId?: string;
  providerKind?: ModelConnectionInfo["providerKind"];
}

export type EmbeddedSearchBranchCapabilityReason =
  | "supported"
  | "disabled_by_global_flag"
  | "bash_unavailable";

export interface EmbeddedSearchBranchCapabilityDecision {
  context: ResolvedEmbeddedSearchBranchCapabilityContext;
  reason: EmbeddedSearchBranchCapabilityReason;
  useEmbeddedSearchBranch: boolean;
}

export function evaluateEmbeddedSearchBranchCapability(
  context: EmbeddedSearchBranchCapabilityContext,
): EmbeddedSearchBranchCapabilityDecision {
  const resolvedContext = resolveCapabilityContext(context);
  const branchEnabled =
    context.embeddedSearchBranchEnabled ?? ENABLE_EMBEDDED_SEARCH_BRANCH;

  if (!branchEnabled) {
    return {
      context: resolvedContext,
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    };
  }

  if (!context.bashAvailable) {
    return {
      context: resolvedContext,
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    };
  }

  return {
    context: resolvedContext,
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}

export function resolveEmbeddedSearchBranchCapability(input: {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
  modelConnectionPort?: ModelConnectionPort;
  modelRef: ModelRef;
}): EmbeddedSearchBranchCapabilityDecision {
  let connection: ModelConnectionInfo | undefined;
  try {
    connection = input.modelConnectionPort?.resolveConnection(input.modelRef);
  } catch {
    connection = undefined;
  }

  return evaluateEmbeddedSearchBranchCapability({
    bashAvailable: input.bashAvailable,
    connection,
    embeddedSearchBranchEnabled: input.embeddedSearchBranchEnabled,
    modelRef: input.modelRef,
  });
}

function resolveCapabilityContext(
  context: EmbeddedSearchBranchCapabilityContext,
): ResolvedEmbeddedSearchBranchCapabilityContext {
  return {
    baseURL: context.connection?.baseURL,
    connection: context.connection ? sanitizeModelConnectionInfo(context.connection) : undefined,
    modelId: context.connection?.model?.modelId ?? context.modelRef.modelId,
    modelRef: context.modelRef,
    providerId: context.connection?.providerId,
    providerKind: context.connection?.providerKind,
  };
}

function sanitizeModelConnectionInfo(
  connection: ModelConnectionInfo,
): SanitizedModelConnectionInfo {
  const { apiKey: _apiKey, headers: _headers, ...safeConnection } = connection;
  return safeConnection;
}
```

后续模型分支扩展时，只允许在 `evaluateEmbeddedSearchBranchCapability` 内新增判断，例如：

```ts
if (isEmbeddedSearchCapableModel(resolvedContext.modelId)) {
  return {
    context: resolvedContext,
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}
```

说明：

- helper 接收 `modelRef`，现在不按模型开关，后续可以补模型分支。
- `resolveEmbeddedSearchBranchCapability` 形态与 MCS 一致：调用点传入 `modelConnectionPort` 和 `modelRef`，helper 内部安全 resolve/sanitize connection。
- global flag 是一期短路入口，运行时默认读取 `ENABLE_EMBEDDED_SEARCH_BRANCH`；测试和 bench 可以通过 `embeddedSearchBranchEnabled` 显式覆盖。
- global flag 判断不能在各个 prompt builder 或 tool registry 里重复写。
- 目标分支内 gate 统一视为启用，不能按 provider/source/variant 猜测。
- 默认模型的 short prompt/tool wording 仍由现有 model prompt 分支控制，不能和 embedded search branch capability 混在一起。
- helper 必须是纯函数，便于测试和 provider-visible 构造复用。

### 1.3 跑测试

执行：

```bash
pnpm --filter @zcode/core test -- runtime-embedded-search-capability.test.ts
```

期望：

- branch capability 测试通过。

## Phase 2：调整 provider-visible prompt 和 tool exposure

### 2.1 修改 built-in tools 注册逻辑

文件：

```text
apps/zcode-cli/packages/core/src/tool/handlers/index.ts
```

目标：

- embedded branch：不注册 direct `Glob` / `Grep` provider tools。
- direct branch：继续注册 `Glob` / `Grep`。
- 删除当前临时注释式 exclude 逻辑，改为显式参数。
- main agent 和 Explore subagent 都必须复用同一 branch capability decision，避免一个隐藏 tools、另一个仍暴露 tools。

接口形态：

```ts
export interface RegisterBuiltInToolsOptions {
  embeddedSearchEnabled?: boolean;
}

export function registerBuiltInTools(
  registry: ToolRegistry,
  dependencies: BuiltInToolDependencies,
  options: RegisterBuiltInToolsOptions = {},
): void {
  const exposeDirectSearchTools = !options.embeddedSearchEnabled;

  if (exposeDirectSearchTools) {
    registry.register(globToolEntry(dependencies));
    registry.register(grepToolEntry(dependencies));
  }
}
```

验收点：

- 不再通过“注释掉 exclude 逻辑”控制行为。
- 注册行为只由 `embeddedSearchEnabled` 决定。
- 默认 embedded branch 的最终 `tools[]` 不包含 `Glob` / `Grep`。

### 2.2 修改 Bash prompt 分支

文件：

```text
apps/zcode-cli/packages/core/src/tool/handlers/bash-prompt.ts
```

目标：

- embedded branch exact 合同：avoid list 不包含 `find` / `grep`，只保留 ``cat``, ``head``, ``tail``, ``sed``, ``awk``, or ``echo``。
- direct branch 保留当前“避免 Bash 跑 find/grep/cat/head/tail/sed/awk/echo”的 ZCode 规则。

建议接口：

```ts
export interface BuildBashPromptOptions {
  embeddedSearchEnabled?: boolean;
}

export function buildBashPrompt(options: BuildBashPromptOptions = {}): string {
  const avoidTools = options.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return `... ${avoidTools} ...`;
}
```

验收点：

- 对默认 embedded branch，Bash prompt 不再劝模型避开 `find` / `grep`。
- 对默认 embedded branch，Bash prompt 的 avoid list exact 包含 ``cat``, ``head``, ``tail``, ``sed``, ``awk``, or ``echo``。
- direct branch 不受影响。

### 2.3 修改 main Agent tool description

文件：

```text
apps/zcode-cli/packages/core/src/tool/handlers/agent.ts
```

目标：

- embedded branch：Agent/Task description 中不声称 subagent 拥有 `Glob` / `Grep` direct tools。
- direct branch：继续列出 `Glob` / `Grep`。
- embedded branch 的 Explore description 不出现 `(Tools: Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite)` 这类 direct tools 泄漏。

验收点：

- 默认 embedded branch 的 provider-visible tool schema 不出现 Glob/Grep direct tools。
- Agent tool description 也不出现“Tools: Glob, Grep”。

### 2.4 修改 Explore subagent prompt 和 allowed tools

文件：

```text
apps/zcode-cli/packages/core/src/subagent/explore.ts
```

目标：

- embedded branch：
  - allowed tools 不包含 `Glob` / `Grep`。
  - prompt exact 使用 `Use \`find\` via Bash for broad file pattern matching`。
  - prompt exact 使用 `Use \`grep\` via Bash for searching file contents with regex`。
  - Bash read-only 列表允许 `find` 和 `grep`。
- direct branch：
  - allowed tools 包含 `Glob` / `Grep`。
  - prompt 使用 direct `Glob` / `Grep` 表述。

建议接口：

```ts
export interface BuildExploreSubagentOptions {
  embeddedSearchEnabled?: boolean;
}

export function buildExploreAllowedTools(options: BuildExploreSubagentOptions = {}): string[] {
  const baseTools = ["Bash", "Read", "WebFetch", "WebSearch", "TodoWrite"];

  if (options.embeddedSearchEnabled) {
    return baseTools;
  }

  return ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"];
}
```

验收点：

- Explore 的 Glob/Grep 是否出现完全由 branch 决定。
- 文件内注释明确说明 Glob/Grep direct exposure 是 non-embedded branch 行为。
- Explore 的 Bash read-only 命令列表在 embedded branch 包含 `find, grep`。

### 2.5 修改 plan mode prompt

文件：

```text
apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts
```

目标：

- embedded branch：让 Plan prompt 使用 ``find``, ``grep``, and Read 查找 patterns/conventions。
- direct branch：继续使用 `${GLOB_TOOL_NAME}` / `${GREP_TOOL_NAME}`。

验收点：

- 默认 embedded branch 的 provider-visible plan prompt 不出现 direct Glob/Grep guidance。

### 2.6 修改 main system guidance dedicated-tool 列表

文件：

```text
apps/zcode-cli/packages/core/src/context/dynamic-sections.ts
```

目标：

- embedded branch 的 `# Using your tools` dedicated-tool 列表不包含 Glob/Grep。
- direct branch 才能出现 Glob/Grep dedicated-tool guidance。
- 该 section 如果当前 compact prompt 中不启用，也要把 helper 级别分支和测试补齐，避免未来打开时 drift。

验收点：

- 默认 embedded branch 的 main system guidance 不再出现“use Glob/Grep direct tools”的暗示。
- direct branch 的现有 dedicated-tool guidance 不被误删。

### 2.7 修改 session guidance fallback

文件：

```text
apps/zcode-cli/packages/core/src/context/dynamic-sections.ts
```

目标：

- 如果当前 session guidance 仍然会构造 broad exploration fallback，则 embedded branch exact 使用以下字符串：
  - ``find`` or ``grep`` via the Bash tool
- direct branch exact 使用：
  - the Glob or Grep

验收点：

- 不再出现 `Glob or Grep` 少 `the` 或 `via Bash` 少 `the Bash tool` 的 drift。
- 如果该 section 在 compact prompt 中被禁用，测试仍保留 helper 级别覆盖，避免后续开启时 drift。

### 2.8 更新 provider-visible 测试

修改：

```text
apps/zcode-cli/packages/core/tests/tool-contracts.test.ts
apps/zcode-cli/packages/core/tests/context-builder.test.ts
```

新增断言：

- 默认 embedded branch：
  - `tools[].name` 不包含 `Glob` / `Grep`。
  - Bash prompt 不包含“avoid find/grep”。
  - Bash prompt 的 avoid list exact 包含 ``cat``, ``head``, ``tail``, ``sed``, ``awk``, or ``echo``，不包含 `find` / `grep`。
  - main `# Using your tools` dedicated-tool 列表不包含 Glob/Grep。
  - main session fallback 包含 ``find`` or ``grep`` via the Bash tool。
  - Explore guidance exact 包含 `Use \`find\` via Bash for broad file pattern matching`。
  - Explore guidance exact 包含 `Use \`grep\` via Bash for searching file contents with regex`。
  - Explore Bash read-only 列表包含 `find, grep`。
  - Plan prompt 包含 ``find``, ``grep``, and Read。
  - Agent tool description 不包含 `Tools: Glob, Grep`。
- direct branch：
  - `tools[].name` 包含 `Glob` / `Grep`。
  - Glob/Grep short description 继续满足 direct branch 合同基线。

执行：

```bash
pnpm --filter @zcode/core test -- tool-contracts.test.ts context-builder.test.ts
```

期望：

- provider-visible 测试通过。

## Phase 3：新增 internal-cli embedded search backend

### 3.1 编写 internal-cli backend 测试

新增：

```text
apps/zcode-cli/packages/cli/tests/internal-search.test.ts
```

测试覆盖：

- `grep pattern file` 输出真实 `grep` 匹配行。
- `grep -e pattern file` 这类真实 `grep` 参数不能被 ZCode shim 拒绝。
- `grep -Rni --include "*.ts" --exclude-dir ignored pattern .` 透传给真实 `grep`。
- `cat file | grep pattern` 这类 stdin 管道输入必须保留。
- `find . -name "*.ts"` 输出真实 `find` 匹配文件。
- `find . -type f -name "*.ts" -print` 这类真实 `find` predicate 不能被 ZCode shim 拒绝。
- invalid predicate / flag 的 stderr 与 exit code 来自真实命令，而不是 ZCode 私有 unsupported 文案。

执行：

```bash
pnpm --filter @zcode/cli test -- internal-search.test.ts
```

期望：

- 测试先失败，提示模块不存在或命令未接入。

### 3.2 定义 backend launch spec

新增或放入共享类型文件：

```ts
export type EmbeddedSearchBackendKind = "internal-cli" | "argv0-dispatch";

export interface EmbeddedSearchBackend {
  kind: EmbeddedSearchBackendKind;
  command: string;
  args?: string[];
}
```

约束：

- `internal-cli` 是第一版实际启用 backend。
- `argv0-dispatch` 是未来单 binary 自分发 backend 口子，第一版只要求 prelude builder 能生成字符串，不要求 runtime 子命令完整可用。
- Bash handler、ExecutionRequest、adapter tests 都只能传 `EmbeddedSearchBackend`，不能散落 `__internal-search` 字符串。

### 3.3 实现 transparent native passthrough shim

新增：

```text
apps/zcode-cli/packages/cli/src/internal-search/embedded-search-cli.ts
```

导出：

```ts
export type EmbeddedSearchCommand = "grep" | "find";

export interface EmbeddedSearchIo {
  cwd: string;
  stdin?: NodeJS.ReadableStream;
  stdout: { write(chunk: string | Uint8Array): void };
  stderr: { write(chunk: string | Uint8Array): void };
}

export async function runEmbeddedSearchCli(argv: string[], io: EmbeddedSearchIo): Promise<number>;
```

实现策略：

- 第一版 internal backend 不能手写 `find` / `grep` 参数子集解析；模型会生成真实命令参数，子集解析会造成表现退化。
- `__internal-search grep ...` 通过 `spawn("grep", argv)` 透传到宿主真实 `grep`。
- `__internal-search find ...` 通过 `spawn("find", argv)` 透传到宿主真实 `find`。
- stdin、stdout、stderr、cwd、exit code 必须按真实命令语义保留。
- 真实命令支持的全部参数都必须透传；ZCode shim 只验证第一个子命令是 `find` 或 `grep`。
- 后续如果要跨平台提供一致能力，应切换 backend 到 bundled `bfs` / `ugrep` 或 `argv0-dispatch`，不能回到手写参数子集。

说明：

- 这不是 provider-visible 差异；模型仍只看到 Bash `find` / `grep`。
- 与 bundled `bfs` / `ugrep` backend 的不同之处记录在 docs 中。

### 3.5 接入 CLI dispatch

修改：

```text
apps/zcode-cli/packages/cli/src/run.ts
```

目标：

- 支持内部命令：

```bash
zcode __internal-search grep ...
zcode __internal-search find ...
```

验收点：

- 普通 CLI 使用路径不变。
- internal command 不初始化完整交互式 agent runtime。
- internal command 不输出欢迎语、版本 banner、debug 文案。
- 该命令只作为 `EmbeddedSearchBackend.kind === "internal-cli"` 的 backend 实现细节出现。

执行：

```bash
pnpm --filter @zcode/cli test -- internal-search.test.ts
```

期望：

- internal-cli backend 测试通过。

## Phase 4：保留 Bash find/grep prelude 支持代码（当前不注入）

### 4.1 扩展 execution contract

修改：

```text
apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts
```

新增：

```ts
export type EmbeddedSearchBackendKind = "internal-cli" | "argv0-dispatch";

export interface EmbeddedSearchBackend {
  kind: EmbeddedSearchBackendKind;
  command: string;
  args?: string[];
}

export interface ExecutionEmbeddedSearchPrelude {
  kind: "embedded-search";
  backend: EmbeddedSearchBackend;
}
```

在 `ExecutionRequest` 增加：

```ts
bashPrelude?: ExecutionEmbeddedSearchPrelude;
```

约束：

- 只允许 adapter 在 `command.mode === "shell"` 且 `shellProfile === "posix-bash"` 时使用。
- 对 `execFile`、非 Bash shell、非 shell mode 完全无效。

### 4.2 编写 prelude 测试

新增：

```text
apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts
```

测试覆盖：

- 输出包含 `unalias find` / `unalias grep`。
- 输出包含 `find()` shell function。
- 输出包含 `grep()` shell function。
- command 和 args 经过 shell quote。
- `internal-cli` backend 生成 `command <backend> find "$@"` / `command <backend> grep "$@"`。
- `argv0-dispatch` backend 生成 `ARGV0=bfs` / `ARGV0=ugrep` 形态的 shell function。
- 用户命令被拼接在 prelude 后。
- 没有 `bashPrelude` 时不改变命令。

执行：

```bash
pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts
```

期望：

- 测试先失败，提示模块不存在。

### 4.3 实现 prelude helper

新增：

```text
apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts
```

导出：

```ts
import type { ExecutionEmbeddedSearchPrelude } from "@zcode/contracts";

export function applyEmbeddedSearchPrelude(
  command: string,
  prelude?: ExecutionEmbeddedSearchPrelude,
): string {
  if (!prelude || prelude.kind !== "embedded-search") {
    return command;
  }

  const findFunction = buildEmbeddedSearchFunction("find", prelude.backend);
  const grepFunction = buildEmbeddedSearchFunction("grep", prelude.backend);

  return [
    "unalias find 2>/dev/null || true",
    "unalias grep 2>/dev/null || true",
    findFunction,
    grepFunction,
    command,
  ].join("\n");
}
```

`internal-cli` backend 生成：

```bash
find() { command zcode __internal-search find "$@"; }
grep() { command zcode __internal-search grep "$@"; }
```

`argv0-dispatch` backend 预留生成：

```bash
find() { ARGV0=bfs command zcode -S dfs -regextype findutils-default "$@"; }
grep() { ARGV0=ugrep command zcode -G --ignore-files --hidden -I "$@"; }
```

注意：

- shell quote helper 可以复用现有 adapter 内部 quote 函数；如果没有，新增私有 `shellQuote` 并完整测试单引号转义。
- `internal-cli` 使用 `command <quoted backend invocation>` 是为了避免 shell function 递归。
- `argv0-dispatch` 第一版只作为 backend 扩展口子保留；如果没有实际 runtime 支持，不在 runtime config 中启用。
- 该 helper 不负责判断 branch capability，只负责字符串变换。

### 4.4 接入 NodeExecutionAdapter（仅支持有 prelude 的请求）

修改：

```text
apps/zcode-cli/packages/adapters/src/exec/index.ts
apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts
```

接入顺序：

1. 仅当调用方显式传入 `ExecutionRequest.bashPrelude` 且 `shellProfile === "posix-bash"` 时，生成 prelude-wrapped command。
2. 再执行 cwd capture wrapping。
3. 再交给 `resolveExecutionCommand`。

原因：

- cwd capture 必须捕获用户命令执行后的最终 cwd。
- prelude 是 shell 初始化内容，应在用户命令之前生效。

更新测试：

```text
apps/zcode-cli/packages/adapters/tests/exec.test.ts
```

新增 case：

- shell command `grep foo file.txt` 只有在 `bashPrelude` 存在时实际命令含 function 注入。
- cwd capture 和 prelude 同时启用时，cwd capture marker 仍在用户命令之后。

执行：

```bash
pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts exec.test.ts
```

期望：

- adapter 测试通过。

## Phase 5：把 branch capability 贯穿到 runtime 和 Bash handler

### 5.1 给 runtime 配置增加 embedded search backend

修改：

```text
apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts
apps/zcode-cli/packages/core/src/tool/executor/types.ts
```

目标：

- runtime config 携带：

```ts
embeddedSearchBackend?: {
  kind: "internal-cli" | "argv0-dispatch";
  command: string;
  args?: string[];
};
```

CLI 启动 runtime 时填入：

```ts
{
  kind: "internal-cli",
  command: process.execPath,
  args: [resolvedCliEntryPath, "__internal-search"],
}
```

SEA/packaged 场景填入：

```ts
{
  kind: "internal-cli",
  command: process.execPath,
  args: ["__internal-search"],
}
```

实现要求：

- dev Node 模式和 packaged binary 模式分别通过已有 CLI bootstrap 信息判断。
- 不在 core 里直接猜 `process.argv`。
- 如果无法构造 backend，branch capability 即使 enabled，也不注入 runtime prelude，并记录 debug 级原因。
- 第一版实际传入 `internal-cli`；`argv0-dispatch` 只作为后续替换 backend 的稳定接口。
- `createToolExecutor(...)` 的 deps 增加 `embeddedSearchBackend`，由 runtime config 传入。

### 5.2 ToolExecutionContext 透传 branch capability

修改：

```text
apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts
apps/zcode-cli/packages/core/src/tool/types.ts
```

目标：

- 在每次 tool call 上计算一次：

```ts
const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
  bashAvailable: registry.has("Bash"),
  modelConnectionPort: deps.modelConnectionPort,
  modelRef,
});
```

- 传入 `ToolExecutionContext`：

```ts
embeddedSearch: {
  enabled: embeddedSearchDecision.useEmbeddedSearchBranch,
  backend: deps.embeddedSearchBackend,
}
```

验收点：

- provider-visible 构造和 runtime 执行使用同一个 branch capability helper。
- provider-visible branch capability 不依赖 backend kind。
- 不在各个 prompt builder 内重复 model 判断。

### 5.3 Bash handler 暂不设置 bashPrelude

修改：

```text
apps/zcode-cli/packages/core/src/tool/handlers/bash.ts
```

目标：

- provider-visible embedded branch 仍可开启，但 Bash handler 当前不构造：

```ts
bashPrelude: {
  kind: "embedded-search",
  backend: context.embeddedSearch.backend,
}
```

- `context.embeddedSearch.enabled === true` 且 backend 存在时，也先不把 `bashPrelude` 传给 adapter。
- 由用户本地 shell 直接执行 `find` / `grep`；CMD 或缺少命令时，让 Bash 错误反馈给模型自适应。
- prelude 类型、adapter helper 和 backend 代码保留，后续可通过开关恢复。

新增中文注释：

```ts
// 临时策略：provider-visible embedded branch 保持开启，但执行层先不注入
// find()/grep() function，直接依赖用户本地 shell 的 find/grep。
```

更新测试：

```text
apps/zcode-cli/packages/core/tests/bash-handler.test.ts
```

新增 case：

- embedded enabled + backend present：ExecutionRequest 不含 `bashPrelude`。
- embedded enabled + backend absent：ExecutionRequest 不含 `bashPrelude`，不抛错。
- embedded disabled：ExecutionRequest 不含 `bashPrelude`。

执行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

期望：

- Bash handler 测试通过。

### 5.4 注册 tools 时使用 branch capability

修改：

```text
apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts
```

目标：

- runtime 初始化 registry 时：

```ts
const builtInToolAllowlist = resolveBuiltInToolAllowlist(this.config);
const bashAvailableForBuiltIns =
  builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash");

const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
  bashAvailable: bashAvailableForBuiltIns,
  modelConnectionPort: this.modelConnectionPort,
  modelRef: this.defaultModelRef,
});

registerBuiltInTools(registry, dependencies, {
  embeddedSearchEnabled: embeddedSearchDecision.useEmbeddedSearchBranch,
});
```

验收点：

- 不在 built-ins 注册前调用 `registry.has("Bash")` 判断 Bash availability。
- 默认 embedded branch 不暴露 direct Glob/Grep tools。
- global flag disabled 或 Bash unavailable 时，仍保留当前 direct Glob/Grep 行为。

## Phase 6：端到端验证

### 6.1 Provider-visible snapshot 验证

新增或更新测试：

```text
apps/zcode-cli/packages/core/tests/tool-contracts.test.ts
```

断言：

- model `claude-opus-4-8-cc`：
  - tools 不含 `Glob` / `Grep`。
  - Bash description 不劝避 `find` / `grep`。
  - Bash description 的 embedded avoid list exact 是 ``cat``, ``head``, ``tail``, ``sed``, ``awk``, or ``echo``，不包含 `find` / `grep`。
  - main system dedicated-tool guidance 不含 Glob/Grep。
  - session fallback 是 ``find`` or ``grep`` via the Bash tool。
  - Agent description 不泄漏 `Tools: Glob, Grep`。
  - Explore prompt exact 使用 Bash `find` / `grep` 两行。
  - Explore allowed tools 不含 `Glob` / `Grep`。
  - Plan prompt 使用 ``find``, ``grep``, and Read。
- global flag disabled：
  - direct Glob/Grep 仍可出现。
  - Glob/Grep description/schema 的 direct branch 测试保持当前约束。
- Bash unavailable：
  - direct Glob/Grep 仍可出现。
  - provider-visible prompt 不进入 embedded search branch。

执行：

```bash
pnpm --filter @zcode/core test -- tool-contracts.test.ts context-builder.test.ts
```

期望：

- provider-visible tests 通过。

### 6.2 Runtime smoke 验证

新增测试位置优先级：

1. `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
2. 如果需要完整 CLI shim，放到 `apps/zcode-cli/packages/cli/tests/internal-search.test.ts`

构造临时目录：

```text
tmp/
  src/a.ts       // contains "needle"
  src/b.ts       // no match
  README.md      // contains "needle"
```

验证命令：

```bash
grep -n needle src/a.ts
find . -name "*.ts"
```

期望：

- `grep` 返回 internal shim 的输出。
- `find` 返回 internal shim 的输出。
- exit code 与 grep/find 常见语义一致：
  - match：0
  - no match：1
  - unsupported/usage error：2

### 6.3 完整测试命令

执行：

```bash
pnpm --filter @zcode/core test -- runtime-embedded-search-capability.test.ts tool-contracts.test.ts context-builder.test.ts bash-handler.test.ts
pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts exec.test.ts
pnpm --filter @zcode/cli test -- internal-search.test.ts
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core lint
pnpm --filter @zcode/adapters typecheck
pnpm --filter @zcode/adapters lint
pnpm --filter @zcode/cli typecheck
pnpm --filter @zcode/cli lint
```

期望：

- 所有命令通过。
- 如果 CLI package 没有独立 `typecheck` / `lint` script，记录 package.json 实际情况，并执行根级替代命令：

```bash
pnpm typecheck
pnpm lint
```

## Phase 7：收尾与提交

### 7.1 Review diff

执行：

```bash
git diff -- docs/plan/trajectory/embedded-search-provider-visible.md apps/zcode-cli/packages/core apps/zcode-cli/packages/adapters apps/zcode-cli/packages/cli apps/zcode-cli/packages/contracts
```

检查清单：

- provider-visible wording 和 branch 目标一致。
- branch capability helper 没有散落重复判断。
- Glob/Grep direct tools 没有被删除，只是按 branch 暴露。
- Bash prelude 当前不由 Bash handler 注入；adapter 仅在显式收到 `bashPrelude` 时影响 Bash shell request。
- CLI internal search 不输出多余 banner。
- 测试覆盖 exact wording、tool exposure、runtime no-prelude 策略。
- docs 记录了第一版实现取舍。

### 7.2 本轮不 Stage / Commit

用户已补充要求：完成后不要自动 commit、不要 push、不要 stage。实际执行时只保留 unstaged 工作区改动，供用户 review。

### 7.3 最终检查 unstaged diff

执行：

```bash
git diff --stat
git diff
```

确认：

- 没有把 provider-visible request dump 文件纳入提交。
- 没有混入无关格式化。
- 没有修改 UI 或 remote control 文件。

### 7.4 Commit 草稿（本轮不执行）

如果用户 review 后明确要求提交，提交说明可使用：

```text
Switches ZCode's default provider-visible surface to the embedded search branch.

Keeps CMD and legacy shell fallback on the direct Glob/Grep branch, while Bash find/grep are routed through an embedded search backend for supported POSIX shells.

Verification:
- pnpm --filter @zcode/core test -- runtime-embedded-search-capability.test.ts tool-contracts.test.ts context-builder.test.ts bash-handler.test.ts
- pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts exec.test.ts
- pnpm --filter @zcode/cli test -- internal-search.test.ts
- pnpm --filter @zcode/core typecheck
- pnpm --filter @zcode/core lint
- pnpm --filter @zcode/adapters typecheck
- pnpm --filter @zcode/adapters lint
- pnpm --filter @zcode/cli typecheck
- pnpm --filter @zcode/cli lint
```

## 回滚方案

如果 bench 或 runtime smoke 发现 embedded search branch 造成退化：

1. 将 `ENABLE_EMBEDDED_SEARCH_BRANCH` 临时设为 `false`，保留代码但关闭默认入口。
2. 如果需要完全回滚：

```bash
git revert <commit-sha>
```

3. 回滚后重新执行：

```bash
pnpm --filter @zcode/core test -- tool-contracts.test.ts context-builder.test.ts bash-handler.test.ts
pnpm --filter @zcode/adapters test -- exec.test.ts
```

## 验收标准

- 默认 provider-visible request 中不暴露 direct Glob/Grep tools。
- 默认 Bash prompt 不再劝模型避免用 Bash 跑 `find` / `grep`。
- 默认 Explore prompt、Plan prompt 和 Agent description 走 Bash `find` / `grep` wording。
- CMD / legacy shell fallback provider-visible request 暴露 direct Glob/Grep tools。
- Bash runtime 在默认 embedded branch 中通过 injected function 调用 ZCode embedded search backend。
- direct Glob/Grep fallback branch 保留并通过现有 description/schema 测试。
- 所有新增 branch 判断集中在 `embedded-search-capability.ts`，没有散落的 provider/source 判断。
- `internal-cli` 只是第一版 backend strategy，未来可切换到 `argv0-dispatch`。
- 文档记录 embedded search branch 目标行为和第一版实现取舍。
- targeted tests、typecheck、lint 全部通过。
