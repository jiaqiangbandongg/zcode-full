# Bash Session Startup Script Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 ZCode-native 的 session 级 Bash startup `.sh` snapshot 文件，让 Bash tool 在执行模型命令前 source 一个由 ZCode 内部生成、按 session/hash 物化的脚本文件。

**Architecture:** 第一版只做 `.sh` startup snapshot 基础设施，不重新开启 find/grep alias，不改变 main agent provider-visible system prompt，也不改变当前工具暴露策略。`core` 只负责生成内部 startup descriptor；`adapters` 负责把 descriptor 安全物化为 `.sh` 文件并 source；未来 embedded search prelude 可以作为同一个 startup script 的内容片段接入，而不是继续 inline 拼接到每条命令前。

**Tech Stack:** TypeScript, Vitest, `@zcode/contracts`, `@zcode/core`, `@zcode/adapters`, ZCode Bash tool execution boundary.

## Global Constraints

- 本计划只实现方案二：ZCode-native 真 `.sh` startup snapshot，不实现 `ARGV0=bfs/ugrep` 自分发。
- 不重新开启 `find()` / `grep()` alias runtime 注入；`shouldInjectEmbeddedSearchBashPrelude()` 继续返回 `false`。
- provider-visible content 不变：main agent system prompt 不新增 shell snapshot 文案，tools description / exposure 不因本计划变化。
- Bash startup script content 只能来自 ZCode 内部 builder；禁止接受 hook、用户输入或模型命令直接写入 startup script 字段。
- CMD 和 `legacy-shell` 不 source `.sh` startup script；POSIX 和 Git Bash 才 source。
- Git Bash 下 source script path 必须转换成 Git Bash path。
- `.sh` 文件物化路径必须位于 ZCode storage/output root 下，按 session 隔离，文件权限尽量收敛到 owner read/write。
- startup script 必须 side-effect free，除非内部 builder 显式追加函数定义；第一版默认内容只包含注释/guard，不改变用户命令行为。
- 不持久化绝对 `.sh` 文件路径到 session store；resume 后由 adapter 根据 descriptor/content hash 重新物化。
- 不自动 commit 或 push；执行完成后留给用户 review。

---

## Current State

当前已经有两层相关能力，但还没有真正的 `.sh` snapshot 文件：

- session shell selection snapshot：`apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`
  - 固定当前 session 使用的 `ExecutionShellSelection`。
  - settings 切换 shell 只影响新 session。
  - resume 时从 `runtime:bash_shell_selection` session entry 恢复。
- inline Bash prelude：`apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
  - 当前可以把 embedded search prelude inline 拼进 command。
  - 但 runtime 注入已通过 `apps/zcode-cli/packages/core/src/embedded-search/shell.ts` 关闭。

本计划的目标是把 Bash startup 从“inline command 前缀”演进为“adapter 物化 `.sh` 文件，然后 source 文件”，并保留当前行为默认不变。

## Target Shape

执行前的 Bash command 从概念上变成：

```sh
. '/path/to/zcode/session-startup/<script-id>-<hash>.sh'
<model command>
```

核心接口：

```ts
export interface ExecutionBashStartupScript {
  kind: "session-script";
  id: string;
  content: string;
}
```

adapter materializer 负责：

```ts
export function materializeBashStartupScript(
  startup: ExecutionBashStartupScript,
  options: BashStartupScriptMaterializeOptions,
): MaterializedBashStartupScript | undefined;
```

core Bash handler 负责在 Bash tool request 上附带 session startup descriptor：

```ts
bashStartup: createBashSessionStartupScript({
  sessionId: context.sessionId,
})
```

第一版 startup content 是 no-op header；如果 future embedded prelude flag 打开，adapter 会把 embedded search function content 合并进同一个 `.sh` 文件。

---

## File Structure

- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
  - 增加 `ExecutionBashStartupScript` 和 `ExecutionRequest.bashStartup`。
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/bash-startup.ts`
  - 生成 Bash tool 专用的 session startup descriptor。
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - 在 `createExecutionRequest()` 里附带 `bashStartup`。
- Create: `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts`
  - 物化 startup `.sh` 文件，生成 source command，处理 POSIX/Git Bash/CMD 差异。
- Modify: `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
  - 拆出 prelude content builder，保留现有 `applyEmbeddedSearchPrelude()` 兼容测试。
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
  - 在 cwd capture 前应用 startup script source；保留现有 output root 逻辑。
- Create: `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`
  - 覆盖 materialize/source/quoting/Git Bash/CMD skip。
- Modify: `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`
  - 补充 content builder 合并语义。
- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
  - 加真实 shell source `.sh` 的执行集成测试。
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
  - 覆盖 Bash request 带 no-op startup descriptor 且不带 embedded prelude。
- Modify: `apps/zcode-cli/packages/core/tests/embedded-search-shell.test.ts`
  - 确认 alias 注入仍 disabled。
- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`
  - 增加 session startup `.sh` snapshot 的契约说明。

---

### Task 1: Add Execution Bash Startup Contract

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`

**Interfaces:**
- Produces: `ExecutionBashStartupScript`
- Produces: `ExecutionRequest.bashStartup?: ExecutionBashStartupScript`
- Consumes: existing `ExecutionRequest`, `ExecutionEmbeddedSearchPrelude`

- [ ] **Step 1: Add the contract type**

In `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`, insert the new interface after `ExecutionEmbeddedSearchPrelude`:

```ts
export interface ExecutionBashStartupScript {
  /**
   * Internal Bash startup script generated by ZCode. The adapter materializes
   * this into a session/hash-scoped .sh file and sources it before the Bash
   * tool command. This must never accept user hook or model-provided content.
   */
  kind: "session-script";
  /** Stable logical script id. The adapter sanitizes this before using it in paths. */
  id: string;
  /** Complete script content generated by internal builders. */
  content: string;
}
```

- [ ] **Step 2: Add request field**

In the same file, add this field to `ExecutionRequest` after `bashPrelude`:

```ts
  /**
   * Internal Bash startup script used by the Bash tool only. The adapter may
   * materialize this to a .sh file and source it before command execution.
   * This must not be accepted from hooks or generic command runners.
   */
  bashStartup?: ExecutionBashStartupScript;
```

- [ ] **Step 3: Keep `bashPrelude` compatible**

Do not remove `bashPrelude` in this task. It remains the structured embedded-search input so the adapter can later combine it into the same startup script.

- [ ] **Step 4: Run contracts typecheck**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/contracts typecheck
```

Expected: command exits 0.

---

### Task 2: Add Core Bash Startup Descriptor Builder

**Files:**
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/bash-startup.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/embedded-search-shell.test.ts`

**Interfaces:**
- Consumes: `SessionId`
- Produces: `createBashSessionStartupScript(input): ExecutionBashStartupScript`
- Produces: Bash `ExecutionRequest.bashStartup`

- [ ] **Step 1: Add failing Bash handler assertion**

In `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`, extend the existing Bash execution request test or add a focused test:

```ts
it("attaches a session Bash startup script without enabling embedded search aliases", async () => {
  const executionRequests: ExecutionRequest[] = [];
  const executionPort = createRecordingExecutionPort({
    onRun: (request) => {
      executionRequests.push(request);
      return createCompletedExecutionResult({ stdout: "ok\n" });
    },
  });

  await bashHandler(
    { command: "echo ok" },
    createBashToolContext({
      executionPort,
      sessionId: "session-startup-test" as SessionId,
    }),
  );

  expect(executionRequests).toHaveLength(1);
  expect(executionRequests[0]?.bashStartup).toMatchObject({
    kind: "session-script",
    id: "session-startup-test:bash-startup",
  });
  expect(executionRequests[0]?.bashStartup?.content).toContain(
    "Generated by ZCode for Bash tool session startup.",
  );
  expect(executionRequests[0]?.bashPrelude).toBeUndefined();
});
```

Use the local helper names that already exist in `bash-handler.test.ts`; if the helper names differ, keep the same assertion shape and wire it into the existing test fixture.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/core exec vitest run tests/bash-handler.test.ts -t "attaches a session Bash startup script"
```

Expected: fails because `bashStartup` is not populated yet.

- [ ] **Step 3: Create descriptor builder**

Create `apps/zcode-cli/packages/core/src/tool/handlers/bash-startup.ts`:

```ts
import type { ExecutionBashStartupScript, SessionId } from "@zcode/contracts";

export function createBashSessionStartupScript(input: {
  sessionId: SessionId;
}): ExecutionBashStartupScript {
  return {
    kind: "session-script",
    id: `${input.sessionId}:bash-startup`,
    content: [
      "# Generated by ZCode for Bash tool session startup.",
      "# This file is sourced before each Bash tool command in this session.",
      "# It is intentionally side-effect free unless internal builders append functions.",
      "",
    ].join("\n"),
  };
}
```

- [ ] **Step 4: Wire Bash handler**

In `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`, import the builder:

```ts
import { createBashSessionStartupScript } from "./bash-startup.js";
```

Then add `bashStartup` inside `createExecutionRequest()`:

```ts
    bashStartup: createBashSessionStartupScript({
      sessionId: context.sessionId,
    }),
```

Keep the existing `bashPrelude` conditional unchanged:

```ts
    ...(bashPrelude ? { bashPrelude } : {}),
```

- [ ] **Step 5: Confirm embedded search alias flag remains disabled**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/core exec vitest run tests/embedded-search-shell.test.ts
```

Expected: passes and still asserts `shouldInjectEmbeddedSearchBashPrelude()` is `false`.

- [ ] **Step 6: Run Bash handler tests**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected: all Bash handler tests pass.

---

### Task 3: Materialize `.sh` Startup Script in Adapter

**Files:**
- Create: `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`

**Interfaces:**
- Consumes: `ExecutionBashStartupScript`
- Consumes: `ExecutionShellDialect | "legacy-shell"`
- Produces: `materializeBashStartupScript()`
- Produces: `applyBashStartupScriptSource()`

- [ ] **Step 1: Add materializer tests**

Create `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBashStartupScriptSource,
  materializeBashStartupScript,
} from "../src/exec/bash-startup-script.js";

describe("bash startup script materializer", () => {
  it("writes a hash-scoped script and sources it before the command", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      const materialized = materializeBashStartupScript(
        {
          kind: "session-script",
          id: "session/with spaces:bash-startup",
          content: "zcode_startup_marker() { echo startup-ok; }\n",
        },
        {
          rootDir,
          sessionId: "session/with spaces",
          shellDialect: "posix",
        },
      );

      expect(materialized).toBeDefined();
      expect(materialized?.path).toContain("session-with-spaces");
      expect(readFileSync(materialized!.path, "utf8")).toBe(
        "zcode_startup_marker() { echo startup-ok; }\n",
      );
      expect(statSync(materialized!.path).isFile()).toBe(true);

      const command = applyBashStartupScriptSource("zcode_startup_marker", materialized!);
      expect(command).toBe(`. '${materialized!.path}'\nzcode_startup_marker`);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("skips CMD and legacy shell dialects", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "zcode-bash-startup-"));
    try {
      for (const shellDialect of ["cmd", "legacy-shell"] as const) {
        expect(
          materializeBashStartupScript(
            {
              kind: "session-script",
              id: "startup",
              content: "echo no\n",
            },
            {
              rootDir,
              sessionId: "session",
              shellDialect,
            },
          ),
        ).toBeUndefined();
      }
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("converts materialized Windows paths for Git Bash source commands", () => {
    const materialized = {
      path: "C:\\Users\\me\\AppData\\Local\\ZCode\\startup.sh",
      shellPath: "/c/Users/me/AppData/Local/ZCode/startup.sh",
    };

    expect(applyBashStartupScriptSource("echo ok", materialized)).toBe(
      ". /c/Users/me/AppData/Local/ZCode/startup.sh\necho ok",
    );
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/bash-startup-script.test.ts
```

Expected: fails because `bash-startup-script.ts` does not exist.

- [ ] **Step 3: Implement materializer**

Create `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts`:

```ts
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecutionBashStartupScript,
  ExecutionShellDialect,
} from "@zcode/contracts";
import { windowsPathToGitBashPath } from "@zcode/contracts";

type StartupShellDialect = ExecutionShellDialect | "legacy-shell";

export interface BashStartupScriptMaterializeOptions {
  rootDir: string;
  sessionId: string;
  shellDialect?: StartupShellDialect;
}

export interface MaterializedBashStartupScript {
  path: string;
  shellPath: string;
}

export function materializeBashStartupScript(
  startup: ExecutionBashStartupScript | undefined,
  options: BashStartupScriptMaterializeOptions,
): MaterializedBashStartupScript | undefined {
  if (!startup || startup.kind !== "session-script") return undefined;
  if (!supportsBashStartupScript(options.shellDialect)) return undefined;
  if (startup.content.length === 0) return undefined;

  const sessionDir = join(options.rootDir, "bash-startup", sanitizePathSegment(options.sessionId));
  mkdirSync(sessionDir, { recursive: true });

  const hash = hashContent(startup.content);
  const fileName = `${sanitizePathSegment(startup.id)}-${hash}.sh`;
  const path = join(sessionDir, fileName);

  if (!existsSync(path) || readFileSync(path, "utf8") !== startup.content) {
    writeFileSync(path, startup.content, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows may not preserve POSIX mode bits; the file remains in ZCode-owned storage.
    }
  }

  return {
    path,
    shellPath: options.shellDialect === "git-bash" ? windowsPathToGitBashPath(path) : path,
  };
}

export function applyBashStartupScriptSource(
  command: string,
  materialized: MaterializedBashStartupScript | undefined,
): string {
  if (!materialized) return command;
  return [`. ${shellQuote(materialized.shellPath)}`, command].join("\n");
}

function supportsBashStartupScript(shellDialect: StartupShellDialect | undefined): boolean {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

- [ ] **Step 4: Run materializer tests**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/bash-startup-script.test.ts
```

Expected: all tests pass.

---

### Task 4: Wire Startup Script Into Node Execution Adapter

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`

**Interfaces:**
- Consumes: `ExecutionRequest.bashStartup`
- Produces: Bash command whose first line sources the materialized startup script

- [ ] **Step 1: Add integration test for real shell source**

In `apps/zcode-cli/packages/adapters/tests/exec.test.ts`, add a POSIX-only integration test near existing shell execution tests:

```ts
const posixOnly = process.platform === "win32" ? it.skip : it;

posixOnly("sources Bash startup script before executing the command", async () => {
  const outputRootDir = mkdtempSync(join(tmpdir(), "zcode-exec-startup-"));
  try {
    const adapter = new NodeExecutionAdapter({
      outputRootDir,
      platform: process.platform,
      processEnv: process.env,
    });

    const result = await adapter.run({
      command: {
        mode: "shell",
        command: "zcode_startup_marker",
        shellProfile: "posix-bash",
      },
      bashStartup: {
        kind: "session-script",
        id: "integration-startup",
        content: "zcode_startup_marker() { echo startup-ok; }\n",
      },
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout.text.trim()).toBe("startup-ok");
  } finally {
    rmSync(outputRootDir, { force: true, recursive: true });
  }
});
```

Add missing imports at the top if this file does not already have them:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Run integration test and verify failure**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/exec.test.ts -t "sources Bash startup script"
```

Expected: fails because adapter does not source `bashStartup` yet.

- [ ] **Step 3: Import startup helpers in adapter**

In `apps/zcode-cli/packages/adapters/src/exec/index.ts`, add:

```ts
import {
  applyBashStartupScriptSource,
  materializeBashStartupScript,
} from "./bash-startup-script.js";
```

- [ ] **Step 4: Replace inline-only prelude application with startup materialization**

In `NodeExecutionAdapter.spawnChild()`, after `resolvedCommand` is computed and before `createCwdCapturePlan(...)`, compute a request with startup applied:

```ts
    const requestWithStartup = this.applyBashStartupToExecutionRequest(
      request,
      resolvedCommand.cwdDialect,
    );
```

Then use `requestWithStartup` for cwd capture:

```ts
    const capturePlan = createCwdCapturePlan(requestWithStartup, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
```

Keep the later `resolveExecutionCommand(capturePlan.command, ...)` flow unchanged.

- [ ] **Step 5: Add private adapter method**

In `NodeExecutionAdapter`, add:

```ts
  private applyBashStartupToExecutionRequest(
    request: ExecutionRequest,
    cwdDialect: ExecutionShellDialect,
  ): ExecutionRequest {
    if (
      request.command.mode !== "shell" ||
      request.command.shellProfile !== "posix-bash"
    ) {
      return request;
    }

    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const materialized = materializeBashStartupScript(request.bashStartup, {
      rootDir,
      sessionId,
      shellDialect: cwdDialect,
    });
    const command = applyBashStartupScriptSource(request.command.command, materialized);
    if (command === request.command.command) return request;

    return {
      ...request,
      command: {
        ...request.command,
        command,
      },
    };
  }
```

At this stage, leave `applyBashPreludeToExecutionRequest(...)` in the file. Task 5 will migrate embedded prelude content into the same materialization path.

- [ ] **Step 6: Run adapter startup tests**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/bash-startup-script.test.ts tests/exec.test.ts -t "startup"
```

Expected: startup-related tests pass.

---

### Task 5: Merge Embedded Prelude Content Into Startup Script Path

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`

**Interfaces:**
- Produces: `buildEmbeddedSearchPreludeContent(prelude, options): string | undefined`
- Preserves: `applyEmbeddedSearchPrelude(command, prelude, options): string`

- [ ] **Step 1: Add content builder test**

In `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`, add:

```ts
it("can build prelude content without appending the user command", () => {
  const content = buildEmbeddedSearchPreludeContent({
    kind: "embedded-search",
    backend: {
      kind: "internal-cli",
      command: "zcode",
      args: ["__internal-search"],
    },
  });

  expect(content).toContain("unalias find 2>/dev/null || true");
  expect(content).toContain('command zcode __internal-search find "$@"');
  expect(content).not.toContain("grep needle file.txt");
});
```

Update the import:

```ts
import {
  applyEmbeddedSearchPrelude,
  buildEmbeddedSearchPreludeContent,
} from "../src/exec/embedded-search-prelude.js";
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/embedded-search-prelude.test.ts -t "build prelude content"
```

Expected: fails because `buildEmbeddedSearchPreludeContent` does not exist.

- [ ] **Step 3: Refactor embedded prelude builder**

In `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`, add:

```ts
export function buildEmbeddedSearchPreludeContent(
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string | undefined {
  if (prelude?.kind !== "embedded-search") return undefined;
  if (!supportsPosixShellFunctionPrelude(options.shellDialect)) return undefined;

  const backend = normalizeBackendForShell(prelude.backend, options.shellDialect);
  return [
    "unalias find 2>/dev/null || true",
    "unalias grep 2>/dev/null || true",
    createFindFunction(backend),
    createGrepFunction(backend),
  ].join("\n");
}
```

Then rewrite `applyEmbeddedSearchPrelude()` as:

```ts
export function applyEmbeddedSearchPrelude(
  command: string,
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string {
  const content = buildEmbeddedSearchPreludeContent(prelude, options);
  return content ? [content, command].join("\n") : command;
}
```

- [ ] **Step 4: Combine startup and embedded prelude content in adapter**

In `apps/zcode-cli/packages/adapters/src/exec/index.ts`, import:

```ts
import { buildEmbeddedSearchPreludeContent } from "./embedded-search-prelude.js";
```

Then update `applyBashStartupToExecutionRequest()` to materialize combined content:

```ts
    const embeddedPreludeContent = buildEmbeddedSearchPreludeContent(request.bashPrelude, {
      shellDialect: cwdDialect,
    });
    const startup =
      request.bashStartup || embeddedPreludeContent
        ? {
            kind: "session-script" as const,
            id: request.bashStartup?.id ?? "embedded-search-startup",
            content: [request.bashStartup?.content, embeddedPreludeContent]
              .filter((part): part is string => Boolean(part && part.length > 0))
              .join("\n"),
          }
        : undefined;

    const materialized = materializeBashStartupScript(startup, {
      rootDir,
      sessionId,
      shellDialect: cwdDialect,
    });
```

After this is wired, remove the old `applyBashPreludeToExecutionRequest()` call from `spawnChild()` so there is only one Bash startup path.

- [ ] **Step 5: Preserve current disabled behavior**

Confirm core still does not send `bashPrelude` while the flag is disabled:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/core exec vitest run tests/embedded-search-shell.test.ts tests/bash-handler.test.ts
```

Expected: tests pass and Bash request has `bashStartup` but no `bashPrelude`.

- [ ] **Step 6: Run adapter prelude tests**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/embedded-search-prelude.test.ts tests/bash-startup-script.test.ts
```

Expected: all tests pass.

---

### Task 6: Document Runtime Contract

**Files:**
- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`
- Modify: `docs/superpowers/plans/2026-06-26-bash-session-startup-script-snapshot.md`

**Interfaces:**
- Produces: documented owner boundaries and acceptance criteria.

- [ ] **Step 1: Add `.sh` startup snapshot section**

In `docs/runtime-tools/bash-effective-shell-snapshot.md`, add a section after the existing session shell owner section:

```md
## Bash Startup `.sh` Snapshot

Bash tool execution may source a ZCode-generated session startup script before running the model command. This script is internal execution infrastructure; it is not provider-visible prompt content and does not change the tool schema.

- `core` produces an `ExecutionBashStartupScript` descriptor for Bash tool requests.
- `adapters` materializes the descriptor under ZCode-owned storage using a session/hash-scoped path.
- POSIX and Git Bash shells source the materialized `.sh` file before the user command.
- CMD and legacy shell fallback do not source `.sh` files.
- The startup script content must come only from ZCode internal builders.
- The first implementation keeps the script side-effect free; embedded search aliases remain disabled unless the dedicated runtime flag is changed.

This file path is not persisted as session state. Resume reconstructs the descriptor and lets the adapter materialize the script again.
```

- [ ] **Step 2: Add plan completion note**

At the bottom of this plan, update the execution status section after implementation:

```md
## Execution Notes

- Provider-visible main system prompt remained unchanged.
- Runtime find/grep alias injection remained disabled.
- Bash startup `.sh` file is sourced only for POSIX/Git Bash shell profiles.
```

- [ ] **Step 3: Run doc grep checks**

Run:

```bash
rg -n "Bash Startup `.sh` Snapshot|ExecutionBashStartupScript|embedded search aliases remain disabled" docs/runtime-tools/bash-effective-shell-snapshot.md docs/superpowers/plans/2026-06-26-bash-session-startup-script-snapshot.md
```

Expected: all three phrases are present in docs.

---

### Task 7: Final Verification

**Files:**
- No source edits unless verification exposes a concrete failure.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: review-ready working tree.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/contracts typecheck
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec vitest run tests/bash-startup-script.test.ts tests/embedded-search-prelude.test.ts tests/exec.test.ts
pnpm --dir apps/zcode-cli --filter @zcode/core exec vitest run tests/bash-handler.test.ts tests/embedded-search-shell.test.ts tests/context-builder.test.ts tests/main-tool-pool.test.ts tests/subagent-explore.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Run package typechecks**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/contracts typecheck
pnpm --dir apps/zcode-cli --filter @zcode/adapters typecheck
pnpm --dir apps/zcode-cli --filter @zcode/core typecheck
```

Expected: all commands exit 0.

- [ ] **Step 3: Run lint on touched source**

Run:

```bash
pnpm --dir apps/zcode-cli --filter @zcode/adapters exec oxlint src/exec/bash-startup-script.ts src/exec/embedded-search-prelude.ts src/exec/index.ts
pnpm --dir apps/zcode-cli --filter @zcode/core exec oxlint src/tool/handlers/bash-startup.ts src/tool/handlers/bash.ts src/embedded-search/shell.ts
```

Expected: both commands exit 0.

- [ ] **Step 4: Confirm provider-visible prompt did not change**

Run:

```bash
git diff -- apps/zcode-cli/packages/core/src/context apps/zcode-cli/packages/core/src/context/sections apps/zcode-cli/packages/core/tests/context-builder.test.ts
```

Expected: no diff caused by this plan. If there is a diff, it must be unrelated and already present before executing this plan.

- [ ] **Step 5: Confirm alias runtime remains disabled**

Run:

```bash
rg -n "const ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE = false|shouldInjectEmbeddedSearchBashPrelude" apps/zcode-cli/packages/core/src/embedded-search/shell.ts apps/zcode-cli/packages/core/tests/embedded-search-shell.test.ts
```

Expected:

- `ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE = false` is present.
- test still asserts `shouldInjectEmbeddedSearchBashPrelude()` returns `false`.

- [ ] **Step 6: Hygiene check**

Run:

```bash
git diff --check
git status --short
```

Expected:

- `git diff --check` exits 0.
- `git status --short` only shows intended files from this plan and any pre-existing user changes.

---

## Acceptance Criteria

- Bash tool requests include an internal `bashStartup` descriptor.
- Adapter materializes `bashStartup` to a `.sh` file under ZCode-owned storage.
- POSIX and Git Bash Bash-tool executions source the materialized script before the model command.
- CMD and legacy shell executions skip `.sh` startup sourcing.
- Git Bash receives a Git Bash-compatible source path.
- Existing embedded search prelude logic can produce script content, but runtime alias injection remains disabled by flag.
- Main agent provider-visible system prompt remains unchanged by this plan.
- `Glob/Grep` provider-visible tool exposure policy remains unchanged by this plan.
- No absolute startup script path is persisted to session store.
- Focused tests and typechecks pass.

## Self-Review Checklist

- [ ] No task changes provider-visible main system prompt.
- [ ] No task re-enables `find()` / `grep()` alias injection.
- [ ] `ExecutionBashStartupScript` is clearly internal-only.
- [ ] Adapter owns filesystem materialization and path conversion.
- [ ] Core does not import adapter prelude builders.
- [ ] `embedded-search-prelude.ts` remains backward compatible for existing tests.
- [ ] Startup script source happens before cwd capture wrapper so command execution observes startup definitions.
- [ ] CMD/legacy fallback behavior does not become a spawn error.
- [ ] Docs explain the difference between shell selection snapshot and `.sh` startup snapshot.

## Execution Notes

- Provider-visible main system prompt remained unchanged.
- Runtime find/grep alias injection remained disabled.
- Bash startup `.sh` file is sourced only for POSIX/Git Bash shell profiles.
