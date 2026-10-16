# Bash Read File State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Bash runtime 维护 `readFileState`，修复 `Bash cat file` 后 `Edit` 仍报 `File has not been read yet` 的缺口，并补齐 Bash 修改已读文件后的 stale hint。

**Architecture:** 本次只在 agent/core 的 Bash tool runtime 层新增一个保守的 read-state producer，不改 prompt、provider-visible tool 列表、protocol、desktop、UI、remote control。`bashHandler` 在 foreground Bash 返回前先基于旧 read state 生成 stale hint，再按保守的读命令语义回填 Bash 读状态。

**Tech Stack:** TypeScript、Vitest、`unbash`、`@zcode/contracts` 的 `FileSystemPort` / `ExecutionResult` / `BashOutput`、现有 `ReadFileStateMap`。

## Global Constraints

- 本计划只在 Bash runtime 层补 read-state producer，不依赖 prompt 要求模型先 Read。
- 本计划不修改 prompt（包括 `# Using your tools` 段落）。
- 先跳过 seed 相关能力；不实现 `seed_read_state`。
- 先跳过 NotebookEdit；不新增 Notebook 类工具状态。
- 不修改 `packages/ui`，因此无需读取 `DESIGN.md`。
- 不新增 protocol 字段；`staleReadFileStateHint` 已存在于 `BashOutput` contract。
- 不把 Bash read-state metadata 持久化到 session store；初版只维护本 turn/runtime 内 `context.readFileState`。
- 不自动提交 commit；如果执行者被用户明确要求提交，使用 Conventional Commits。
- 完成代码改动后必须运行 `pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts`、`pnpm --filter @zcode/core typecheck`、`pnpm --filter @zcode/core lint`，最终按仓库约束运行 `pnpm typecheck` 和 `pnpm lint`。

---

## Phase 0: Scope And Spec

**Purpose:** 先把行为契约留在 docs，再写代码，符合仓库 NL -> Code 约束。

**Files:**
- Create: `docs/runtime-tools/bash-read-file-state.md`

**Checklist:**

- [ ] 新建 `docs/runtime-tools/bash-read-file-state.md`。
- [ ] 在文档中写明结论：本次改动点是 Bash runtime read-state producer，不是 prompt 文案。
- [ ] 写明 in scope：
  - `Bash cat/head/tail/sed -n/grep` 成功且 Bash stdout 未截断后保守回填 `readFileState`。
  - Bash 写类命令修改已读文件后生成 `staleReadFileStateHint`。
- [ ] 写明 out of scope：
  - `seed_read_state`。
  - NotebookEdit。
  - prompt `# Using your tools`。
  - read-state metadata 持久化。
- [ ] 写明执行顺序：
  - Bash foreground command 完成。
  - 构造 `BashOutput`。
  - 先计算 stale hint，因为它必须基于命令执行前已经存在的 read-state。
  - 再做 Bash read-state backfill。
  - 返回最终 `BashOutput`。

**Suggested doc body:**

```markdown
# Bash Read File State Runtime Contract

## 背景

ZCode 不依赖 `# Using your tools` 之类的 prompt 文案来要求模型先 Read，而是在 Bash runtime 内维护 read-state producer：保守识别的简单读类 Bash 命令会把文件内容写入 readFileState，使后续 Edit/Write 的 read-before-write guard 认为该文件已被读取。

## 本轮范围

- 支持 Bash `cat`、`head`、`tail`、`sed -n`、`grep`/`egrep`/`fgrep` 的保守 read-state backfill；Bash stdout 或 FileSystemPort 读文件结果被截断时不回填。
- 支持 Bash 写类命令修改已读文件后的 `staleReadFileStateHint`。

## 非范围

- 不实现 seed read state。
- 不实现 NotebookEdit。
- 不修改 prompt 或 provider-visible tool 列表。
- 不持久化 Bash 产生的 read-state metadata。

## 运行时顺序

1. Bash foreground command 运行完成。
2. runtime 先构造正常 `BashOutput`。
3. 若命令属于写类命令，扫描执行前已有的 readFileState，发现 mtime 在 Bash 开始后推进则追加 stale hint；hint 文案展示相对 cwd 的前 5 个路径，超出时追加 `and N more`，并使用 `file/files` 单复数。
4. 若命令属于保守识别的读类 Bash 命令，且 Bash stdout 未截断，runtime 重新从 FileSystemPort 读取真实文件并写入 readFileState；若 FileSystemPort 读文件结果被截断，同样跳过回填，避免把模型没看到的完整文件伪装成已读。
5. background、image output、interrupted 不产生 stale hint，也不回填 read-state。
6. 非语义失败的 provider-error 不产生 stale hint，也不回填 read-state；`grep`/`egrep`/`fgrep` 仅在 exit code 为 0 时回填。
```

**Validation:**

```bash
git diff -- docs/runtime-tools/bash-read-file-state.md
```

Expected: 只新增上述 spec 文档，无 runtime 代码变更。

---

## Phase 1: Failing Tests

**Purpose:** 先用单测锁定真实缺口和边界，避免只补 `cat` 一个点。

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

**Test helper changes:**

- [ ] 从 `@zcode/contracts` 引入 `FileSystemPort`、`FileSystemReadTextResult`、`FileSystemStatResult`。
- [ ] 从 `../src/tool/read-file-state.js` 引入 `createReadFileStateKey`。
- [ ] 从 `../src/tool/types.js` 引入 `ReadFileStateMap` 类型。
- [ ] 扩展 `contextWith` options：

```ts
fileSystemPort?: FileSystemPort;
readFileState?: ReadFileStateMap;
```

- [ ] 在返回的 `ToolExecutionContext` 中透传：

```ts
fileSystemPort: options.fileSystemPort,
readFileState: options.readFileState,
```

- [ ] 扩展 `executionResult` options，允许测试设置开始时间：

```ts
startedAt?: Date;
completedAt?: Date;
```

- [ ] 将 `executionResult` 内的时间改成：

```ts
const now = new Date();
const startedAt = options.startedAt ?? now;
const completedAt = options.completedAt ?? startedAt;
```

并返回：

```ts
startedAt,
completedAt,
```

**Add helper in test file:**

```ts
function memoryFileSystemPort(
  files: Record<
    string,
    {
      content: string;
      mtimeMs?: number;
      revisionId?: string;
    }
  >,
): FileSystemPort {
  return {
    async stat(request) {
      const file = files[request.path];
      if (!file) {
        throw new Error(`missing fixture file: ${request.path}`);
      }
      return {
        path: request.path,
        kind: "file",
        sizeBytes: Buffer.byteLength(file.content),
        mtimeMs: file.mtimeMs,
        revision: {
          id: file.revisionId ?? `${request.path}:${file.mtimeMs ?? 0}`,
          mtimeMs: file.mtimeMs,
          sizeBytes: Buffer.byteLength(file.content),
        },
      } satisfies FileSystemStatResult;
    },
    async readTextFile(request) {
      const file = files[request.path];
      if (!file) {
        throw new Error(`missing fixture file: ${request.path}`);
      }
      return {
        path: request.path,
        content: file.content,
        encoding: "utf8",
        bytesRead: Buffer.byteLength(file.content),
        sizeBytes: Buffer.byteLength(file.content),
        truncated: false,
        revision: {
          id: file.revisionId ?? `${request.path}:${file.mtimeMs ?? 0}`,
          mtimeMs: file.mtimeMs,
          sizeBytes: Buffer.byteLength(file.content),
        },
      } satisfies FileSystemReadTextResult;
    },
  } as FileSystemPort;
}
```

**Test cases to add under `describe("bashHandler", ...)`:**

- [ ] `it("backfills readFileState from successful cat before Edit", async () => { ... })`
  - Setup:
    - `filePath = resolve(defaultCommandRoot, ".env.example")`
    - `readFileState = new Map()`
    - `fileSystemPort = memoryFileSystemPort({ [filePath]: { content: "FOO=bar\n", mtimeMs: 1000 } })`
    - `executionPort.run` returns `status: "completed"`, `exitCode: 0`, `stdout: "FOO=bar\n"`
  - Run `bashHandler({ command: "cat .env.example" }, contextWith(...))`
  - Assert:
    - `readFileState.get(createReadFileStateKey(filePath, 1, undefined))?.content === "FOO=bar\n"`
    - `offset === undefined`
    - `limit === undefined`
    - `isPartialView === false`
    - `mtimeMs === 1000`

- [ ] `it("backfills ranged readFileState for head tail and sed print commands", async () => { ... })`
  - Use content `"a\nb\nc\nd\ne\n"`.
  - Run separate cases:
    - `head -n 2 fixture.txt` -> content `"a\nb"`、offset `1`、limit `2`
    - `tail -n 2 fixture.txt` -> content `"d\ne"`、offset `4`、limit `2`
    - `sed -n '2,3p' fixture.txt` -> content `"b\nc"`、offset `2`、limit `2`
  - Each case uses a fresh `readFileState`.

- [ ] `it("backfills full readFileState for grep only when grep exits zero", async () => { ... })`
  - Exit code `0` for `grep needle fixture.txt` writes full file content, offset/limit undefined.
  - Exit code `1` for `grep missing fixture.txt` does not write read-state.

- [ ] `it("does not backfill readFileState for complex or unsafe Bash read commands", async () => { ... })`
  - Assert no read-state for:
    - `cat fixture.txt | head`
    - `cat fixture.txt > out.txt`
    - `cat "$TARGET"`
    - `cat fixture.txt other.txt`
    - `sed -i 's/a/b/' fixture.txt`
    - `head -n 0 fixture.txt`

- [ ] `it("emits stale read hint when a write-like Bash command modifies a previously read file", async () => { ... })`
  - Prepopulate read state:

```ts
readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
  path: filePath,
  content: "old\n",
  isPartialView: false,
  readAt: new Date(500),
  sourceTool: "Read",
  mtimeMs: 1000,
  sizeBytes: 4,
});
```

  - `executionResult.startedAt = new Date(1500)`
  - `fileSystemPort.stat` returns `mtimeMs = 2000`
  - command: `pnpm format`
  - Assert output contains:

```text
[This command modified 1 file you've previously read: fixture.ts. Call Read before editing.]
```

  - Assert `bashToolEntry.formatModelContent?.(output)` also contains the hint text.

- [ ] `it("does not emit stale hint when write-like Bash exits with provider error", async () => { ... })`
  - Cover provider-error path with `status: "failed"`, `exitCode: 2`, `command: "pnpm format"` and a newer mtime.
  - Assert stale hint is not appended.

- [ ] 多个已读文件变更时的 stale hint 路径格式测试
  - Cover 6 changed read files.
  - Assert output uses relative cwd paths, `files`, first 5 paths, and `and 1 more`.

**Run failing tests:**

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected before implementation: the new read-state/stale producer tests fail because Bash handler currently never writes `readFileState` and never fills `staleReadFileStateHint`.

---

## Phase 2: Bash Read-State Helper

**Purpose:** 新增一个小而集中的 runtime helper，承载保守的命令识别、文件读取、read-state 写入、stale hint 生成。

**Files:**
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts`

**Imports:**

```ts
import type { BashOutput, ExecutionResult, FileSystemPort, FileSystemStatResult, TraceContext } from "@zcode/contracts";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";
import { analyzeBashCommand, isBashCommandPermissionSafe, type BashCommandInvocation } from "./bash-command-parser.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";
```

**Public interfaces:**

```ts
interface BashReadFileSource {
  filePath: string;
  startLine?: number;
  endLine?: number;
  tailLines?: number;
  requiresExitZero?: boolean;
}

export async function applyBashReadFileStateEffects(input: {
  command: string;
  context: ToolExecutionContext;
  output: BashOutput;
  result: ExecutionResult;
}): Promise<void>;
```

**Core execution contract:**

```ts
export async function applyBashReadFileStateEffects(input: {
  command: string;
  context: ToolExecutionContext;
  output: BashOutput;
  result: ExecutionResult;
}): Promise<void> {
  const hint = await createStaleReadFileStateHint(input);
  if (hint) input.output.staleReadFileStateHint = hint;
  await backfillReadFileStateFromBash(input);
}
```

**Shared guard:**

- [ ] Implement `shouldSkipBashReadFileStateEffects(output: BashOutput): boolean`:
  - skip when `output.backgroundTaskId` exists
  - skip when `output.isImage === true`
  - skip when `output.interrupted === true`
  - skip provider-error output; non-semantic shell failures produce neither stale hint nor read-state backfill

**Read command parser:**

- [ ] Implement `collectBashReadFileSources(command: string): BashReadFileSource[]`.
- [ ] First reject command if raw text contains any of `|`, `<`, `>`.
- [ ] Use `analyzeBashCommand(command)`.
- [ ] Reject if `!isBashCommandPermissionSafe(analysis)`.
- [ ] Reject if `analysis.hasRedirects`.
- [ ] For every command invocation:
  - Try `parseSedPrintSource`.
  - Else `parseCatSource`.
  - Else `parseHeadSource`.
  - Else `parseTailSource`.
  - Else, only when `analysis.commands.length === 1`, try `parseGrepSource`.
  - Else, if multi-command and command text matches `/^\s*(echo|printf|true|:)\b/`, ignore that segment.
  - Else return `[]`.

**Command-specific rules:**

- [ ] `cat`
  - command name must be `cat`
  - accepted flags: `-n`, `--number`
  - exactly one non-flag file path
  - reject file path `-`
  - returns full source: no offset/limit

- [ ] `head`
  - command name must be `head`
  - default count `10`
  - accepted count forms:
    - `-n N`
    - `--lines N`
    - `--lines=N`
    - `-nN`
    - `-N`
  - count must be positive integer
  - exactly one file path, not `-`
  - returns `{ startLine: 1, endLine: count }`

- [ ] `tail`
  - command name must be `tail`
  - same count parser as `head`
  - returns `{ tailLines: count }`

- [ ] `sed`
  - command name must be `sed`
  - must include quiet mode: `-n`, any short flag containing `n`, `--quiet`, or `--silent`
  - reject `-i`, any short flag containing `i`, `--in-place`, `--in-place=*`, `-e`, `--expression`
  - accepted print expressions:
    - `/^(\d+)p$/`
    - `/^(\d+),(\d+)p$/`
  - exactly one expression and one file path
  - returns matching start/end lines

- [ ] `grep` / `egrep` / `fgrep`
  - command name must be one of `grep`, `egrep`, `fgrep`
  - only accepted when the whole Bash command has exactly one command invocation
  - exactly one pattern argument and one file path
  - reject file path `-`
  - reject file path containing glob characters matched by `/[*?[{]/`
  - accepted flags:
    - short combined flags matching `/^-[niwxEFGPHh]+$/`
    - context short flags matching `/^-[ABC]\d+$/`
    - context long flags matching `/^--(?:after-context|before-context|context)=\d+$/`
    - `-A N`, `-B N`, `-C N` where `N` is digits
    - `--line-number`
    - `--ignore-case`
    - `--word-regexp`
    - `--line-regexp`
    - `--extended-regexp`
    - `--fixed-strings`
    - `--basic-regexp`
    - `--perl-regexp`
    - `--with-filename`
    - `--no-filename`
    - `--color=never`
    - `--color=auto`
  - returns full source with `requiresExitZero: true`

**Backfill algorithm:**

- [ ] Implement `backfillReadFileStateFromBash`.
- [ ] Return early if `shouldSkipBashReadFileStateEffects(output)`.
- [ ] Return early if `!context.fileSystemPort || !context.readFileState`.
- [ ] Collect sources and filter `source.requiresExitZero ? result.exitCode === 0 : true`.
- [ ] Resolve every source file with:

```ts
const resolvedPath = resolveWorkspacePath({
  inputPath: source.filePath,
  operation: "read",
  workingDirectory: context.workingDirectory,
  workspaceRoot: context.workspaceRoot,
});
```

- [ ] Skip if `findLatestReadFileState(context.readFileState, resolvedPath)` returns an entry.
- [ ] `stat` via `context.fileSystemPort.stat({ path: resolvedPath, trace }, { signal })`.
- [ ] Skip if `stat.kind !== "file"`.
- [ ] Skip if `stat.sizeBytes > 10 * 1024 * 1024`.
- [ ] Re-check `context.abortSignal.aborted`; skip if aborted.
- [ ] `readTextFile` via `context.fileSystemPort.readTextFile({ path: resolvedPath, maxBytes: 10 * 1024 * 1024, trace }, { signal })`.
- [ ] Compute selected content:
  - full source: whole content
  - head/sed range: split on `\n`, `start = max(1, startLine)`, `end = max(start, endLine ?? start)`, skip when `start > lineCount`
  - tail: split on `\n`, pop trailing empty line, skip when no lines, `count = min(tailLines, lineCount)`, `offset = lineCount - count + 1`, `limit = count`
- [ ] Set `readFileState`:

```ts
const entry: ReadFileStateEntry = {
  path: resolvedPath,
  content: selectedContent,
  offset,
  limit,
  isPartialView: false,
  readAt: new Date(),
  revisionId: read.revision?.id ?? stat.revision?.id,
  mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs ?? stat.revision?.mtimeMs ?? stat.mtimeMs),
  sizeBytes: read.revision?.sizeBytes ?? stat.revision?.sizeBytes ?? stat.sizeBytes,
};
context.readFileState.set(createReadFileStateKey(resolvedPath, offset ?? 1, limit), entry);
```

- [ ] Do not set `sourceTool: "Bash"` in this phase. Existing type only allows `"Read" | "Write" | "Edit"` and compact projection treats undefined like read-compatible state; widening persistence is intentionally out of scope.
- [ ] Catch and ignore per-file stat/read errors (best-effort).

**Stale hint algorithm:**

- [ ] Implement `createStaleReadFileStateHint`.
- [ ] Return early if `shouldSkipBashReadFileStateEffects(output)`.
- [ ] Return early if `!context.fileSystemPort || !context.readFileState`.
- [ ] Return early unless command matches:

```ts
const WRITE_COMMAND_MARKERS = new RegExp(
  [
    "--write",
    "--fix",
    "--in-place",
    "--auto-correct",
    "\\brun\\s+format\\b",
    "\\brun\\s+fix\\b",
    "\\b(yarn|pnpm)\\s+format\\b",
    "\\blint:file\\b",
    "\\blint:fix\\b",
    "\\bblack\\b",
    "\\bisort\\b",
    "\\bruff\\s+format\\b",
    "\\bcargo\\s+(fmt|fix)\\b",
    "\\brustfmt\\b",
    "\\bgo\\s+fmt\\b",
    "\\bterraform\\s+fmt\\b",
    "\\bdprint\\s+fmt\\b",
    "\\bswiftformat\\b",
    "\\bphpcbf\\b",
  ].join("|"),
);
```

- [ ] For each read-state entry:
  - stat `entry.path`
  - compute `currentMtime = normalizeReadFileStateMtimeMs(stat.revision?.mtimeMs ?? stat.mtimeMs)`
  - compute `entryMtime = normalizeReadFileStateMtimeMs(entry.mtimeMs)`
  - include path only when `currentMtime > result.startedAt.getTime()` and `currentMtime > entryMtime`
- [ ] Return undefined if no paths changed.
- [ ] Return exact provider-facing string shape:

```ts
`[This command modified ${paths.length} ${paths.length === 1 ? "file" : "files"} you've previously read: ${displayPaths}${hiddenSuffix}. Call Read before editing.]`
```

**Trace helper:**

- [ ] Add a local `createBashReadFileStateTrace(context: ToolExecutionContext): TraceContext` mirroring existing Bash/Read/Edit trace shape:

```ts
function createBashReadFileStateTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
```

**Run focused tests:**

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected after Phase 2 only: tests still fail until handler integration imports and calls the helper.

---

## Phase 3: Handler Integration

**Purpose:** 把 helper 接到 foreground Bash 完成路径，保持 output formatter 和 image/background 分支不被污染。

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Do not modify unless tests reveal necessity: `apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts`
- Do not modify: `apps/zcode-cli/packages/contracts/src/tools/bash.ts`
- Do not modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts`

**Steps:**

- [ ] Import helper:

```ts
import { applyBashReadFileStateEffects } from "./bash-read-file-state.js";
```

- [ ] Replace current direct return at the end of `bashHandler`:

```ts
return toBashOutput(result, parsed, context, {
  progressTiming,
  stderrSuffix: cwdDecision.stderrSuffix,
});
```

with:

```ts
const output = await toBashOutput(result, parsed, context, {
  progressTiming,
  stderrSuffix: cwdDecision.stderrSuffix,
});
await applyBashReadFileStateEffects({
  command: parsed.command,
  context,
  output,
  result,
});
return output;
```

- [ ] Do not call helper in `parsed.run_in_background` branch.
- [ ] Do not call helper for `emptyBashOutput`; backfill is tied to actual Bash execution, not empty command.
- [ ] Keep stale hint generation before backfill inside the helper.

**Run focused tests:**

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected: new Bash read-state and stale hint tests pass.

---

## Phase 4: Boundary Hardening

**Purpose:** 防止实现只覆盖 happy path；把保守边界锁死。

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- Modify if gaps are found: `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts`

**Checklist:**

- [ ] Add or verify a test that `cat -n fixture.txt` backfills full content.
- [ ] Add or verify a test that `cat --number fixture.txt` backfills full content.
- [ ] Add or verify a test that `head --lines=2 fixture.txt` works.
- [ ] Add or verify a test that `head -2 fixture.txt` works.
- [ ] Add or verify a test that `tail --lines 2 fixture.txt` works.
- [ ] Add or verify a test that `sed --quiet '3p' fixture.txt` works.
- [ ] Add or verify a test that `sed --expression '3p' fixture.txt` does not backfill.
- [ ] Add or verify a test that `grep -n --color=never needle fixture.txt` backfills only on exit `0`.
- [ ] Add or verify a test that `grep needle "*.txt"` does not backfill.
- [ ] Add or verify a test that a file over 10MB does not backfill.
- [ ] Add or verify a test that existing same-path read state is not overwritten.
- [ ] Add or verify a test that stale hint ignores files whose current mtime is newer than read-state but not newer than Bash `startedAt`.
- [ ] Add or verify a test that stale hint ignores files whose mtime cannot be stat'ed.
- [ ] Add or verify a test that Bash stdout truncation skips read-state backfill.

**Run focused tests:**

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected: all Bash handler tests pass.

---

## Phase 5: Typecheck, Lint, And Final Review

**Purpose:** 确认改动没有越界，没有引入类型和 lint 问题。

**Commands:**

```bash
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core lint
pnpm typecheck
pnpm lint
```

**Checklist:**

- [ ] `pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts` passes.
- [ ] `pnpm --filter @zcode/core typecheck` passes.
- [ ] `pnpm --filter @zcode/core lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] `git diff --stat` only includes:
  - `docs/runtime-tools/bash-read-file-state.md`
  - `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts`
  - `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
  - this plan file if it is part of the same branch.
- [ ] Confirm no changes in:
  - `apps/zcode-cli/packages/contracts/src/tools/bash.ts`
  - `packages/ui`
  - desktop/app/service/protocol files
- [ ] Manually inspect provider-visible output for stale hint:

```text
[This command modified 1 file you've previously read: fixture.ts. Call Read before editing.]
```

- [ ] Manually inspect read-state effect for ticket path:
  - `Bash cat .env.example`
  - next `Edit .env.example`
  - expected: no `File has not been read yet` solely because the previous read was via Bash `cat`.

---

## Risk Notes

- **命令解析风险:** Bash read-state parser 必须是保守白名单。复杂 Bash 不回填是可接受的，误回填不可接受。
- **stale 顺序风险:** stale hint 必须先于 backfill 计算，否则同一个写类命令可能把自己的读状态污染进 stale 检查。
- **range read 语义风险:** `head/tail/sed` 产生的是 range view，但不是 `isPartialView`。这与现有 Read range 语义一致；不要把它标成 partial，否则 Edit/Write 会继续拒绝。
- **metadata 风险:** 不要在本轮扩展 `sourceTool` 或持久化 metadata。否则会牵涉 compact/resume 投影，不属于本次反馈根因。
- **provider-error / truncated stdout 风险:** 非语义失败必须跳过 stale hint 和 read-state backfill；不要让失败 Bash 的 stdout 污染 read-state。Bash stdout 被截断时也必须跳过 backfill，避免把模型没看到的完整文件伪装成已读。`grep`/`egrep`/`fgrep` 仍通过 `requiresExitZero` 只在 exit code 为 0 时回填。

## Implementation Acceptance

本计划完成后，ZCode 应满足：

- `Bash cat .env.example` 能让后续 `Edit .env.example` 通过 read-before-write guard。
- `Bash head/tail/sed -n/grep` 的简单安全形态能按上述保守语义产生 read-state。
- formatter/fixer 类 Bash 命令修改已读文件时，会向模型追加 `Call Read before editing` stale hint。
- 不影响 background Bash、image Bash output、interrupted Bash output。
- 不依赖 prompt 教模型“cat 不算 Read”；runtime 自身提供 read-state producer。
