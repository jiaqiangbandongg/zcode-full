# Bundled bfs/ugrep Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZCode 在所有支持平台上都能消费包内 `rg` / `bfs` / `ugrep` 二进制，并让 Bash `find` / `grep` 执行层在 embedded-search 分支下真正使用内置 `bfs` / `ugrep`。

**Architecture:** provider-visible embedded-search policy 保持现状；执行层在有可用内置二进制时从当前 `internal-cli` passthrough 切到 `argv0-dispatch`。ZCode 不做 Bun native multicall ELF，第一版用 CLI multicall shim 读取 `ARGV0` / `process.argv0` 后转发到包内 `rg` / `bfs` / `ugrep`，后续如果有真正 native multicall binary，可以只替换 backend resolver。

**Tech Stack:** TypeScript, Node.js CLI, Electron runtime resources, SEA assets, shell snapshot startup scripts, `@zcode/contracts`, `@zcode/shared`, `@zcode/adapters`, Vitest.

## Global Constraints

- 目标版本：`rg 14.1.1`, `bfs 4.1.1`, `ugrep 7.5.0`。
- shell function 语义：zsh / msys / cygwin / win32 使用 `ARGV0=<tool> "$_bin"`；bash 使用 `exec -a <tool> "$_bin"`。
- `find` 默认参数：`-S dfs -regextype findutils-default`。
- `grep` 默认参数：`-G --ignore-files --hidden -I --exclude-dir=.git/.svn/.hg/.bzr/.jj/.sl`。
- `grep` bypass patterns：`-*-filter*`, `-*-pager*`, `-*-view*`, `-*-format-open*`, `-*-config*`, `---*`, `-@*`, `-*-save-config*`。
- 支持平台矩阵必须显式覆盖：`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`。
- 每个支持平台都必须提供并验证 `rg` / `bfs` / `ugrep` 三个包内二进制；release、desktop packaging、remote resource、SEA smoke 缺任一二进制都必须失败，不允许产出“支持平台但只 fallback 系统命令”的正式包。
- 上游现实：`bfs` release 只有源码包；`ugrep` release 只有 Windows x64 预编译包；npm 无可用 `ugrep` / 真 `bfs` binary 包。因此全平台内置能力必须依赖 ZCode 自建或内网托管的预编译产物。
- 运行时缺少内置二进制时仍必须优雅降级，不得让 Bash tool call 无输出或卡死；但该 fallback 只用于 dev/manual/异常损坏环境，不是支持平台 release 产物的可接受状态。
- 不改变 provider-visible prompt/tool surface，除非后续另开 prompt 调整任务。
- 不提交大二进制 blob 到 git；通过下载脚本、desktop bundled-tools、remote resource package、SEA asset 机制携带。
- 任何 Windows Git Bash 支持都必须使用现有 `windowsPathToGitBashPath` 路径转换。

---

## Research Summary

- argv0-dispatch 的目标形态是单 multicall binary：`ARGV0=rg` 执行 `ripgrep 14.1.1`；`ARGV0=bfs` 执行 `bfs 4.1.1`；`ARGV0=ugrep` 执行 `ugrep 7.5.0`。
- prelude 中的 `find` / `grep` function 先检查 multicall binary 是否可执行，不可执行时 fallback `command find "$@"` / `command grep "$@"`。
- `origin/xiaodexiong` 的可复用部分是 runtime tool distribution / resolver 范式；它并没有完整捆绑 `bfs`。其 ADR-0007 明确写了 `bfs` 永不捆绑、`ugrep` 只 Windows x64 下载、`rg` 走 `@vscode/ripgrep`。
- 当前主线已有 `packages/shared/src/runtime-tool-runtime.ts`、`packages/services/src/runtime-tools/runtimeToolResolver.ts`、`scripts/download-ripgrep.mjs`、`scripts/prepare-prebuilds.mjs`、desktop bundled-tools 与 remote resource package 机制；这些是新增 `bfs` / `ugrep` 资源的正确接缝。
- 当前 remote prebuild 只发布 `linux-arm64`, `linux-x64`, `darwin-arm64`, `darwin-x64`；desktop packaging 通过 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH` 支持 macOS、Linux、Windows 的 x64/arm64。搜索工具计划必须按完整六平台矩阵准备资产，并让 remote 只消费其中 macOS/Linux 四个平台。

## File Structure

- Modify `packages/shared/src/runtime-tool-runtime.ts`
  - 增加 `RuntimeToolId = "ripgrep" | "bfs" | "ugrep"`。
  - 增加 `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` descriptor。

- Modify `packages/services/src/runtime-tools/runtimeToolResolver.ts`
  - 保持 resolver 泛型能力；补测试覆盖多工具。

- Modify `packages/services/src/runtime-tools/runtimeCommandEnv.ts`
  - `buildRuntimeProcessEnvPatch()` 从 `["ripgrep"]` 扩到 `["ripgrep", "bfs", "ugrep"]`。

- Create `scripts/search-runtime-tools.mjs`
  - 集中定义 `rg/bfs/ugrep` 版本、支持平台矩阵、内部下载命名、sha256 manifest。

- Modify `scripts/download-ripgrep.mjs`
  - 保留现有 CLI 参数兼容性，只把默认 ripgrep 版本从 `v13.0.0-10` 更新到目标版本 `14.1.1`。

- Create `scripts/download-search-runtime-tool.mjs`
  - 只负责新增 `bfs` / `ugrep` 下载，不接管 `ripgrep` 的既有入口。

- Modify `scripts/prepare-prebuilds.mjs`
  - remote assets 增加 `bfs` / `ugrep` resource component。

- Modify `packages/desktop/scripts/prepare-runtime-assets.mjs`
  - local desktop runtime assets 增加 `prepare:bfs` / `prepare:ugrep`。

- Modify `packages/desktop/scripts/ensure-local-runtime-assets.mjs`
  - dev startup 自检增加 `bfs` / `ugrep`。

- Modify desktop packaging config source
  - 当前测试断言在 `packages/desktop/test/runtime-asset-scripts.test.ts`，实际 extraResources 配置应同步增加 `tools/bfs` / `tools/ugrep`。

- Create `apps/zcode-cli/packages/cli/src/bundled-search/multicall.ts`
  - 读取 `process.env.ARGV0 || process.argv0`，当值为 `rg` / `bfs` / `ugrep` 时转发到对应 runtime binary。

- Modify `apps/zcode-cli/packages/cli/src/run.ts`
  - 在 `__internal-search` 之前增加 multicall dispatch。

- Modify `apps/zcode-cli/packages/bootstrap/src/app/embedded-search-backend.ts`
  - 当 `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` 可执行时返回 `kind: "argv0-dispatch"`；否则保留当前 `internal-cli`。

- Modify `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
  - `argv0-dispatch` 分支改成 argv0 shell function：zsh / Windows 用 `ARGV0=...`，bash 用 `exec -a ...`。

- Tests
  - `packages/shared/test/runtimeToolRuntime.test.ts`
  - `packages/services/test/runtimeToolResolver.test.ts`
  - `packages/desktop/test/download-search-runtime-tool.test.ts`
  - `packages/desktop/test/runtime-asset-scripts.test.ts`
  - `apps/zcode-cli/packages/bootstrap/tests/embedded-search-backend.test.ts`
  - `apps/zcode-cli/packages/cli/tests/bundled-search-multicall.test.ts`
  - `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`
  - `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`
  - `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

---

### Task 1: Lock Runtime Tool Descriptors

**Files:**
- Modify: `packages/shared/src/runtime-tool-runtime.ts`
- Create: `packages/shared/test/runtimeToolRuntime.test.ts`

**Interfaces:**
- Produces: `RuntimeToolId = "ripgrep" | "bfs" | "ugrep"`
- Produces: `getRuntimeToolRuntime(toolId: RuntimeToolId): RuntimeToolRuntimeDescriptor`

- [ ] **Step 1: Write failing descriptor tests**

Create `packages/shared/test/runtimeToolRuntime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getRuntimeToolRuntime } from "../src/runtime-tool-runtime.js";

describe("runtime tool descriptors", () => {
  it("defines bundled search runtime tools", () => {
    expect(getRuntimeToolRuntime("ripgrep")).toMatchObject({
      binaryEnvVar: "ZCODE_RG_BINARY",
      bundledResourceDir: "ripgrep",
      version: "14.1.1",
    });
    expect(getRuntimeToolRuntime("bfs")).toMatchObject({
      binaryEnvVar: "ZCODE_BFS_BINARY",
      bundledResourceDir: "bfs",
      version: "4.1.1",
    });
    expect(getRuntimeToolRuntime("ugrep")).toMatchObject({
      binaryEnvVar: "ZCODE_UGREP_BINARY",
      bundledResourceDir: "ugrep",
      version: "7.5.0",
    });
  });

  it("uses platform executable names", () => {
    expect(getRuntimeToolRuntime("bfs").resolveEntrySegments("darwin")).toEqual(["bfs"]);
    expect(getRuntimeToolRuntime("bfs").resolveEntrySegments("win32")).toEqual(["bfs.exe"]);
    expect(getRuntimeToolRuntime("ugrep").resolveEntrySegments("win32")).toEqual(["ugrep.exe"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zcode/shared test -- runtimeToolRuntime.test.ts
```

Expected: FAIL because `bfs` / `ugrep` are not part of `RuntimeToolId`.

- [ ] **Step 3: Implement descriptors**

Update `packages/shared/src/runtime-tool-runtime.ts`:

```ts
export type RuntimeToolId = "ripgrep" | "bfs" | "ugrep";
```

Add entries:

```ts
bfs: {
  binaryEnvVar: "ZCODE_BFS_BINARY",
  bundledResourceDir: "bfs",
  version: "4.1.1",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("bfs", platform)],
},
ugrep: {
  binaryEnvVar: "ZCODE_UGREP_BINARY",
  bundledResourceDir: "ugrep",
  version: "7.5.0",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("ugrep", platform)],
},
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @zcode/shared test -- runtimeToolRuntime.test.ts
```

Expected: PASS.

---

### Task 2: Extend Runtime Env Resolver

**Files:**
- Modify: `packages/services/src/runtime-tools/runtimeCommandEnv.ts`
- Modify: `packages/services/test/runtimeToolResolver.test.ts`

**Interfaces:**
- Consumes: `RuntimeToolId` from Task 1
- Produces: `buildRuntimeProcessEnvPatch()` includes `ZCODE_BFS_BINARY`, `ZCODE_UGREP_BINARY`, and prepends their directories to `PATH`

- [ ] **Step 1: Add resolver tests for bfs and ugrep**

Extend `packages/services/test/runtimeToolResolver.test.ts` with:

```ts
it("会从 bundled-tools 平台目录发现 bfs 和 ugrep binary 并注入 PATH", () => {
  delete process.env.ZCODE_BFS_BINARY;
  delete process.env.ZCODE_UGREP_BINARY;

  const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-search-tool-"));
  createdDirs.push(sandboxRoot);

  const appRepoDir = join(sandboxRoot, "z-code-2");
  const platformKey = `${process.platform}-${process.arch}`;
  const bfsName = process.platform === "win32" ? "bfs.exe" : "bfs";
  const ugrepName = process.platform === "win32" ? "ugrep.exe" : "ugrep";
  const bfsPath = join(appRepoDir, "packages", "desktop", "bundled-tools", platformKey, "bfs", bfsName);
  const ugrepPath = join(appRepoDir, "packages", "desktop", "bundled-tools", platformKey, "ugrep", ugrepName);

  mkdirSync(dirname(bfsPath), { recursive: true });
  mkdirSync(dirname(ugrepPath), { recursive: true });
  writeFileSync(bfsPath, "bfs\n");
  writeFileSync(ugrepPath, "ugrep\n");
  if (process.platform !== "win32") {
    chmodSync(bfsPath, 0o755);
    chmodSync(ugrepPath, 0o755);
  }

  process.chdir(appRepoDir);

  expect(realpathSync(findRuntimeToolBinary("bfs")!)).toBe(realpathSync(bfsPath));
  expect(realpathSync(findRuntimeToolBinary("ugrep")!)).toBe(realpathSync(ugrepPath));

  const envPatch = buildRuntimeToolEnvPatch(["bfs", "ugrep"], { PATH: "/usr/bin:/bin" });
  expect(realpathSync(envPatch.ZCODE_BFS_BINARY!)).toBe(realpathSync(bfsPath));
  expect(realpathSync(envPatch.ZCODE_UGREP_BINARY!)).toBe(realpathSync(ugrepPath));
});
```

- [ ] **Step 2: Update runtime process env patch**

Change `packages/services/src/runtime-tools/runtimeCommandEnv.ts`:

```ts
const runtimeToolEnvPatch = buildRuntimeToolEnvPatch(["ripgrep", "bfs", "ugrep"], {
  ...baseEnv,
  ...(loginShellPath ? { PATH: loginShellPath } : {}),
});
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @zcode/services test -- runtimeToolResolver.test.ts
```

Expected: PASS.

---

### Task 3: Add Search Runtime Tool Download Manifest

**Files:**
- Create: `scripts/search-runtime-tools.mjs`
- Create: `packages/desktop/test/searchRuntimeToolsManifest.test.ts`

**Interfaces:**
- Produces: `SEARCH_RUNTIME_TOOLS`
- Produces: `SUPPORTED_SEARCH_RUNTIME_PLATFORM_KEYS`
- Produces: `REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS`
- Produces: `resolveSearchRuntimeToolPlan({ toolId, targetPlatform, targetArch, env })`

- [ ] **Step 1: Add manifest tests**

Create `packages/desktop/test/searchRuntimeToolsManifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS,
  SEARCH_RUNTIME_TOOLS,
  SUPPORTED_SEARCH_RUNTIME_PLATFORM_KEYS,
  resolveSearchRuntimeToolPlan,
} from "../../../scripts/search-runtime-tools.mjs";

describe("search runtime tool manifest", () => {
  const supportedPlatformKeys = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ];

  it("pins search runtime tool versions", () => {
    expect(SEARCH_RUNTIME_TOOLS.ripgrep.version).toBe("14.1.1");
    expect(SEARCH_RUNTIME_TOOLS.bfs.version).toBe("4.1.1");
    expect(SEARCH_RUNTIME_TOOLS.ugrep.version).toBe("7.5.0");
  });

  it("locks the full supported search runtime platform matrix", () => {
    expect(SUPPORTED_SEARCH_RUNTIME_PLATFORM_KEYS).toEqual(supportedPlatformKeys);
    expect(REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
  });

  it("builds platform-scoped output paths", () => {
    const plan = resolveSearchRuntimeToolPlan({
      toolId: "bfs",
      targetPlatform: "darwin",
      targetArch: "arm64",
      env: { ZCODE_SEARCH_TOOLS_BASE_URL: "https://deps.example.test/search-tools" },
    });
    expect(plan.platformKey).toBe("darwin-arm64");
    expect(plan.binaryName).toBe("bfs");
    expect(plan.releaseFileName).toBe("bfs-4.1.1-darwin-arm64.tar.gz");
    expect(plan.downloadUrl).toBe("https://deps.example.test/search-tools/bfs-4.1.1/bfs-4.1.1-darwin-arm64.tar.gz");
  });

  it("has an asset plan for every bundled search tool on every supported platform", () => {
    for (const platformKey of supportedPlatformKeys) {
      const [targetPlatform, targetArch] = platformKey.split("-");
      if (!targetPlatform || !targetArch) throw new Error(`Invalid test platform key: ${platformKey}`);

      for (const [toolId, tool] of Object.entries(SEARCH_RUNTIME_TOOLS)) {
        const plan = resolveSearchRuntimeToolPlan({
          toolId,
          targetPlatform,
          targetArch,
          env: { ZCODE_SEARCH_TOOLS_BASE_URL: "https://deps.example.test/search-tools" },
        });
        const archiveExt = targetPlatform === "win32" ? "zip" : "tar.gz";
        const binaryName = targetPlatform === "win32" ? `${tool.binary}.exe` : tool.binary;
        expect(plan.platformKey).toBe(platformKey);
        expect(plan.binaryName).toBe(binaryName);
        expect(plan.releaseFileName).toBe(`${tool.binary}-${tool.version}-${platformKey}.${archiveExt}`);
      }
    }
  });
});
```

- [ ] **Step 2: Implement manifest**

Create `scripts/search-runtime-tools.mjs` with:

```js
import { join, resolve } from "node:path";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

export const SEARCH_RUNTIME_TOOLS = {
  ripgrep: { version: "14.1.1", binary: "rg" },
  bfs: { version: "4.1.1", binary: "bfs" },
  ugrep: { version: "7.5.0", binary: "ugrep" },
};

export const SUPPORTED_SEARCH_RUNTIME_PLATFORM_KEYS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

export const REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

export function normalizePlatform(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

export function normalizeArch(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

export function resolveSearchRuntimeDownloadBaseUrl(env = process.env) {
  return (
    env.ZCODE_SEARCH_TOOLS_BASE_URL?.trim().replace(/\/+$/, "") ||
    `${resolveIntranetDepsBaseUrl(env)}/search-tools`
  );
}

export function resolveSearchRuntimeToolPlan({
  toolId,
  targetPlatform,
  targetArch,
  forceRemoteOutput = false,
  env = process.env,
}) {
  const tool = SEARCH_RUNTIME_TOOLS[toolId];
  if (!tool) throw new Error(`Unsupported search runtime tool: ${toolId}`);

  const platform = normalizePlatform(targetPlatform);
  const arch = normalizeArch(targetArch);
  const platformKey = `${platform}-${arch}`;
  if (!SUPPORTED_SEARCH_RUNTIME_PLATFORM_KEYS.includes(platformKey)) {
    throw new Error(`Unsupported search runtime platform: ${platformKey}`);
  }
  const archiveExt = platform === "win32" ? "zip" : "tar.gz";
  const binaryName = platform === "win32" ? `${tool.binary}.exe` : tool.binary;
  const releaseFileName = `${tool.binary}-${tool.version}-${platformKey}.${archiveExt}`;
  const localOutputDir = join(repoRoot, "packages/desktop/bundled-tools", platformKey, toolId);
  const remoteOutputDir = join(repoRoot, "packages/desktop/mock-cdn/releases", "local", "tools", platformKey, toolId);
  const outputDir = forceRemoteOutput ? remoteOutputDir : localOutputDir;

  return {
    toolId,
    version: tool.version,
    platformKey,
    binaryName,
    releaseFileName,
    archiveExt,
    outputDir,
    downloadUrl: `${resolveSearchRuntimeDownloadBaseUrl(env)}/${tool.binary}-${tool.version}/${releaseFileName}`,
  };
}
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @zcode/desktop test -- searchRuntimeToolsManifest.test.ts
```

Expected: PASS.

---

### Task 4: Download and Stage Runtime Tool Assets

**Files:**
- Create: `scripts/download-search-runtime-tool.mjs`
- Modify: `scripts/download-ripgrep.mjs`
- Modify: `packages/desktop/package.json`
- Create: `packages/desktop/test/download-search-runtime-tool.test.ts`

**Interfaces:**
- Consumes: `resolveSearchRuntimeToolPlan()` from Task 3
- Produces: `pnpm --filter @zcode/desktop prepare:bfs`
- Produces: `pnpm --filter @zcode/desktop prepare:ugrep`
- Preserves: `pnpm --filter @zcode/desktop prepare:rg`

- [ ] **Step 1: Add tests for tool download planning**

Create `packages/desktop/test/download-search-runtime-tool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveSearchRuntimeToolPlan } from "../../../scripts/search-runtime-tools.mjs";

describe("download search runtime tool plan", () => {
  it("uses pinned bfs asset names", () => {
    const plan = resolveSearchRuntimeToolPlan({
      toolId: "bfs",
      targetPlatform: "linux",
      targetArch: "x64",
      env: { ZCODE_SEARCH_TOOLS_BASE_URL: "https://deps.example.test/search-tools" },
    });
    expect(plan.releaseFileName).toBe("bfs-4.1.1-linux-x64.tar.gz");
    expect(plan.binaryName).toBe("bfs");
  });

  it("uses Windows executable suffix for ugrep", () => {
    const plan = resolveSearchRuntimeToolPlan({
      toolId: "ugrep",
      targetPlatform: "win32",
      targetArch: "x64",
      env: { ZCODE_SEARCH_TOOLS_BASE_URL: "https://deps.example.test/search-tools" },
    });
    expect(plan.releaseFileName).toBe("ugrep-7.5.0-win32-x64.zip");
    expect(plan.binaryName).toBe("ugrep.exe");
  });
});
```

- [ ] **Step 2: Implement generic downloader**

Implement `scripts/download-search-runtime-tool.mjs` for `bfs` / `ugrep` only. Do not route `ripgrep` through this script in v1; the existing `download-ripgrep.mjs` already has production callers and should only get the version bump in Step 3.

```js
#!/usr/bin/env node

import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { resolveSearchRuntimeToolPlan } from "./search-runtime-tools.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function download(url, destinationPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = url.startsWith("https:") ? https : http;
    const file = createWriteStream(destinationPath);
    const cleanupAndReject = (error) => {
      file.close(() => {
        rmSync(destinationPath, { force: true });
        rejectPromise(error);
      });
    };
    client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => {
          rmSync(destinationPath, { force: true });
          download(response.headers.location, destinationPath).then(resolvePromise, rejectPromise);
        });
        return;
      }
      if (response.statusCode !== 200) {
        cleanupAndReject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close((error) => (error ? rejectPromise(error) : resolvePromise())));
    }).on("error", cleanupAndReject);
    file.on("error", cleanupAndReject);
  });
}

function findBinaryRecursively(rootDir, binaryName) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinaryRecursively(fullPath, binaryName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === binaryName) {
      return fullPath;
    }
  }
  return null;
}

export async function downloadSearchRuntimeTool(argv = process.argv.slice(2), env = process.env) {
  const toolId = argv[0];
  if (toolId !== "bfs" && toolId !== "ugrep") {
    throw new Error("Usage: node scripts/download-search-runtime-tool.mjs <bfs|ugrep> [platform] [arch]");
  }
  const targetPlatform = argv[1] || env.ZCODE_TARGET_OS || process.platform;
  const targetArch = argv[2] || env.ZCODE_TARGET_ARCH || process.arch;
  const plan = resolveSearchRuntimeToolPlan({
    toolId,
    targetPlatform,
    targetArch,
    forceRemoteOutput: env.ZCODE_FORCE_REMOTE_MOCK_CDN === "1",
    env,
  });
  const binaryPath = join(plan.outputDir, plan.binaryName);
  if (existsSync(binaryPath)) return;

  mkdirSync(plan.outputDir, { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), `zcode-${toolId}-`));
  const archivePath = join(tempDir, `${toolId}.${plan.archiveExt}`);
  const extractDir = join(tempDir, "extract");
  try {
    await download(plan.downloadUrl, archivePath);
    mkdirSync(extractDir, { recursive: true });
    if (plan.archiveExt === "zip") {
      if (process.platform === "win32") {
        run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`]);
      } else {
        run("unzip", ["-q", archivePath, "-d", extractDir]);
      }
    } else {
      run("tar", ["-xzf", archivePath, "-C", extractDir]);
    }
    const extractedBinaryPath = findBinaryRecursively(extractDir, plan.binaryName);
    if (!extractedBinaryPath) throw new Error(`Failed to locate ${plan.binaryName}`);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (!plan.binaryName.endsWith(".exe")) chmodSync(binaryPath, 0o755);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await downloadSearchRuntimeTool();
}
```

- [ ] **Step 3: Keep `download-ripgrep.mjs` CLI shape and bump default version**

In `scripts/download-ripgrep.mjs`, keep the existing argument contract:

```text
node scripts/download-ripgrep.mjs [version] [platform] [arch]
```

Only change the default:

```js
const RIPGREP_VERSION = process.argv[2] || "14.1.1";
```

Then update tests or snapshots that assert the default ripgrep download URL from `ripgrep-v13.0.0-10` to `ripgrep-14.1.1`. This keeps existing `prepare:rg`, `prepare-prebuilds`, and manual version override behavior intact while moving the bundled default to the pinned version.

- [ ] **Step 4: Add desktop scripts**

Update `packages/desktop/package.json`:

```json
"prepare:bfs": "node ../../scripts/download-search-runtime-tool.mjs bfs",
"prepare:ugrep": "node ../../scripts/download-search-runtime-tool.mjs ugrep"
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @zcode/desktop test -- download-search-runtime-tool.test.ts searchRuntimeToolsManifest.test.ts
```

Expected: PASS.

---

### Task 5: Wire Desktop and Remote Runtime Assets

**Files:**
- Modify: `packages/desktop/scripts/prepare-runtime-assets.mjs`
- Modify: `packages/desktop/scripts/ensure-local-runtime-assets.mjs`
- Modify: `scripts/prepare-prebuilds.mjs`
- Modify: desktop builder extraResources source
- Modify: `packages/desktop/test/runtime-asset-scripts.test.ts`
- Modify: `packages/desktop/test/preparePrebuildsReleaseReuse.test.ts`

**Interfaces:**
- Consumes: Task 4 scripts
- Produces: local packaged app resources `tools/bfs/<binary>` and `tools/ugrep/<binary>`
- Produces: local packaged app resources `tools/ripgrep/<binary>`
- Produces: remote release components `tools/<platform>/ripgrep`, `tools/<platform>/bfs`, and `tools/<platform>/ugrep`

- [ ] **Step 1: Add script tests**

Extend `packages/desktop/test/runtime-asset-scripts.test.ts`:

```ts
it("desktop 安装包应显式携带内置 bfs 和 ugrep runtime", () => {
  expect(electronBuilderConfigSource).toContain("from: `bundled-tools/${targetPlatform.key}/bfs`");
  expect(electronBuilderConfigSource).toContain('to: "tools/bfs"');
  expect(electronBuilderConfigSource).toContain("from: `bundled-tools/${targetPlatform.key}/ugrep`");
  expect(electronBuilderConfigSource).toContain('to: "tools/ugrep"');
});

it("runtime asset preparation should cover all bundled search tools", () => {
  expect(prepareRuntimeAssetsScriptSource).toContain('"prepare:rg"');
  expect(prepareRuntimeAssetsScriptSource).toContain('"prepare:bfs"');
  expect(prepareRuntimeAssetsScriptSource).toContain('"prepare:ugrep"');
  expect(ensureLocalRuntimeAssetsScriptSource).toContain('label: "ripgrep"');
  expect(ensureLocalRuntimeAssetsScriptSource).toContain('label: "bfs"');
  expect(ensureLocalRuntimeAssetsScriptSource).toContain('label: "ugrep"');
});

it("remote prebuilds should use the shared search runtime platform matrix", () => {
  expect(preparePrebuildsScriptSource).toContain("REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS");
  expect(preparePrebuildsScriptSource).toContain("SEARCH_RUNTIME_TOOLS");
  expect(preparePrebuildsScriptSource).toContain('id: "bfs"');
  expect(preparePrebuildsScriptSource).toContain('id: "ugrep"');
});
```

- [ ] **Step 2: Update local runtime preparation**

In `packages/desktop/scripts/prepare-runtime-assets.mjs`:

```js
const localRuntimeScripts = [
  "prepare:agent-bundle",
  "prepare:rg",
  "prepare:bfs",
  "prepare:ugrep",
];
```

In `packages/desktop/scripts/ensure-local-runtime-assets.mjs`, add entries for `bfs` / `ugrep` under `REQUIRED_LOCAL_RUNTIME_ASSETS` next to the existing `ripgrep` entry:

```js
{
  label: "bfs",
  script: "prepare:bfs",
  isReady: () => existsSync(join(bundledToolsRoot, "bfs", resolvePlatformBinaryName("bfs"))),
},
{
  label: "ugrep",
  script: "prepare:ugrep",
  isReady: () => existsSync(join(bundledToolsRoot, "ugrep", resolvePlatformBinaryName("ugrep"))),
},
```

- [ ] **Step 3: Update remote prebuilds**

In `scripts/prepare-prebuilds.mjs`:

- Import `REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS` and `SEARCH_RUNTIME_TOOLS` from `./search-runtime-tools.mjs`.
- Replace the local remote search platform source with `const remotePlatforms = [...REMOTE_SEARCH_RUNTIME_PLATFORM_KEYS];` so remote platform coverage cannot drift from the search runtime manifest.
- In `runRemoteBinaryDownloads()`, for every `platformKey` in `remotePlatforms`, run downloads for all three search tools:

```js
for (const platformKey of remotePlatforms) {
  const [targetOs, targetArch] = platformKey.split("-");
  if (!targetOs || !targetArch) throw new Error(`Invalid remote platform key: ${platformKey}`);

  for (const toolId of Object.keys(SEARCH_RUNTIME_TOOLS)) {
    const scriptName = toolId === "ripgrep" ? "download-ripgrep.mjs" : "download-search-runtime-tool.mjs";
    const args =
      toolId === "ripgrep"
        ? [join(rootDir, "scripts", scriptName), SEARCH_RUNTIME_TOOLS.ripgrep.version, targetOs, targetArch]
        : [join(rootDir, "scripts", scriptName), toolId, targetOs, targetArch];
    runCommand(process.execPath, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        ZCODE_FORCE_REMOTE_MOCK_CDN: "1",
      },
    });
  }
}
```

- In `buildReusableComponentRequiredPaths()`, return exact binary names for all search tool components:

```js
case "ripgrep":
  return [platformKey.startsWith("win32-") ? "rg.exe" : "rg"];
case "bfs":
  return [platformKey.startsWith("win32-") ? "bfs.exe" : "bfs"];
case "ugrep":
  return [platformKey.startsWith("win32-") ? "ugrep.exe" : "ugrep"];
```

- In `buildRemoteComponentDefinitions()`, add component ids `bfs` and `ugrep` mounted at `tools/<platformKey>/bfs` and `tools/<platformKey>/ugrep`; keep `ripgrep` mounted at `tools/<platformKey>/ripgrep`.

- [ ] **Step 4: Run script tests**

Run:

```bash
pnpm --filter @zcode/desktop test -- runtime-asset-scripts.test.ts preparePrebuildsReleaseReuse.test.ts
```

Expected: PASS.

---

### Task 6: Implement CLI Multicall Dispatch

**Files:**
- Create: `apps/zcode-cli/packages/cli/src/bundled-search/multicall.ts`
- Modify: `apps/zcode-cli/packages/cli/src/run.ts`
- Create: `apps/zcode-cli/packages/cli/tests/bundled-search-multicall.test.ts`

**Interfaces:**
- Produces: `resolveEffectiveMulticallName(env, argv0): "rg" | "bfs" | "ugrep" | undefined`
- Produces: `runBundledSearchMulticall(name, argv, io): Promise<number>`

- [ ] **Step 1: Write tests**

Create `apps/zcode-cli/packages/cli/tests/bundled-search-multicall.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEffectiveMulticallName } from "../src/bundled-search/multicall.js";

describe("bundled search multicall", () => {
  it("prefers ARGV0 for zsh/Git Bash invocation", () => {
    expect(resolveEffectiveMulticallName({ ARGV0: "bfs" }, "zcode")).toBe("bfs");
    expect(resolveEffectiveMulticallName({ ARGV0: "ugrep" }, "zcode")).toBe("ugrep");
  });

  it("falls back to process.argv0 for bash exec -a invocation", () => {
    expect(resolveEffectiveMulticallName({}, "bfs")).toBe("bfs");
    expect(resolveEffectiveMulticallName({}, "/usr/local/bin/ugrep")).toBe("ugrep");
  });

  it("ignores normal zcode invocation", () => {
    expect(resolveEffectiveMulticallName({}, "zcode")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement multicall resolver**

Create `apps/zcode-cli/packages/cli/src/bundled-search/multicall.ts`:

```ts
import { spawn } from "node:child_process";
import { basename } from "node:path";

export type SearchMulticallName = "rg" | "bfs" | "ugrep";

const MULTICALL_NAMES = new Set<SearchMulticallName>(["rg", "bfs", "ugrep"]);
const ENV_BY_NAME: Record<SearchMulticallName, string> = {
  rg: "ZCODE_RG_BINARY",
  bfs: "ZCODE_BFS_BINARY",
  ugrep: "ZCODE_UGREP_BINARY",
};

export function resolveEffectiveMulticallName(
  env: NodeJS.ProcessEnv = process.env,
  argv0: string = process.argv0,
): SearchMulticallName | undefined {
  const raw = env.ARGV0?.trim() || basename(argv0);
  return MULTICALL_NAMES.has(raw as SearchMulticallName) ? (raw as SearchMulticallName) : undefined;
}

export function runBundledSearchMulticall(
  name: SearchMulticallName,
  argv: readonly string[],
  io: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stderr: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
  },
): Promise<number> {
  const binary = io.env?.[ENV_BY_NAME[name]]?.trim();
  if (!binary) {
    io.stderr.write(`zcode ${name}: bundled binary env ${ENV_BY_NAME[name]} is not set\n`);
    return Promise.resolve(127);
  }

  return new Promise((resolve) => {
    const child = spawn(binary, [...argv], {
      cwd: io.cwd,
      env: io.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    child.stdout.on("data", (chunk) => io.stdout.write(chunk));
    child.stderr.on("data", (chunk) => io.stderr.write(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      io.stderr.write(`zcode ${name}: ${error.message}\n`);
      resolve(error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve(code ?? (signal ? 128 : 1));
    });
    if (io.stdin) io.stdin.pipe(child.stdin);
    else child.stdin.end();
  });
}
```

- [ ] **Step 3: Wire `run.ts`**

In `apps/zcode-cli/packages/cli/src/run.ts`, before `__internal-search`:

```ts
const multicallName = resolveEffectiveMulticallName(process.env, process.argv0);
if (multicallName) {
  return runBundledSearchMulticall(multicallName, ctx.argv, {
    cwd: (deps.cwd ?? process.cwd)(),
    env: process.env,
    stderr: ctx.stderr,
    stdin: ctx.stdin,
    stdout: ctx.stdout,
  });
}
```

Do not add `env` to `RunContext` for this task. The CLI process env is the source of truth for `ARGV0`, `ZCODE_RG_BINARY`, `ZCODE_BFS_BINARY`, and `ZCODE_UGREP_BINARY`.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @zcode/cli test -- bundled-search-multicall.test.ts
```

Expected: PASS.

---

### Task 7: Switch Backend Resolver to argv0-dispatch When Bundled Tools Exist

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/embedded-search-backend.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/tests/embedded-search-backend.test.ts`

**Interfaces:**
- Consumes: `ZCODE_BFS_BINARY`, `ZCODE_UGREP_BINARY`
- Produces: `EmbeddedSearchBackend.kind === "argv0-dispatch"` when bundled tools are executable
- Preserves: current `internal-cli` fallback

- [ ] **Step 1: Add tests**

Add tests in `apps/zcode-cli/packages/bootstrap/tests/embedded-search-backend.test.ts`:

```ts
it("uses argv0-dispatch when bfs and ugrep binaries are executable", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-search-backend-"));
  const bfsPath = join(tempDir, process.platform === "win32" ? "bfs.exe" : "bfs");
  const ugrepPath = join(tempDir, process.platform === "win32" ? "ugrep.exe" : "ugrep");
  writeFileSync(bfsPath, "");
  writeFileSync(ugrepPath, "");
  if (process.platform !== "win32") {
    chmodSync(bfsPath, 0o755);
    chmodSync(ugrepPath, 0o755);
  }

  const backend = resolveDefaultEmbeddedSearchBackend({
    argv: ["/usr/local/bin/zcode"],
    env: {
      ZCODE_BFS_BINARY: bfsPath,
      ZCODE_UGREP_BINARY: ugrepPath,
    },
    execArgv: [],
    execPath: "/usr/local/bin/zcode",
  });

  expect(backend).toEqual({
    kind: "argv0-dispatch",
    command: "/usr/local/bin/zcode",
    env: {
      ZCODE_BFS_BINARY: bfsPath,
      ZCODE_UGREP_BINARY: ugrepPath,
    },
  });
});

it("keeps internal-cli when bundled bfs/ugrep are absent or not executable", () => {
  const backend = resolveDefaultEmbeddedSearchBackend({
    argv: ["/usr/local/bin/zcode"],
    env: {
      ZCODE_BFS_BINARY: "/missing/bfs",
      ZCODE_UGREP_BINARY: "/missing/ugrep",
    },
    execArgv: [],
    execPath: "/usr/local/bin/zcode",
  });
  expect(backend.kind).toBe("internal-cli");
});
```

- [ ] **Step 2: Implement resolver branch**

In `resolveDefaultEmbeddedSearchBackend()`, before `internal-cli` fallback:

```ts
const bfsBinary = input.env?.ZCODE_BFS_BINARY?.trim();
const ugrepBinary = input.env?.ZCODE_UGREP_BINARY?.trim();
if (isExecutableSearchTool(bfsBinary) && isExecutableSearchTool(ugrepBinary)) {
  return {
    kind: "argv0-dispatch",
    command: input.execPath,
    env: {
      ...(inheritedEnv ?? {}),
      ZCODE_BFS_BINARY: bfsBinary,
      ZCODE_UGREP_BINARY: ugrepBinary,
      ...(input.env?.ZCODE_RG_BINARY ? { ZCODE_RG_BINARY: input.env.ZCODE_RG_BINARY } : {}),
    },
  };
}
```

Add a small local helper:

```ts
function isExecutableSearchTool(path: string | undefined): path is string {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
```

When `argv[1]` is a script entrypoint, include it in `args` exactly like current `internal-cli` does; `argv0-dispatch` still needs to execute the same ZCode entrypoint, only with `ARGV0` / `exec -a` changed by the shell function.

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @zcode/bootstrap test -- embedded-search-backend.test.ts
```

Expected: PASS.

---

### Task 8: Implement argv0 Prelude

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/embedded-search-prelude.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/bash-startup-script.test.ts`

**Interfaces:**
- Consumes: `EmbeddedSearchBackend.kind === "argv0-dispatch"`
- Produces: shell functions using the argv0 dispatch strategy

- [ ] **Step 1: Add exact-shape tests**

In `embedded-search-prelude.test.ts`, assert argv0-dispatch content contains:

```ts
expect(content).toContain("if [[ -n $ZSH_VERSION ]]; then");
expect(content).toContain("ARGV0=bfs");
expect(content).toContain("elif [[ \"$OSTYPE\" == \"msys\" ]] || [[ \"$OSTYPE\" == \"cygwin\" ]] || [[ \"$OSTYPE\" == \"win32\" ]]; then");
expect(content).toContain("exec -a bfs");
expect(content).toContain("-S dfs -regextype findutils-default");
expect(content).toContain("ARGV0=ugrep");
expect(content).toContain("-G --ignore-files --hidden -I");
```

- [ ] **Step 2: Implement `createArgv0Function()`**

Refactor `embedded-search-prelude.ts` so `argv0-dispatch` uses:

```ts
function createArgv0Function(
  name: "find" | "grep",
  argv0: "bfs" | "ugrep",
  backend: EmbeddedSearchBackend,
  defaultArgs: readonly string[],
  bypassLines: readonly string[] = [],
): string {
  const invocationArgs = defaultArgs.length > 0 ? `${defaultArgs.join(" ")} "$@"` : '"$@"';
  const envAssignments = createBackendEnvAssignments(backend);
  const executable = shellQuote(backend.command);
  const backendArgs = (backend.args ?? []).map(shellQuote).join(" ");
  const commandPrefix = [envAssignments, executable, backendArgs].filter(Boolean).join(" ");
  return [
    `${name}() {`,
    ...bypassLines,
    `  [[ -x ${executable} ]] || { command ${name} "$@"; return; }`,
    "  if [[ -n $ZSH_VERSION ]]; then",
    `    ARGV0=${argv0} ${commandPrefix} ${invocationArgs}`,
    '  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then',
    `    ARGV0=${argv0} ${commandPrefix} ${invocationArgs}`,
    "  elif [[ $BASHPID != $$ ]]; then",
    `    ${envAssignments ? `${envAssignments} ` : ""}exec -a ${argv0} ${executable}${backendArgs ? ` ${backendArgs}` : ""} ${invocationArgs}`,
    "  else",
    `    (${envAssignments ? `${envAssignments} ` : ""}exec -a ${argv0} ${executable}${backendArgs ? ` ${backendArgs}` : ""} ${invocationArgs})`,
    "  fi",
    "}",
  ].join("\n");
}
```

`createBackendEnvAssignments()` should reuse the existing `createShellEnvAssignment()` helper and join `backend.env` entries with spaces:

```ts
function createBackendEnvAssignments(backend: EmbeddedSearchBackend): string {
  return Object.entries(backend.env ?? {})
    .map(([name, value]) => createShellEnvAssignment(name, value))
    .join(" ");
}
```

- [ ] **Step 3: Keep internal-cli unchanged**

Do not alter `internal-cli` behavior in this task. The current passthrough is the fallback path.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts bash-startup-script.test.ts
```

Expected: PASS.

---

### Task 9: Add Real Execution Tests With Stub Binaries

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

**Interfaces:**
- Verifies: Bash prelude actually sources `.sh` and reaches `argv0-dispatch`

- [ ] **Step 1: Add fake zcode dispatcher fixture in test**

In adapters exec tests, create a temporary executable script:

```sh
#!/usr/bin/env sh
case "${ARGV0:-$(basename "$0")}" in
  bfs) printf 'BFS:%s\n' "$*" ;;
  ugrep) printf 'UGREP:%s\n' "$*" ;;
  rg) printf 'RG:%s\n' "$*" ;;
  *) printf 'ZCODE:%s\n' "$*" ;;
esac
```

- [ ] **Step 2: Execute shell command through adapter**

Test command:

```ts
const result = await adapter.run({
  command: {
    mode: "shell",
    command: 'find . -maxdepth 1 -type f; grep -R needle .',
    shellProfile: "posix-bash",
  },
  bashPrelude: {
    kind: "embedded-search",
    backend: { kind: "argv0-dispatch", command: fakeZcodePath },
  },
  cwd: tempDir,
  timeoutMs: 30_000,
  outputLimit: { maxInlineBytes: 1_000_000, maxBufferBytes: 1_000_000, persistOutput: "none" },
  trace: { sessionId: "s", turnId: "t", attributes: { toolCallId: "c" } } as never,
});
```

Expected stdout contains:

```text
BFS:-S dfs -regextype findutils-default . -maxdepth 1 -type f
UGREP:-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl -R needle .
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @zcode/adapters test -- exec.test.ts
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

Expected: PASS.

---

### Task 10: Manual Verification With Real Binaries

**Files:**
- No source changes

**Interfaces:**
- Verifies: actual `bfs` / `ugrep` behavior

- [ ] **Step 1: Verify runtime assets exist**

Run on each target machine:

```bash
echo "$ZCODE_BFS_BINARY"
echo "$ZCODE_UGREP_BINARY"
"$ZCODE_BFS_BINARY" --version
"$ZCODE_UGREP_BINARY" --version
```

Expected:

```text
bfs 4.1.1
ugrep 7.5.0
```

- [ ] **Step 2: Verify Bash alias behavior through ZCode**

Run a Bash tool call in a ZCode session:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/.git" "$tmp/src" "$tmp/.hidden"
printf 'needle visible\n' > "$tmp/src/a.txt"
printf 'needle git\n' > "$tmp/.git/config"
printf 'needle hidden\n' > "$tmp/.hidden/b.txt"
find "$tmp" -maxdepth 3 -type f -name '*.txt' -print | sort
grep -R -n needle "$tmp" | sort
rm -rf "$tmp"
```

Expected:

- `find` includes `src/a.txt` and `.hidden/b.txt`。
- `grep` includes `src/a.txt` and `.hidden/b.txt`。
- `grep` excludes `.git/config` because `--exclude-dir=.git` is applied。

- [ ] **Step 3: Verify fallback**

Unset binary env vars and run:

```bash
env -u ZCODE_BFS_BINARY -u ZCODE_UGREP_BINARY zcode --version
```

Then run a Bash `find` / `grep` command in a session.

Expected:

- No startup crash。
- Backend resolver returns `internal-cli`。
- Search still works with current best-effort fallback。

---

## V1 Decisions

1. 版本严格钉到：`rg 14.1.1`、`bfs 4.1.1`、`ugrep 7.5.0`。
2. `rg` / `bfs` / `ugrep` 都必须在 ZCode 自有预编译产物源里覆盖完整支持平台矩阵：`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`。
3. Windows arm64 是 v1 必达平台，因为当前 desktop build/release 流程已经覆盖 Windows arm64。内部源没有 `bfs.exe` / `ugrep.exe` / `rg.exe` 时，对应 prepare/package job 必须失败。
4. 运行时 resolver 仍保留“env 缺失或不可执行不启用 `argv0-dispatch`”的防御测试，但这只用于损坏安装、开发态或手工执行，不是 release 允许降级的语义。
5. SEA v1 不把 `bfs` / `ugrep` 直接嵌进单文件二进制；SEA 产物必须能通过外置 runtime asset/env 注入消费同一套 search binaries。SEA smoke test 要验证注入成功路径；缺资产时可以防御性 fallback，但不能作为正式评测/发布配置。

## Verification Commands

Run focused tests:

```bash
pnpm --filter @zcode/shared test -- runtimeToolRuntime.test.ts
pnpm --filter @zcode/services test -- runtimeToolResolver.test.ts
pnpm --filter @zcode/desktop test -- searchRuntimeToolsManifest.test.ts download-search-runtime-tool.test.ts runtime-asset-scripts.test.ts preparePrebuildsReleaseReuse.test.ts
pnpm --filter @zcode/cli test -- bundled-search-multicall.test.ts
pnpm --filter @zcode/bootstrap test -- embedded-search-backend.test.ts
pnpm --filter @zcode/adapters test -- embedded-search-prelude.test.ts bash-startup-script.test.ts exec.test.ts
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

Run required repo gates:

```bash
pnpm typecheck
pnpm lint
```

Run manual smoke:

```bash
pnpm --filter @zcode/desktop prepare:runtime-assets
pnpm --filter @zcode/cli build
pnpm --filter @zcode/cli build:sea
```

Run platform asset preflight before publishing:

```bash
for platform_key in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64; do
  os=${platform_key%-*}
  arch=${platform_key##*-}
  ZCODE_TARGET_OS="$os" ZCODE_TARGET_ARCH="$arch" pnpm --filter @zcode/desktop prepare:rg
  ZCODE_TARGET_OS="$os" ZCODE_TARGET_ARCH="$arch" pnpm --filter @zcode/desktop prepare:bfs
  ZCODE_TARGET_OS="$os" ZCODE_TARGET_ARCH="$arch" pnpm --filter @zcode/desktop prepare:ugrep
done
```

## Acceptance Criteria

- Provider-visible embedded branch remains unchanged.
- With valid `ZCODE_BFS_BINARY` and `ZCODE_UGREP_BINARY`, Bash `find` / `grep` are routed through argv0 shell functions.
- Without valid bundled binaries, behavior falls back to existing `internal-cli` / system command path without command hangs or empty output.
- `grep` receives the exact default args and bypass list defined in Global Constraints.
- `find` receives the exact default args defined in Global Constraints.
- macOS zsh, macOS bash, Linux bash, Windows Git Bash, and Windows cmd are all covered by unit tests; cmd does not source POSIX shell functions.
- For every supported desktop platform (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`), `prepare:rg`, `prepare:bfs`, and `prepare:ugrep` produce executable packaged binaries under `packages/desktop/bundled-tools/<platform>/<tool>/`.
- Remote resource manifests include `ripgrep`, `bfs`, and `ugrep` for every remote platform (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`).
- SEA smoke verifies the same `ZCODE_RG_BINARY`, `ZCODE_BFS_BINARY`, and `ZCODE_UGREP_BINARY` injection path works with built SEA output.
