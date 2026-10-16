# UI Explore Shell 分类 unbash 对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 CLI 同源的 `unbash` AST 分析替换 UI Explore 聚合里的 Bash 正则扫字符串逻辑，避免 `pnpm install ... | tail -5` 这类真实执行命令被误展示到“探索”分组下。

**Architecture:** 把浏览器安全的 Bash 解析、只读策略和 Explore 展示分类抽到 `@zcode/shared/shell` 子路径，CLI core 和 UI 同时依赖 shared 纯函数。Node-only 的 git runtime guard 继续留在 `@zcode/core`，避免 Web/移动端 bundle 引入 `node:fs` / `node:path`。UI 的 PowerShell 分类保留现有规则，只把 Unix shell / Bash / sh / zsh 命令切到 shared classifier。

**Tech Stack:** TypeScript, Vitest, `unbash@4.0.1`, `@zcode/shared`, `@zcode/core`, React UI tool-call aggregation.

## Global Constraints

- 这是 UI 展示分类 bugfix，不改变 Bash runtime 执行、权限、sandbox、session stream、desktop continuous 或 web remote replayable 语义。
- 涉及 `packages/ui`，实现前必须阅读并遵守根目录 `DESIGN.md`；本计划不做视觉重设计。
- UI 层禁止直接依赖 `apps/zcode-cli/packages/core` 或 `@zcode/core`。
- Node-only runtime guard（例如读取 `.git` 的逻辑）禁止从 shared 顶层或 browser-facing 子路径导出。
- `packages/ui/src/lib/toolCallAggregation.ts` 继续只做聚合入口；真正修复应落在 `packages/ui/src/lib/exploreToolCall.ts` 和 shared classifier。
- Import 路径保持绝对路径；UI 从 `@zcode/shared/shell` 导入，不写跨域相对路径。
- 注释用中文，只解释 bug 原因和边界，不写空泛注释。
- 不自动提交；只有用户在当前任务明确要求 commit 时才提交。实现完成后可给出 Conventional Commits 消息建议。
- 验证必须至少运行 targeted Vitest、`pnpm typecheck`、`pnpm lint`；如果 Web build 无法完整运行，需要在交付说明列出原因和风险。

---

## Phase 0: 范围锁定与现状复现

### Task 0.1: 锁定误判链路和不可变边界

**Files:**
- Read: `DESIGN.md`
- Read: `docs/ui/tool-display-rendering.md`
- Read: `packages/ui/src/lib/exploreToolCall.ts`
- Read: `packages/ui/src/lib/toolCallAggregation.ts`
- Read: `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts`
- Read: `apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts`

**Interfaces:**
- Consumes: 当前 UI 聚合入口 `shouldAggregateToolCall(toolCall)`。
- Produces: 明确修复边界：只改 shell 展示分类，不改 runtime 执行和权限。

- [ ] **Step 1: 阅读 UI 设计约束**

Run:

```bash
sed -n '1,220p' DESIGN.md
```

Expected: 能确认本次无视觉样式改动；如果本次实现中改 UI 组件，必须保持桌面/Web/移动、明暗主题和 i18n 兼容。

- [ ] **Step 2: 阅读现有 UI 展示语义文档**

Run:

```bash
sed -n '28,44p' docs/ui/tool-display-rendering.md
```

Expected: 能确认语义边界是“只读探查命令进入 Explore，非探查命令保持独立 Run / shell tool”。

- [ ] **Step 3: 复现当前错误分类**

Run:

```bash
node <<'NODE'
const command = 'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5';
const EXECUTE_READ_COMMAND_RE = /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const EXECUTE_WRITE_COMMAND_RE = /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const segments = command.split(/&&|\|\||;/g).map((segment) => segment.trim()).filter(Boolean);
const result = segments.some((segment) => EXECUTE_WRITE_COMMAND_RE.test(segment))
  ? false
  : segments.some((segment) => SHELL_REDIRECT_WRITE_RE.test(segment))
    ? false
    : segments.some((segment) => EXECUTE_READ_COMMAND_RE.test(segment));
console.log(JSON.stringify({ segments, result }, null, 2));
NODE
```

Expected: `result` 是 `true`，且第三段因为包含 `tail -5` 被读命令正则命中。

- [ ] **Step 4: 用 core 现有 dist 验证同一命令在 CLI 语义里不是探查**

Run:

```bash
node --input-type=module <<'NODE'
import { isRuntimeReadOnlyBashCommand, isSearchOrReadBashCommand } from './apps/zcode-cli/packages/core/dist/tool/handlers/bash-semantics.js';
const command = 'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5';
console.log({
  readOnly: isRuntimeReadOnlyBashCommand(command),
  searchOrRead: isSearchOrReadBashCommand(command),
});
NODE
```

Expected:

```text
{
  readOnly: false,
  searchOrRead: { isList: false, isRead: false, isSearch: false }
}
```

---

## Phase 1: 抽出 browser-safe shell shared 模块

### Task 1.1: 新增 `@zcode/shared/shell` 子路径和依赖归属

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `apps/zcode-cli/packages/core/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/shared/src/shell/index.ts`

**Interfaces:**
- Produces: `@zcode/shared/shell` 子路径，供 UI 和 core 导入。
- Produces: shared 拥有 `unbash@4.0.1` 直接依赖。
- Consumes: core 通过 workspace dependency 使用 shared shell helpers。

- [ ] **Step 1: 修改 shared package exports 和依赖**

Edit `packages/shared/package.json`:

```json
{
  "name": "@zcode/shared",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./zcodeEndpoint": "./src/zcodeEndpoint.ts",
    "./shell": "./src/shell/index.ts"
  },
  "dependencies": {
    "unbash": "4.0.1",
    "zod": "^4.3.6"
  },
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix"
  },
  "devDependencies": {
    "typescript": "^6.0.2"
  }
}
```

- [ ] **Step 2: 修改 core package 依赖**

Edit `apps/zcode-cli/packages/core/package.json` dependencies:

```json
{
  "dependencies": {
    "@zcode/contracts": "workspace:*",
    "@zcode/shared": "workspace:*",
    "@zcode/shared-types": "workspace:*",
    "cheerio": "^1.0.0",
    "diff": "^9.0.0"
  }
}
```

Expected: `unbash` 不再是 `@zcode/core` 的直接 dependency，避免 parser 所属权继续留在 agent core。

- [ ] **Step 3: 创建 shared shell 入口**

Create `packages/shared/src/shell/index.ts`:

```ts
export * from "./bash-command-parser.js";
export * from "./bash-display-classifier.js";
export * from "./bash-readonly-policy.js";
export type * from "./bash-readonly-policy-types.js";
```

- [ ] **Step 4: 更新 lockfile**

Run:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` 中 `@zcode/shared` 直接依赖 `unbash@4.0.1`，`@zcode/core` 不再直接列出 `unbash`。

### Task 1.2: 移动 browser-safe Bash parser 和 readonly policy

**Files:**
- Move: `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts` -> `packages/shared/src/shell/bash-command-parser.ts`
- Move: `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy*.ts` -> `packages/shared/src/shell/`
- Modify: moved `packages/shared/src/shell/bash-readonly-policy-argv.ts`
- Test: `packages/shared/test/bashCommandParser.test.ts`

**Interfaces:**
- Produces: `analyzeBashCommand(command: string): BashCommandAnalysis`
- Produces: `isBashCommandPermissionSafe(analysis: BashCommandAnalysis): boolean`
- Produces: `evaluateBashReadonlyPolicy(commandPart, options?): boolean | undefined`
- Produces: `hasKnownBashWriteOption(commandPart): boolean`

- [ ] **Step 1: 移动 parser 和 policy 文件**

Run:

```bash
mkdir -p packages/shared/src/shell
git mv apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts packages/shared/src/shell/bash-command-parser.ts
for file in apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy*.ts; do git mv "$file" packages/shared/src/shell/; done
```

Expected: parser 和 `bash-readonly-policy*` 文件只剩 shared 版本；`apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts` 不移动。

- [ ] **Step 2: 让 readonly policy 去 Node-only `process.platform` 依赖**

Edit `packages/shared/src/shell/bash-readonly-policy-argv.ts`，把函数签名改成：

```ts
import type { BashCommandInvocation } from "./bash-command-parser.js";

export interface BashReadonlyPolicyOptions {
  readonly platform?: string;
}

export function evaluateBashReadonlyPolicy(
  commandPart: BashCommandInvocation,
  options: BashReadonlyPolicyOptions = {},
): boolean | undefined {
  const platform = options.platform ?? "browser";
  if (!areEnvAssignmentsAllowed(commandPart)) return false;
  if (!areRedirectsAllowed(commandPart)) return false;

  const argv = stripSafeCommandWrappers(commandPart.argv);
  if (argv.length === 0) return false;
  if (argv.some(isUnsafeWindowsUncPath)) return false;
  if (argv[0] === "git") return isGitReadOnlyCommand(argv);

  const directArgvResult = evaluateDirectReadonlyArgv(argv);
  if (directArgvResult !== undefined) return directArgvResult;

  const prefixPolicyResult = evaluateReadonlyPrefixPolicy(argv, commandPart.commandText);
  if (prefixPolicyResult !== undefined) return prefixPolicyResult;

  if (READONLY_ALLOW_ANY_ARG_COMMANDS.has(argv[0] ?? "")) return true;
  if (platform === "win32" && argv[0] === "xargs") return undefined;

  const policy = READONLY_COMMAND_POLICIES.get(argv[0] ?? "");
  if (!policy) return undefined;
  if (argv[0] === "cd" && argv.length > 2) return false;
  if (policy.additionalCommandIsDangerousCallback?.(commandPart.commandText, argv.slice(1)))
    return false;
  if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "")) return false;
  if (policy.regex && !policy.regex.test(commandPart.commandText)) return false;
  return true;
}
```

Keep the existing helper functions below this block unchanged unless TypeScript points out an import ordering issue.

- [ ] **Step 3: Export policy options**

Edit `packages/shared/src/shell/bash-readonly-policy.ts`:

```ts
export {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  type BashReadonlyPolicyOptions,
} from "./bash-readonly-policy-argv.js";
export { isSedInPlaceOption } from "./bash-readonly-policy-callbacks.js";
```

- [ ] **Step 4: Add parser regression test**

Create `packages/shared/test/bashCommandParser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzeBashCommand } from "../src/shell/bash-command-parser.js";

describe("bash command parser", () => {
  it("keeps pipeline stages separate so output filters do not hide mutating commands", () => {
    const analysis = analyzeBashCommand(
      'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
    );

    expect(analysis.commands.map((command) => command.name)).toEqual([
      "eval",
      "cd",
      "pnpm",
      "tail",
    ]);
    expect(analysis.commands.map((command) => command.operatorBefore ?? "start")).toEqual([
      "start",
      "sequence",
      "&&",
      "|",
    ]);
    expect(analysis.hasDynamicWords).toBe(true);
    expect(analysis.commands[2]?.redirects).toEqual([
      {
        fileDescriptor: 2,
        operator: ">&",
        target: "1",
      },
    ]);
  });
});
```

- [ ] **Step 5: Run parser test and confirm it passes**

Run:

```bash
pnpm exec vitest run packages/shared/test/bashCommandParser.test.ts
```

Expected: PASS.

---

## Phase 2: Shared Bash Explore 展示分类

### Task 2.1: 新增 Bash display classifier

**Files:**
- Create: `packages/shared/src/shell/bash-display-classifier.ts`
- Test: `packages/shared/test/bashDisplayClassifier.test.ts`

**Interfaces:**
- Produces:
  - `classifyBashCommandForExplore(command: string, options?: BashExploreClassifierOptions): BashExploreClassification`
  - `BashExploreClassification` with `isExplore`, `isSearch`, `isRead`, `isList`, `reason`
- Consumes:
  - `analyzeBashCommand`
  - `isBashCommandPermissionSafe`
  - `evaluateBashReadonlyPolicy`
  - `hasKnownBashWriteOption`

- [ ] **Step 1: Add classifier implementation**

Create `packages/shared/src/shell/bash-display-classifier.ts`:

```ts
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandInvocation,
} from "./bash-command-parser.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  type BashReadonlyPolicyOptions,
} from "./bash-readonly-policy.js";

export type BashExploreClassificationReason =
  | "empty"
  | "unsafe-syntax"
  | "write-command"
  | "non-readonly-command"
  | "non-explore-command"
  | "read-only-explore";

export interface BashExploreClassification {
  readonly isExplore: boolean;
  readonly isList: boolean;
  readonly isRead: boolean;
  readonly isSearch: boolean;
  readonly reason: BashExploreClassificationReason;
}

export type BashExploreClassifierOptions = BashReadonlyPolicyOptions;

const EMPTY_CLASSIFICATION: BashExploreClassification = {
  isExplore: false,
  isList: false,
  isRead: false,
  isSearch: false,
  reason: "empty",
};

const SEARCH_COMMANDS = new Set(["ag", "ack", "egrep", "fgrep", "grep", "locate", "rg"]);
const READ_COMMANDS = new Set([
  "awk",
  "cat",
  "cut",
  "file",
  "head",
  "jq",
  "less",
  "more",
  "pwd",
  "sed",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "uniq",
  "wc",
  "which",
  "whereis",
  "yq",
]);
const LIST_COMMANDS = new Set(["du", "find", "ls", "tree"]);
const NEUTRAL_COMMANDS = new Set(["", ":", "cd", "echo", "false", "printf", "true"]);

export function classifyBashCommandForExplore(
  command: string,
  options: BashExploreClassifierOptions = {},
): BashExploreClassification {
  const analysis = analyzeBashCommand(command);
  if (analysis.commands.length === 0) return { ...EMPTY_CLASSIFICATION };
  if (!isBashCommandPermissionSafe(analysis)) {
    return { ...EMPTY_CLASSIFICATION, reason: "unsafe-syntax" };
  }

  let isList = false;
  let isRead = false;
  let isSearch = false;
  let sawExploreCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) {
      return { ...EMPTY_CLASSIFICATION, reason: "write-command" };
    }
    if (evaluateBashReadonlyPolicy(commandPart, options) !== true) {
      return { ...EMPTY_CLASSIFICATION, reason: "non-readonly-command" };
    }

    const displayCommand = resolveDisplayCommand(commandPart);
    if (NEUTRAL_COMMANDS.has(displayCommand)) {
      continue;
    }

    const bucket = classifyDisplayCommand(displayCommand, commandPart.argv);
    if (!bucket) {
      return { ...EMPTY_CLASSIFICATION, reason: "non-explore-command" };
    }

    sawExploreCommand = true;
    isList ||= bucket === "list";
    isRead ||= bucket === "read";
    isSearch ||= bucket === "search";
  }

  if (!sawExploreCommand) {
    return { ...EMPTY_CLASSIFICATION, reason: "non-explore-command" };
  }

  return {
    isExplore: true,
    isList,
    isRead,
    isSearch,
    reason: "read-only-explore",
  };
}

function resolveDisplayCommand(commandPart: BashCommandInvocation): string {
  const argv = stripDisplayWrappers(commandPart.argv);
  if (argv[0] === "git") {
    return `git ${resolveGitSubcommand(argv) ?? ""}`.trim();
  }
  return argv[0] ?? commandPart.name;
}

function stripDisplayWrappers(argv: readonly string[]): readonly string[] {
  let words = [...argv];
  for (;;) {
    if (words[0] === "command") {
      let index = 1;
      while (words[index] !== undefined && /^-p+$/.test(words[index] ?? "")) index += 1;
      if (words[index] === "--") index += 1;
      if (index >= words.length || words[index]?.startsWith("-")) return words;
      words = words.slice(index);
      continue;
    }
    if (words[0] === "builtin") {
      const index = words[1] === "--" ? 2 : 1;
      if (index >= words.length) return words;
      words = words.slice(index);
      continue;
    }
    if (words[0] === "noglob") {
      if (words.length <= 1) return words;
      words = words.slice(1);
      continue;
    }
    return words;
  }
}

function resolveGitSubcommand(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function classifyDisplayCommand(
  commandName: string,
  argv: readonly string[],
): "list" | "read" | "search" | undefined {
  if (commandName === "git grep") return "search";
  if (
    commandName === "git diff" ||
    commandName === "git log" ||
    commandName === "git show" ||
    commandName === "git status"
  ) {
    return "read";
  }
  if (commandName === "git ls-files" || commandName === "git branch") return "list";
  if (commandName === "git rev-parse" && argv.includes("--show-toplevel")) return "read";
  if (SEARCH_COMMANDS.has(commandName)) return "search";
  if (READ_COMMANDS.has(commandName)) return "read";
  if (LIST_COMMANDS.has(commandName)) return "list";
  return undefined;
}
```

- [ ] **Step 2: Add classifier tests**

Create `packages/shared/test/bashDisplayClassifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyBashCommandForExplore } from "../src/shell/bash-display-classifier.js";

describe("bash display classifier", () => {
  it("rejects package install commands even when output is piped through tail", () => {
    const result = classifyBashCommandForExplore(
      'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
    );

    expect(result).toMatchObject({
      isExplore: false,
      isList: false,
      isRead: false,
      isSearch: false,
    });
    expect(["unsafe-syntax", "non-readonly-command"]).toContain(result.reason);
  });

  it("keeps read-only search pipelines in Explore", () => {
    expect(classifyBashCommandForExplore("grep -R -n foo src | head -20")).toMatchObject({
      isExplore: true,
      isRead: true,
      isSearch: true,
      reason: "read-only-explore",
    });
  });

  it("allows workspace cd before a read-only search command", () => {
    expect(
      classifyBashCommandForExplore('cd "/workspace/project" && grep -R -n "foo" src'),
    ).toMatchObject({
      isExplore: true,
      isSearch: true,
    });
  });

  it("rejects mutating commands that include read-only output filters", () => {
    for (const command of [
      "npm install 2>&1 | tail -20",
      "pnpm add lodash | head",
      "yarn remove left-pad | tail -5",
      "bun install | tail -5",
      "rm -rf dist | cat",
    ]) {
      expect(classifyBashCommandForExplore(command), command).toMatchObject({
        isExplore: false,
      });
    }
  });

  it("rejects dynamic command expansion before read-only tools", () => {
    expect(classifyBashCommandForExplore("grep foo $(touch out.txt)")).toMatchObject({
      isExplore: false,
      reason: "unsafe-syntax",
    });
  });
});
```

- [ ] **Step 3: Run shared classifier tests**

Run:

```bash
pnpm exec vitest run packages/shared/test/bashCommandParser.test.ts packages/shared/test/bashDisplayClassifier.test.ts
```

Expected: PASS.

---

## Phase 3: Core 改为消费 shared shell parser / policy

### Task 3.1: 更新 core imports 并保持权限语义不变

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash-metadata.ts`
- Modify: any remaining core import found by search
- Test: `apps/zcode-cli/packages/core/tests/bash-permission.test.ts`

**Interfaces:**
- Consumes from `@zcode/shared/shell`:
  - `analyzeBashCommand`
  - `isBashCommandPermissionSafe`
  - `evaluateBashReadonlyPolicy`
  - `hasKnownBashWriteOption`
  - `isSedInPlaceOption`
- Produces existing core exports unchanged:
  - `isRuntimeReadOnlyBashCommand`
  - `isSimpleReadOnlyBashCommand`
  - `isSearchOrReadBashCommand`
  - `isSedInPlaceBashCommand`

- [ ] **Step 1: Replace core imports in `bash-semantics.ts`**

Edit import block to:

```ts
import type { ExecutionResult } from "@zcode/contracts";
import {
  analyzeBashCommand,
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  isBashCommandPermissionSafe,
  isSedInPlaceOption,
} from "@zcode/shared/shell";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
```

- [ ] **Step 2: Pass Node platform into runtime readonly policy**

In `isSimpleReadOnlyBashCommand`:

```ts
return (
  commandPart.argv.length > 0 &&
  evaluateBashReadonlyPolicy(commandPart, { platform: process.platform }) === true
);
```

In `isRuntimeReadOnlyBashCommand` loop:

```ts
const policyResult = evaluateBashReadonlyPolicy(commandPart, { platform: process.platform });
```

Expected: CLI keeps the same Windows `xargs` branch behavior while shared browser callers avoid `process`.

- [ ] **Step 3: Search for stale relative imports**

Run:

```bash
rg -n "bash-command-parser|bash-readonly-policy" apps/zcode-cli/packages/core/src
```

Expected: No import points to removed `./bash-command-parser.js` or `./bash-readonly-policy.js`; remaining references either import from `@zcode/shared/shell` or refer to test/documentation text.

- [ ] **Step 4: Run core Bash permission tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-permission.test.ts
```

Expected: PASS. Existing plan-mode read-only behavior must not regress.

### Task 3.2: Keep core search/read classifier behavior stable

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/bash-permission.test.ts`
- Test: same file

**Interfaces:**
- Verifies `isBashInputReadOnly({ command })` rejects the reported command.
- Verifies core remains more conservative than UI display when dynamic expansion exists.

- [ ] **Step 1: Add explicit regression in core permission tests**

Add to `"keeps mutating Bash commands denied in plan mode"` command list:

```ts
'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
"npm install 2>&1 | tail -20",
"pnpm add lodash | head",
```

- [ ] **Step 2: Run focused core test**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-permission.test.ts -t "keeps mutating Bash commands denied in plan mode"
```

Expected: PASS.

---

## Phase 4: UI Explore 聚合改用 shared classifier

### Task 4.1: 替换 UI Bash 正则分类

**Files:**
- Modify: `packages/ui/src/lib/exploreToolCall.ts`
- Test: `packages/ui/test/toolCallBlocks.test.ts`
- Test: `packages/ui/test/toolCallAggregation.test.ts`

**Interfaces:**
- Consumes: `classifyBashCommandForExplore(command)` from `@zcode/shared/shell`
- Produces: `isExploreToolCall({ kind, input }): boolean` keeps public signature unchanged。

- [ ] **Step 1: Change command extraction to preserve complete shell script**

In `packages/ui/src/lib/exploreToolCall.ts`, replace `normalizeCommandCandidate` with:

```ts
function normalizeCommandCandidate(candidate: string): string[] {
  const unwrapped = unwrapShellCommand(candidate);
  return unwrapped.length === 0 ? [] : [unwrapped];
}
```

Expected: UI no longer splits Bash by `&&` / `||` / `;`; `unbash` owns shell structure.

- [ ] **Step 2: Split PowerShell and Bash classification**

Add imports:

```ts
import { classifyBashCommandForExplore } from "@zcode/shared/shell";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
```

Replace the Bash regex constants with PowerShell-specific constants:

```ts
const POWERSHELL_READ_COMMAND_RE =
  /\b(get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b/i;
const POWERSHELL_WRITE_COMMAND_RE =
  /\b(remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b/i;
```

Add helpers:

```ts
function isWrappedPowerShellCommand(command: string): boolean {
  return /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i.test(command.trim());
}

function classifyPowerShellExploreCommand(command: string): boolean | undefined {
  const unwrapped = unwrapShellCommand(command).toLowerCase();
  if (POWERSHELL_WRITE_COMMAND_RE.test(unwrapped)) return false;
  if (isWrappedPowerShellCommand(command) || POWERSHELL_READ_COMMAND_RE.test(unwrapped)) {
    return POWERSHELL_READ_COMMAND_RE.test(unwrapped);
  }
  return undefined;
}

function isExploreShellCommand(command: string): boolean {
  const powerShellResult = classifyPowerShellExploreCommand(command);
  if (powerShellResult !== undefined) return powerShellResult;
  return classifyBashCommandForExplore(command).isExplore;
}
```

- [ ] **Step 3: Use all-command semantics in `isExploreToolCall`**

Replace the shell section with:

```ts
const commands = extractToolCommands(input);
if (commands.length === 0) {
  return false;
}

for (const command of commands) {
  if (!isExploreShellCommand(command)) {
    return false;
  }
}

return true;
```

Expected: 只有所有候选 shell 命令都能确认是探查命令时才聚合；一个输入里混入任意非探查命令都必须保持独立 shell tool。报告里的 install 命令不再聚合，因为唯一候选会被 shared Bash classifier 拒绝。

- [ ] **Step 4: Keep comments focused on the bug**

Add one Chinese comment near `normalizeCommandCandidate`:

```ts
// 修复原因：Bash 的管道/分号/条件执行必须交给 unbash AST 判断；
// 不能先按字符串切段，否则 `pnpm install | tail` 会被尾部 `tail` 误判成探索。
```

### Task 4.2: Add UI regression tests

**Files:**
- Modify: `packages/ui/test/toolCallBlocks.test.ts`
- Modify: `packages/ui/test/toolCallAggregation.test.ts`
- Modify: `packages/ui/test/chatMessage.test.ts`

**Interfaces:**
- Verifies `isExploreToolCall` and aggregation rule both reject install-with-tail.
- Verifies read-only shell pipelines still enter Explore.
- Verifies PowerShell read/write behavior stays unchanged.

- [ ] **Step 1: Add direct `isExploreToolCall` tests**

In `packages/ui/test/toolCallBlocks.test.ts`, extend `describe("isExploreToolCall", ...)`:

```ts
it("does not classify install commands piped through tail as explore", () => {
  expect(
    isExploreToolCall({
      kind: "bash",
      input: {
        command:
          'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
      },
    }),
  ).toBe(false);
});

it("keeps read-only search pipelines classified as explore", () => {
  expect(
    isExploreToolCall({
      kind: "bash",
      input: { command: "grep -R -n foo src | head -20" },
    }),
  ).toBe(true);
});

it("does not classify package manager mutations with read-only output filters as explore", () => {
  for (const command of [
    "npm install 2>&1 | tail -20",
    "pnpm add lodash | head",
    "yarn remove left-pad | tail -5",
    "bun install | tail -5",
  ]) {
    expect(
      isExploreToolCall({
        kind: "bash",
        input: { command },
      }),
      command,
    ).toBe(false);
  }
});
```

- [ ] **Step 2: Add aggregation-level regression**

In `packages/ui/test/toolCallAggregation.test.ts`, add:

```ts
it("does not aggregate install commands whose output is trimmed with tail", () => {
  expect(
    shouldAggregateToolCall({
      toolId: "tool-install-tail",
      kind: "bash",
      title: "Run pnpm install",
      input: {
        command:
          'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
      },
      status: "completed",
    }),
  ).toBe(false);
});

it("still aggregates read-only Bash search pipelines", () => {
  expect(
    shouldAggregateToolCall({
      toolId: "tool-grep-head",
      kind: "bash",
      title: "Search source",
      input: { command: "grep -R -n foo src | head -20" },
      status: "completed",
    }),
  ).toBe(true);
});
```

- [ ] **Step 3: Add chat rendering regression**

In `packages/ui/test/chatMessage.test.ts`, add a case next to `"keeps an independent classifiable non-explore shell tool visible"`:

```ts
it("keeps install output filters as an independent shell tool instead of Explore", () => {
  const html = renderChatMessage({
    id: "assistant-run-install-tail-shell",
    role: "assistant",
    content: "",
    streaming: true,
    timestamp: Date.now(),
    parts: [{ type: "tool-call", toolId: "tool-run-install-tail-shell" }],
    toolCalls: [
      {
        toolId: "tool-run-install-tail-shell",
        kind: "bash",
        title: "Running shell",
        input: {
          command:
            'eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5',
        },
        status: "in_progress",
      },
    ],
  });

  expect(html).toContain("Running shell");
  expect(html).toContain("执行中");
  expect(html).not.toContain("探索");
});
```

- [ ] **Step 4: Run focused UI tests**

Run:

```bash
pnpm exec vitest run packages/ui/test/toolCallBlocks.test.ts packages/ui/test/toolCallAggregation.test.ts packages/ui/test/chatMessage.test.ts -t "install|read-only Bash search pipelines|PowerShell"
```

Expected: PASS for the new cases and existing PowerShell read/write cases.

---

## Phase 5: 文档与跨端验证

### Task 5.1: 更新 UI 工具展示文档

**Files:**
- Modify: `docs/ui/tool-display-rendering.md`

**Interfaces:**
- Produces: 文档明确 Unix shell 用 shared `unbash` AST 分类，PowerShell 继续走命令表分类。

- [ ] **Step 1: Update Explore shell classification paragraph**

In the existing Explore shell classification bullet, append this Chinese sentence:

```md
Unix shell / Bash / sh / zsh 命令必须使用 shared `unbash` AST 分类，不允许先按字符串正则切 `&&` / `;` / pipe 后再按任意片段命中；输出裁剪命令如 `tail` / `head` 不能覆盖前序 `pnpm install` / `npm install` 等非探查命令的展示语义。
```

- [ ] **Step 2: Check doc has no conflicting rule**

Run:

```bash
rg -n "Explore 聚合的 shell|unbash|tail|pnpm install" docs/ui/tool-display-rendering.md
```

Expected: 文档同时保留 PowerShell read/write 规则和新的 Unix shell AST 规则。

### Task 5.2: Final verification

**Files:**
- All changed files.

**Interfaces:**
- Verifies shared, core, and UI all agree on this bug boundary.

- [ ] **Step 1: Run all focused tests**

Run:

```bash
pnpm exec vitest run \
  packages/shared/test/bashCommandParser.test.ts \
  packages/shared/test/bashDisplayClassifier.test.ts \
  packages/ui/test/toolCallBlocks.test.ts \
  packages/ui/test/toolCallAggregation.test.ts \
  packages/ui/test/chatMessage.test.ts \
  apps/zcode-cli/packages/core/tests/bash-permission.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run core typecheck**

Run:

```bash
pnpm --filter @zcode/core typecheck
```

Expected: PASS.

- [ ] **Step 3: Run shared package typecheck through root build graph**

Run:

```bash
pnpm typecheck
```

Expected: PASS. If unrelated pre-existing errors appear, capture exact file paths and error messages.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS or existing warnings only.

- [ ] **Step 5: Verify Web bundle does not pull Node-only modules**

Run:

```bash
pnpm --filter @zcode/web exec vite build --base=/remote/__test__/
```

Expected: PASS. There should be no `node:fs`, `node:path`, or `process is not defined` bundle errors from `@zcode/shared/shell`.

- [ ] **Step 6: Inspect dependency ownership**

Run:

```bash
pnpm list unbash --depth 4 --recursive
```

Expected: `@zcode/shared` owns `unbash@4.0.1`; `@zcode/core` reaches it through `@zcode/shared`, not as a direct dependency.

- [ ] **Step 7: Review diff before handoff**

Run:

```bash
git diff -- packages/shared packages/ui apps/zcode-cli/packages/core docs/ui/tool-display-rendering.md package.json pnpm-lock.yaml
git status --short
```

Expected: Only files in this plan changed. No unrelated user edits are reverted.

---

## Commit Message Suggestion

Only use this if the user explicitly asks for a commit in the current task:

```bash
git add packages/shared packages/ui apps/zcode-cli/packages/core docs/ui/tool-display-rendering.md pnpm-lock.yaml
git commit -m "fix(ui): align Explore shell classification with bash parser"
```

## Execution Checklist

- [ ] Phase 0 completed: root cause and target behavior verified.
- [ ] Phase 1 completed: shared shell parser / policy exists and has no Node-only browser dependency.
- [ ] Phase 2 completed: shared Bash Explore classifier rejects install-with-tail and accepts read-only search pipelines.
- [ ] Phase 3 completed: core imports shared shell helpers and core permission tests pass.
- [ ] Phase 4 completed: UI Explore aggregation uses shared classifier and regression tests pass.
- [ ] Phase 5 completed: docs updated, targeted tests pass, `pnpm typecheck`, `pnpm lint`, and Web build verification complete or documented with exact blockers.
