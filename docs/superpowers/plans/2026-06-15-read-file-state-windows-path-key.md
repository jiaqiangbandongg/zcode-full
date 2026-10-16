# Read File State Windows 路径 Key 修复实施计划

> **给执行该计划的 agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 修复 Windows 上同一个物理文件因为路径字符串不同（例如 `c:/repo/a.txt`、`C:\repo\a.txt`、相对路径 `a.txt`）导致 Read 后 Write/Edit 仍被误判为“没有先 Read”的问题。

**架构：** Read、Write、Edit 共享同一套归一化后的 read-state key，而不是各 handler 自己比较原始路径字符串。路径 canonicalization 只用于内部 read-before-write/edit 状态身份判断，不改变 provider-visible 的 `filePath`、权限路径、diff 路径或全局 path policy。

**技术栈：** TypeScript、Node path API、Vitest、现有 `@zcode/core` 文件工具 handler。

---

## 文件结构

- 新增：`apps/zcode-cli/packages/core/src/tool/read-file-state.ts`
  - 负责 read-state key 构造、Windows 路径身份归一化，以及 Read/Write/Edit 共享的 read-state 查找 helper。
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/read.ts`
  - 用共享 helper 替换本地 cache-key 构造。
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/write.ts`
  - 用共享 helper 替换 `entry.path !== filePath` 扫描逻辑和本地 full-read key 构造。
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`
  - 用共享 helper 替换 `entry.path !== filePath` 扫描逻辑和本地 full-read key 构造，同时保留现有 partial-read fallback 行为。
- 修改：`apps/zcode-cli/packages/core/tests/write-tool-contract.test.ts`
  - 增加 normalized read-state key 的 Write 回归测试，避免 mac runner 用当前平台 `node:path` 误测 Windows handler 行为。
- 修改：`apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts`
  - 增加 normalized read-state key 的 Edit 回归测试，避免 mac runner 用当前平台 `node:path` 误测 Windows handler 行为。
- 新增测试：`apps/zcode-cli/packages/core/tests/read-file-state.test.ts`
  - 单测平台相关的 key 归一化逻辑，不依赖真实 Windows runner。

---

### 任务 1：增加失败的 path-key 单测

**文件：**
- 新增：`apps/zcode-cli/packages/core/tests/read-file-state.test.ts`

- [ ] **步骤 1：为内部路径身份写失败单测**

创建 `apps/zcode-cli/packages/core/tests/read-file-state.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";

describe("read file state path keys", () => {
  it("treats equivalent Windows drive-letter paths as the same read-state file", () => {
    expect(createReadFileStatePathKey("c:/zcode-readwrite-repro/repro.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\zcode-readwrite-repro\\repro.txt", "win32"),
    );
  });

  it("normalizes Windows extended drive prefixes before comparing read-state files", () => {
    expect(createReadFileStatePathKey("\\\\?\\c:\\Repo\\File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("preserves non-drive Windows device namespace paths", () => {
    expect(createReadFileStatePathKey("\\\\?\\Volume{123}\\Repo\\File.txt", "win32")).toBe(
      "\\\\?\\Volume{123}\\Repo\\File.txt",
    );
    expect(
      createReadFileStatePathKey(
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt",
        "win32",
      ),
    ).toBe("\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt");
  });

  it("normalizes Windows POSIX drive aliases", () => {
    expect(createReadFileStatePathKey("/c/Repo/File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not normalize cygdrive aliases in the read-state path", () => {
    expect(createReadFileStatePathKey("/cygdrive/c/Repo/File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("keeps cygdrive alias casing strict", () => {
    expect(createReadFileStatePathKey("/Cygdrive/c/Repo/File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold Windows path segments without a canonical filesystem identity", () => {
    expect(createReadFileStatePathKey("C:\\Repo\\File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold non-Windows paths", () => {
    expect(createReadFileStatePathKey("/tmp/ZCode/File.txt", "linux")).not.toBe(
      createReadFileStatePathKey("/tmp/zcode/file.txt", "linux"),
    );
  });

  it("Unicode-normalizes paths on all platforms", () => {
    expect(createReadFileStatePathKey("/tmp/\u00e9.txt", "linux")).toBe(
      createReadFileStatePathKey("/tmp/e\u0301.txt", "linux"),
    );
  });
});
```

- [ ] **步骤 2：运行新单测，确认它先失败**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/read-file-state.test.ts
```

预期：失败，原因是 `../src/tool/read-file-state.js` 还不存在。

---

### 任务 2：实现共享 read-state key helper

**文件：**
- 新增：`apps/zcode-cli/packages/core/src/tool/read-file-state.ts`

- [ ] **步骤 1：新增共享 helper 模块**

创建 `apps/zcode-cli/packages/core/src/tool/read-file-state.ts`：

```ts
// ============================================================
// Read File State Helpers
// ============================================================

import { normalize, win32 } from "node:path";
import { platform as currentPlatform } from "node:process";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

export function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeReadStatePath(filePath, platform).normalize("NFC");
}

export function createReadFileStateKey(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return [
    createReadFileStatePathKey(filePath, platform),
    String(offset ?? 1),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

export function findStrictFullReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  const direct = readFileState.get(createReadFileStateKey(filePath, 1, undefined, platform));
  if (direct && isStrictFullReadState(direct)) return direct;

  return findReadFileStateByPath(readFileState, filePath, platform, (entry) =>
    isStrictFullReadState(entry),
  );
}

export function findEditableReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  const direct = readFileState.get(createReadFileStateKey(filePath, 1, undefined, platform));
  if (direct && !direct.isPartialView) return direct;

  let partialRead: ReadFileStateEntry | undefined;
  const pathKey = createReadFileStatePathKey(filePath, platform);
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (entry.isPartialView) {
      partialRead ??= entry;
      continue;
    }
    return entry;
  }
  // Bugfix：允许未变更文件的 partial Read 作为 Edit 的上下文依据；
  // 仍交给 stale guard 校验 revision/mtime，避免文件变化后绕过 read-before-edit 保护。
  return partialRead;
}

function findReadFileStateByPath(
  readFileState: ReadFileStateMap,
  filePath: string,
  platform: ReadFileStatePlatform,
  accepts: (entry: ReadFileStateEntry) => boolean,
): ReadFileStateEntry | undefined {
  const pathKey = createReadFileStatePathKey(filePath, platform);
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (!accepts(entry)) continue;
    return entry;
  }
  return undefined;
}

function isStrictFullReadState(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  if ((entry.offset ?? 1) > 1) return false;
  return entry.limit === undefined;
}

function normalizeReadStatePath(filePath: string, platform: ReadFileStatePlatform): string {
  if (platform !== "win32") return normalize(filePath);
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // read-state 路径入口只把 /c/... 这种 Git Bash 盘符别名交给转换器。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
```

- [ ] **步骤 2：运行 path-key 单测**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/read-file-state.test.ts
```

预期：通过。

---

### 任务 3：让 Read 使用共享 key

**文件：**
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/read.ts`

- [ ] **步骤 1：导入共享 key helper**

在本地 import 附近增加：

```ts
import { createReadFileStateKey } from "../read-file-state.js";
```

- [ ] **步骤 2：替换本地 cache-key 使用**

将：

```ts
const cacheKey = createReadCacheKey(filePath, cacheOffset, limit);
```

替换为：

```ts
const cacheKey = createReadFileStateKey(filePath, cacheOffset, limit);
```

- [ ] **步骤 3：删除本地 key 函数**

删除：

```ts
function createReadCacheKey(filePath: string, offset: number, limit: number | undefined): string {
  return [filePath, String(offset), limit === undefined ? "" : String(limit)].join("\0");
}
```

- [ ] **步骤 4：运行 Read 相邻测试**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/read-file-state.test.ts tests/file-tool-port.test.ts
```

预期：通过。

---

### 任务 4：增加 Write 回归覆盖

**文件：**
- 修改：`apps/zcode-cli/packages/core/tests/write-tool-contract.test.ts`

- [ ] **步骤 1：导入共享 key helper**

增加：

```ts
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
```

- [ ] **步骤 2：增加 normalized read-state key 回归测试**

在 `describe("Write model-result harness", () => { ... })` 内增加：

```ts
it("accepts a normalized read-state key when the stored display path differs", async () => {
  const file = join(tmpDir, "existing-normalized-key.txt");
  const fs = createMemoryFileSystem({
    [file]: "old line\n",
  });
  const revision = revisionFor(file, "old line\n");
  const readFileState: ReadFileStateMap = new Map([
    [
      createReadFileStateKey(file, 1, undefined),
      {
        path: `${tmpDir}/nested/../existing-normalized-key.txt`,
        content: "old line\n",
        offset: 1,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        revisionId: revision.id,
        mtimeMs: revision.mtimeMs,
        sizeBytes: revision.sizeBytes,
      },
    ],
  ]);
  const context = contextWith(fs, { readFileState });

  const result = await writeForModel(
    {
      file_path: file,
      content: "new line\n",
    },
    context,
  );

  expect(result.output).toMatchObject({
    type: "update",
    filePath: file,
    content: "new line\n",
  });
  expect(fs.files.get(file)).toBe("new line\n");
});
```

- [ ] **步骤 3：运行 Write 测试，确认实现前会失败**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/write-tool-contract.test.ts -t "normalized read-state key"
```

任务 5 实现前的预期：失败，错误为 `File has not been read yet. Read it first before writing to it.`

---

### 任务 5：让 Write 使用共享 lookup

**文件：**
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/write.ts`

- [ ] **步骤 1：导入共享 helper**

增加：

```ts
import {
  createReadFileStateKey,
  findStrictFullReadFileState,
} from "../read-file-state.js";
```

- [ ] **步骤 2：替换本地 lookup**

将：

```ts
const lastRead = findFullReadState(readFileState, filePath);
```

替换为：

```ts
const lastRead = findStrictFullReadFileState(readFileState, filePath);
```

- [ ] **步骤 3：删除本地扫描 helper**

删除整个本地 `findFullReadState(...)` 函数：

```ts
function findFullReadState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  for (const entry of readFileState.values()) {
    if (entry.path !== filePath) continue;
    if (entry.isPartialView) continue;
    if ((entry.offset ?? 1) > 1) continue;
    if (entry.limit !== undefined) continue;
    return entry;
  }
  return undefined;
}
```

- [ ] **步骤 4：替换写入后的 read-state key**

将：

```ts
readFileState.set(createFullReadCacheKey(filePath), {
```

替换为：

```ts
readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
```

- [ ] **步骤 5：删除本地 full-read key 函数**

删除：

```ts
function createFullReadCacheKey(filePath: string): string {
  return [filePath, "1", ""].join("\0");
}
```

- [ ] **步骤 6：按需删除未使用的类型 import**

如果 TypeScript 报 `ReadFileStateEntry` 未使用，将：

```ts
import type { ReadFileStateEntry, ReadFileStateMap, ToolExecutionContext } from "../types.js";
```

改为：

```ts
import type { ReadFileStateMap, ToolExecutionContext } from "../types.js";
```

- [ ] **步骤 7：运行 Write 验证**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/write-tool-contract.test.ts tests/read-file-state.test.ts
```

预期：通过。

---

### 任务 6：增加 Edit 回归覆盖

**文件：**
- 修改：`apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts`

- [ ] **步骤 1：导入共享 key helper**

增加：

```ts
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
```

- [ ] **步骤 2：增加 normalized read-state key 回归测试**

在 Edit 合同测试的 `describe` 块内增加：

```ts
it("accepts a normalized read-state key when the stored display path differs", async () => {
  const file = join(tmpDir, "existing-normalized-key.txt");
  const fs = createMemoryFileSystem({
    [file]: "original\n",
  });
  const revision = revisionFor(file, "original\n");
  const readFileState: ReadFileStateMap = new Map([
    [
      createReadFileStateKey(file, 1, undefined),
      {
        path: `${tmpDir}/nested/../existing-normalized-key.txt`,
        content: "original\n",
        offset: 1,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        revisionId: revision.id,
        mtimeMs: revision.mtimeMs,
        sizeBytes: revision.sizeBytes,
      },
    ],
  ]);
  const context = contextWith(fs, { readFileState });

  const output = await editHandler(
    {
      file_path: file,
      old_string: "original",
      new_string: "modified-by-edit",
    },
    context,
  );

  expect(output).toMatchObject({
    filePath: file,
    oldString: "original",
    newString: "modified-by-edit",
    originalFile: "original\n",
  });
  expect(fs.files.get(file)).toBe("modified-by-edit\n");
});
```

- [ ] **步骤 3：运行 Edit 测试，确认实现前会失败**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/edit-tool-contract.test.ts -t "normalized read-state key"
```

任务 7 实现前的预期：失败，错误为 `File has not been read yet. Read it first before writing to it.`

---

### 任务 7：让 Edit 使用共享 lookup

**文件：**
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`

- [ ] **步骤 1：导入共享 helper**

增加：

```ts
import {
  createReadFileStateKey,
  findEditableReadFileState,
} from "../read-file-state.js";
```

- [ ] **步骤 2：替换本地 lookup 调用**

将：

```ts
const lastRead = findEditableReadState(readFileState, filePath);
```

保留为同名调用，但来源改成共享模块。为了避免命名冲突，需要先按步骤 3 删除本地函数，再运行 TypeScript。

- [ ] **步骤 3：删除本地 lookup helper**

删除本地 `findEditableReadState(...)` 函数：

```ts
function findEditableReadState(
  readFileState: ReadFileStateMap,
  filePath: string,
): ReadFileStateEntry | undefined {
  let partialRead: ReadFileStateEntry | undefined;
  for (const entry of readFileState.values()) {
    if (entry.path !== filePath) continue;
    if (entry.isPartialView) {
      partialRead ??= entry;
      continue;
    }
    return entry;
  }
  // Bugfix：允许未变更文件的 partial Read 作为 Edit 的上下文依据；
  // 仍交给 stale guard 校验 revision/mtime，避免文件变化后绕过 read-before-edit 保护。
  return partialRead;
}
```

- [ ] **步骤 4：替换编辑写入后的 read-state key**

将：

```ts
readFileState.set(createFullReadCacheKey(filePath), {
```

替换为：

```ts
readFileState.set(createReadFileStateKey(filePath, 1, undefined), {
```

- [ ] **步骤 5：删除本地 full-read key 函数**

删除：

```ts
function createFullReadCacheKey(filePath: string): string {
  return [filePath, "1", ""].join("\0");
}
```

- [ ] **步骤 6：保留中文 bugfix 注释**

将现有 partial-read 依据注释移动到 `read-file-state.ts` 的 `findEditableReadFileState(...)` 中：

```ts
// Bugfix：允许未变更文件的 partial Read 作为 Edit 的上下文依据；
// 仍交给 stale guard 校验 revision/mtime，避免文件变化后绕过 read-before-edit 保护。
return partialRead;
```

- [ ] **步骤 7：按需删除未使用的类型 import**

如果 TypeScript 报 `ReadFileStateEntry` 未使用，从 Edit handler 的类型 import 中删除它。

- [ ] **步骤 8：运行 Edit 验证**

运行：

```bash
pnpm --filter @zcode/core exec vitest run tests/edit-tool-contract.test.ts tests/read-file-state.test.ts
```

预期：通过。

---

### 任务 8：校准 file-tool-port direct-handler 测试

**文件：**
- 修改：`apps/zcode-cli/packages/core/tests/file-tool-port.test.ts`

- [ ] **步骤 1：给 direct-handler Write existing-file 用例补显式 read-state**

在 `contextWith(...)` 的 options 里增加：

```ts
readFileState?: ReadFileStateMap;
```

- [ ] **步骤 2：增加 file-tool-port 本地 read-state helper**

在测试文件里增加：

```ts
function createReadFileState(filePath: string, content: string): ReadFileStateMap {
  const revision = revisionFor(filePath, content);
  return new Map([
    [
      createReadFileStateKey(filePath, 1, undefined),
      {
        path: filePath,
        content: normalizeTestLineEndings(content),
        offset: 1,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(),
        revisionId: revision.id,
        sizeBytes: revision.sizeBytes,
      },
    ],
  ]);
}
```

- [ ] **步骤 3：把 direct Write existing-file 用例改成显式提供 read-state**

现有 Write contract 要求 existing-file Write 前已有 Read state；这些 direct-handler 用例不应绕过 contract。

- [ ] **步骤 4：把 Write 相对路径输出期望改为原始 input path**

Write/Edit 的 provider-visible result 继续保留原始 tool input path；不要期待 resolved absolute path。

---

### 任务 9：最终验证

**文件：**
- 只验证被修改的 core package。

- [ ] **步骤 1：运行聚焦文件工具测试**

运行：

```bash
pnpm --filter @zcode/core exec vitest run \
  tests/read-file-state.test.ts \
  tests/write-tool-contract.test.ts \
  tests/edit-tool-contract.test.ts \
  tests/file-tool-port.test.ts
```

预期：通过。

- [ ] **步骤 2：运行 core typecheck**

运行：

```bash
pnpm --filter @zcode/core typecheck
```

预期：通过。

- [ ] **步骤 3：运行 core lint**

运行：

```bash
pnpm --filter @zcode/core lint
```

预期：通过。

- [ ] **步骤 4：检查 provider-visible 行为没有被改变**

运行：

```bash
git diff -- apps/zcode-cli/packages/core/src/tool/handlers/read.ts \
  apps/zcode-cli/packages/core/src/tool/handlers/write.ts \
  apps/zcode-cli/packages/core/src/tool/handlers/edit.ts \
  apps/zcode-cli/packages/core/src/tool/read-file-state.ts
```

确认：

- 成功/失败文案没有变化。
- Write/Edit 结果里的 `output.filePath` 仍使用原始 tool input path。
- 权限 metadata 和工具 description 没有变化。
- `resolveWorkspacePath(...)` 没有变化。
- Windows 只在内部 read-state key 中做分隔符、Git Bash `/c/...` POSIX drive alias、extended drive/UNC prefix 和 drive letter 归一化，不做整条路径大小写折叠，也不把 `/cygdrive/...` 或设备命名空间路径额外合并。

---

## 自检

- 覆盖范围：该计划修复已复现的 Windows `Read c:/...` 后 `Write repro.txt` 误报未 Read 问题，并同步覆盖 Edit，因为 Edit 使用同一类 read-before-write guard。
- 共享 key 结构：该计划让 Read/Write/Edit 共享归一化 key，read-state 入口只复用 Windows `/c/...` drive alias 归一化；`/cygdrive/...` 不在该入口额外合并。为避免误合并 case-sensitive Windows 目录中的不同文件，计划只 canonicalize drive letter，不对整条路径做 `toLowerCase()`。
- 风险边界：不改变 provider-visible 输出结构、不改变权限行为、不改变全局路径解析、不改变文件系统 adapter 语义、不改变工具 description。
- 测试覆盖：单测覆盖平台相关 key 行为；contract 测试覆盖 Write/Edit 回归；集成形态测试覆盖实际 absolute-to-relative 复现路径。

计划已保存到 `docs/superpowers/plans/2026-06-15-read-file-state-windows-path-key.md`。

执行选项：

1. **Subagent-Driven（推荐）**：每个任务派发一个 fresh subagent，任务之间 review，迭代更快。
2. **Inline Execution**：在当前 session 里使用 `executing-plans` 按批次执行，并在关键点停下 review。
