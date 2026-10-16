# CUA Helper 懒启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent-facing CUA 凭据变为纯数据注入——Host 启动与 Agent spawn 零 Helper IO；Helper 由首次 CUA 调用（SDK）或用户显式动作（设置页/授权流）按需拉起，macOS 与 Windows 统一。

**Architecture:** darwin 已有 M7 懒启动基线，本计划收窄其授权流残留（spawn 恒注入稳定 socket）；Windows 从「spawn acquire + waitForTransport(1s)」移植为「稳定 pipe 名 + recipe env 注入 + SDK 首调自 fork」。最后删除 spawn 侧全部等待/探针尸体（`buildCuaProductHelperAgentEnv` 等）。

**Tech Stack:** TypeScript (pnpm monorepo ×2)、Vitest、Node child_process fork、Electron (ELECTRON_RUN_AS_NODE)。

**Spec:** `docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md`（计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

**z-code 仓库（本 worktree：`/Users/dev/orca/workspaces/z-code/petrel`，分支 `feat/cua-helper-lazy-startup`）**

- 每个任务前 `node scripts/check-workspace-freshness.mjs` 通过、`git status --short` 干净再开工；保留他人改动。
- 必要验证：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测（根 `pnpm test:unit:affected` 不替代 CLI 测试与 desktop E2E）。
- 提交遵守 [Conventional Commits 约定](../../docs/git/ai-agent-commit-message-guidelines.md)（Why/What/Risk 正文），**绝不使用 `--no-verify`**。
- 新增代码不写注释（用户明确要求；必要的根因说明仅写在 commit message 与 spec）。
- 跨 worktree 一律 `git -C <path>`，绝不 `cd`。
- 禁止整文件跑 oxfmt（`fmt:check` 基线本身红；只格式化自己新增的行）。
- 不考虑 Linux；darwin/win32 之外平台行为维持现状。

**zcode-cua 仓库（producer，worktree：`/Users/dev/.codex/worktrees/cua-refactor/zcode-cua`）**

- 提交必须带 lore trailers：标题 + 叙事段落 + `Confidence:` + `Scope-risk:` + `Tested:`/`Not-tested:`；本地预检
  `python3 scripts/validate_lore_commit.py --range origin/main..HEAD`。缺任一项 `commit_lore_review` 红，且挂掉会让
  dist/js_eval/helper_lifecycle/package_smoke/e2e 全部 skipped（看起来只有一个 job 失败，实际整条流水线没验）。
- `dist/` 是 git-tracked 且就是包本体：改 src 必须同一 commit 重建 dist。重建前确认 `node_modules`
  不是软链（worktree 常软链到主克隆；是则 `rm node_modules` 摘链后 `corepack pnpm install --frozen-lockfile`）。
- producer pin 只能用脚本改：`pnpm --filter @zcode/zcode-cua-plugin bump:producer <完整40位sha>`（在 z-code 仓库跑；
  producer worktree 场景先 `export ZCODE_CUA_REPO=/Users/dev/.codex/worktrees/cua-refactor/zcode-cua`）。
  手改 `pnpm-workspace.yaml` 的 SHA 会被 `check-cua-baseline.mjs` 拒绝；pin 目标必须已推到远端。**必须全 sha**（短前缀会造混合 sha）。
- 两仓库都提交后立刻 push（并发会话 amend 吞 commit 的历史教训；pin 只信远端 ref）。

**跨仓契约**

- recipe env 键名：`ZCODE_CUA_WIN_HELPER_RECIPE`（producer helperConstants 常量 + z-code 同名字面量，两处一致）。
- fork argv：`[entryPath, "--socket", <稳定pipe名>, "--parent-pid", <hostPid>]`（fork 的 child 侧
  `process.argv.slice(2)` 恰为 4 元，满足 `parseWindowsDevHelperConfig` 校验）。
- fork env：`ELECTRON_RUN_AS_NODE=1`、`[HELPER_ADDON_ENV]=addonPath`（HELPER_ADDON_ENV 即
  `"ZCODE_CUA_HELPER_ADDON"`）、`commandEnv` 白名单合并。

## File Structure

**z-code 仓库**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `packages/services/src/node.ts` | Modify | resolveSpawnEnv 懒分支（Task 1/6）、getStatus win32（Task 7）、删尸体（Task 9） |
| `packages/services/src/cua-permission-broker/stableCuaTransport.ts` | Create | 稳定 pipe 名 singleton + win32 recipe 解析缓存（Task 5） |
| `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts` | Modify | 各任务对应测试收敛 |
| `packages/services/test/agentProxyEnv.test.ts` | Verify-only | 其源码文本守卫锚定 `resolveSpawnEnv: async (`，不得破坏 |

**zcode-cua 仓库**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/tools/computer-use-runtime.ts` | Modify | `ensureStandaloneHelperLaunched` 增加 win32 fork 分支（Task 3） |
| `src/broker/helperConstants.ts` | Modify | 新增 `ZCODE_CUA_WIN_HELPER_RECIPE_ENV` 常量（Task 3） |
| `src/broker/server/cuaProductMcpResolver.ts` | Modify | 删除 `warmHelperForBuiltInPlugin` 预热（Task 3） |
| `test/computer-use-runtime.win-fork.test.ts` | Create | win32 fork 分支单测（Task 3） |
| `dist/**` | Rebuild | 同 commit 重建（Task 4） |

---

### Task 1: resolveSpawnEnv 的 darwin 分支前移（MR1）

**Files:**
- Modify: `packages/services/src/node.ts:2175-2186`
- Test: `packages/services/test/agentProxyEnv.test.ts`（追加一个 source-guard 测试）

**Interfaces:**
- Consumes: `defaultCuaProductHelperLifecycle.peek()`、`isDefaultCuaProductHelperCurrent`、`getOrCreateDefaultCuaProductHelper`（全部已存在，签名不变）。
- Produces: spawn 侧 helper 选择语义——darwin 恒 `undefined`；win32 暂维持现状（Task 6 改）。

- [ ] **Step 1: 写失败的 source-guard 测试**

在 `agentProxyEnv.test.ts` 末尾追加（沿用该文件已有的源码文本提取模式；注意守卫必须先断言提取结果非空，否则 not.toContain 永真——这是本仓库已踩过的坑）：

```ts
describe("node.ts lazy CUA spawn helper selection", () => {
  const source = readFileSync(
    resolve(__dirname, "../src/node.ts"),
    "utf8",
  );
  const spawnEnvStart = source.indexOf("resolveSpawnEnv: async (");

  it("locates the resolveSpawnEnv closure at all", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
  });

  it("short-circuits darwin to undefined before the peeked-host branch (MC-3)", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
    const cuaBlock = source.slice(spawnEnvStart, spawnEnvStart + 4000);
    const darwinShortCircuit = 'process.platform === "darwin"\n            ? undefined';
    const darwinIdx = cuaBlock.indexOf(darwinShortCircuit);
    expect(darwinIdx).toBeGreaterThanOrEqual(0);
    const peekedIdx = cuaBlock.indexOf("peekedHelper && isDefaultCuaProductHelperCurrent");
    expect(peekedIdx).toBeGreaterThan(darwinIdx);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/services/test/agentProxyEnv.test.ts`
Expected: 新增 case FAIL（现状是 peeked 分支在 darwin 判定之前）。

- [ ] **Step 3: 改 node.ts 分支顺序**

把 `node.ts:2176-2186` 现状：

```ts
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
          ? peekedHelper
          : process.platform === "darwin"
            ? undefined
            : await getOrCreateDefaultCuaProductHelper(context);
```

改为（darwin 短路提到最前，注释块同步替换为指向新 spec 的单行）：

```ts
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : process.platform === "darwin"
          ? undefined
          : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
            ? peekedHelper
            : await getOrCreateDefaultCuaProductHelper(context);
```

同时把上方 `// M7 懒启动：…` 注释块替换为一行：
`// 懒启动规范（docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md）：darwin spawn 恒稳定 socket，托管 host 不参与 spawn 凭据；win32 于 MR2 前仍走 acquire。`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/services/test/agentProxyEnv.test.ts`
Expected: PASS（含既有全部 case——锚点 `resolveSpawnEnv: async (` 未动）。

- [ ] **Step 5: 跑受影响面验证**

Run: `pnpm typecheck && pnpm lint && pnpm architecture:check --changed && pnpm vitest run packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`
Expected: 全绿（该文件现有 case 不应受影响——它们测 lifecycle 层，不测 spawn 分支顺序）。

- [ ] **Step 6: Commit**

```bash
git add packages/services/src/node.ts packages/services/test/agentProxyEnv.test.ts
git commit -m "$(cat <<'EOF'
fix(services): keep darwin agent spawn off the managed helper path

Why:
- M7 懒启动后授权流残留：peeked host 存在时 darwin spawn 仍走
  buildCuaProductHelperAgentEnv 的 warm 探针（挂死 Helper 吃满 1s），
  违反懒启动规范"spawn 注入零 Helper IO"的不变量

What:
- darwin 分支短路提前：恒 undefined（稳定 socket 注入路径已存在），
  peeked host 只服务权限面板与重启，不再参与 spawn 凭据

Risk:
- 授权流窗口内 spawn 改走稳定 socket，SDK 自拉 standalone（spec §3.6 并存窗口，
  属已确认取舍）；vitest/lint/typecheck/arch 全绿
EOF
)"
```

---

### Task 2: MR1 收尾验证与 push

**Files:** 无新改动（验证任务）。

- [ ] **Step 1: 全量必要验证**

Run: `pnpm typecheck && pnpm lint && pnpm architecture:check --changed && pnpm test:unit:affected`
Expected: 全绿；如有既有红（非本次引入），按 AGENTS.md 区分报告，不得混入。

- [ ] **Step 2: Push**

```bash
git push -u origin feat/cua-helper-lazy-startup
```

（MR 创建由用户触发，不在本计划内。）

---

### Task 3: producer——win32 fork 分支 + 删预热（MR2-producer）

**仓库：** `/Users/dev/.codex/worktrees/cua-refactor/zcode-cua`，**新建分支** `feat/win-lazy-fork`（基于 origin/main，浅克隆先 `git fetch --deepen=300`）。

**Files:**
- Modify: `src/tools/computer-use-runtime.ts`
- Modify: `src/broker/helperConstants.ts`
- Modify: `src/broker/server/cuaProductMcpResolver.ts:390-409`（`warmHelperForBuiltInPlugin` 及其调用点）
- Create: `test/computer-use-runtime.win-fork.test.ts`

**Interfaces:**
- Produces: `ensureStandaloneHelperLaunched(socketPath, env, options?)` 的 win32 行为（options 形参供测试注入 fork 实现）；`ZCODE_CUA_WIN_HELPER_RECIPE_ENV = "ZCODE_CUA_WIN_HELPER_RECIPE"`（helperConstants 导出）。

- [ ] **Step 1: helperConstants 加常量**

在 `src/broker/helperConstants.ts` 的 env 常量区（`HELPER_ADDON_ENV` 附近）加：

```ts
export const ZCODE_CUA_WIN_HELPER_RECIPE_ENV = "ZCODE_CUA_WIN_HELPER_RECIPE";
```

- [ ] **Step 2: 写失败的 win32 fork 单测**

`test/computer-use-runtime.win-fork.test.ts`（建模自 `test/computer-use-runtime.dev-helper-refresh.test.ts` 的 `__testing` 模式）：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  HELPER_ADDON_ENV,
  ZCODE_CUA_WIN_HELPER_RECIPE_ENV,
} from "../src/broker/helperConstants.js";

const { __testing } = await import("../src/tools/computer-use-runtime.js");

const RECIPE = {
  command: "C:\\app\\ZCode.exe",
  entryPath: "C:\\app\\resources\\tools\\cua-helper\\entry.cjs",
  root: "C:\\app\\resources\\tools\\cua-helper",
  addonPath: "C:\\app\\resources\\tools\\cua-helper\\addon.node",
  commandEnv: { ZCODE_CUA_X: "1" },
  hostPid: 4242,
};

function makeForkSpy() {
  const fork = vi.fn(() => ({ unref: () => {}, pid: 999 })) as never;
  return { fork, calls: () => (fork as unknown as { mock: { calls: unknown[][] } }).mock.calls };
}

describe("ensureStandaloneHelperLaunched win32 fork", () => {
  it("no-ops without a recipe env", async () => {
    const { fork, calls } = makeForkSpy();
    await __testing.ensureStandaloneHelperLaunched("\\\\.\\pipe\\zcode-cua-x", {}, { fork });
    expect(calls()).toHaveLength(0);
  });

  it("no-ops on invalid recipe JSON", async () => {
    const { fork, calls } = makeForkSpy();
    await __testing.ensureStandaloneHelperLaunched("\\\\.\\pipe\\zcode-cua-x", {
      [ZCODE_CUA_WIN_HELPER_RECIPE_ENV]: "{not-json",
    }, { fork });
    expect(calls()).toHaveLength(0);
  });

  it("forks with the stable pipe, host pid and addon env", async () => {
    const { fork, calls } = makeForkSpy();
    await __testing.ensureStandaloneHelperLaunched("\\\\.\\pipe\\zcode-cua-x", {
      [ZCODE_CUA_WIN_HELPER_RECIPE_ENV]: JSON.stringify(RECIPE),
    }, { fork });
    expect(calls()).toHaveLength(1);
    const [command, argv, options] = calls()[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(RECIPE.command);
    expect(argv).toEqual([
      RECIPE.entryPath,
      "--socket",
      "\\\\.\\pipe\\zcode-cua-x",
      "--parent-pid",
      "4242",
    ]);
    expect(options).toMatchObject({
      cwd: RECIPE.root,
      detached: true,
      stdio: "ignore",
    });
    expect((options.env as Record<string, string>)[HELPER_ADDON_ENV]).toBe(RECIPE.addonPath);
    expect((options.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
    expect((options.env as Record<string, string>).ZCODE_CUA_X).toBe("1");
  });

  it("swallows fork failures so the warmup retry reports the real error", async () => {
    const fork = vi.fn(() => { throw new Error("EBUSY"); }) as never;
    await expect(
      __testing.ensureStandaloneHelperLaunched("\\\\.\\pipe\\zcode-cua-x", {
        [ZCODE_CUA_WIN_HELPER_RECIPE_ENV]: JSON.stringify(RECIPE),
      }, { fork }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run test/computer-use-runtime.win-fork.test.ts`
Expected: FAIL（win32 分支不存在 / `options` 形参不存在）。

- [ ] **Step 4: 实现 win32 分支**

`src/tools/computer-use-runtime.ts`：

1. `ensureStandaloneHelperLaunched` 增加第三参 `options: { fork?: typeof import("node:child_process").fork } = {}`，`__testing` 导出同步签名。
2. 函数体最前部改为：

```ts
async function ensureStandaloneHelperLaunched(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  options: { fork?: (command: string, args: string[], opts: unknown) => { unref(): void } } = {},
): Promise<void> {
  if (process.platform === "win32") {
    await ensureWindowsHelperForked(socketPath, env, options.fork);
    return;
  }
  if (process.platform !== "darwin") return;
  // …现有 darwin 实现不变…
```

3. 新增私有函数（同文件，darwin 实现之后）：

```ts
async function ensureWindowsHelperForked(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  forkImpl?: (command: string, args: string[], opts: unknown) => { unref(): void },
): Promise<void> {
  const raw = env[ZCODE_CUA_WIN_HELPER_RECIPE_ENV]?.trim();
  if (!raw) return;
  let recipe: {
    command: string; entryPath: string; root: string;
    addonPath: string; commandEnv: Record<string, string>; hostPid: number;
  };
  try {
    recipe = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    typeof recipe.command !== "string" || !recipe.command ||
    typeof recipe.entryPath !== "string" || !recipe.entryPath ||
    typeof recipe.root !== "string" || !recipe.root ||
    typeof recipe.addonPath !== "string" || !recipe.addonPath ||
    !recipe.commandEnv || typeof recipe.commandEnv !== "object" ||
    !Number.isInteger(recipe.hostPid) || recipe.hostPid <= 0
  ) {
    return;
  }
  const { fork } = await import("node:child_process");
  const run = forkImpl ?? fork;
  try {
    const child = run(
      recipe.command,
      [recipe.entryPath, "--socket", socketPath, "--parent-pid", String(recipe.hostPid)],
      {
        cwd: recipe.root,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ...recipe.commandEnv,
          [HELPER_ADDON_ENV]: recipe.addonPath,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ) as unknown as { unref(): void };
    child.unref();
  } catch {
    // 拉起 best-effort：失败交给 warmup 重试环用真实 broker 错误收口（与 darwin LS open 同口径）。
  }
}
```

（`HELPER_ADDON_ENV`、`ZCODE_CUA_WIN_HELPER_RECIPE_ENV` 从 helperConstants 补 import。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run test/computer-use-runtime.win-fork.test.ts test/computer-use-runtime.dev-helper-refresh.test.ts`
Expected: PASS（新旧都绿——darwin 路径未动）。

- [ ] **Step 6: 删除 warmHelperForBuiltInPlugin**

`src/broker/server/cuaProductMcpResolver.ts`：删除 `warmHelperForBuiltInPlugin` 函数（约 390-397 行）及 `resolveMcpServersImpl` 内唯一调用点（约 406-408 行 `if (!host.running) { warmHelperForBuiltInPlugin(); return servers; }` → 直接 `return servers;`）。同步删除/调整引用它的既有测试（`rg -n warmHelperForBuiltInPlugin test/ src/` 找全）。

Run: `pnpm vitest run`（全量，producer 体量可控）
Expected: 全绿。

- [ ] **Step 7: producer 全量验证**

Run: `pnpm vitest run && pnpm typecheck 2>/dev/null || npx tsc -p tsconfig.json --noEmit`
（以 producer package.json 实际 scripts 为准；若 typecheck 脚本不存在用 tsc 直跑。）
Expected: 全绿。

- [ ] **Step 8: 重建 dist 并带 lore 提交**

先确认 node_modules 非软链：`readlink node_modules` 为空则直接 build；否则：

```bash
rm node_modules && corepack pnpm install --frozen-lockfile
```

（不带 -rf、不带尾斜杠——穿透会删主克隆。）

```bash
node -e "console.log(Object.keys(require('./package.json').scripts))"   # 确认构建脚本名（预期含 build）
corepack pnpm run build   # 用上一步确认的实际脚本名，产出 dist/
python3 scripts/validate_lore_commit.py --range origin/main..HEAD
git -C /Users/dev/.codex/worktrees/cua-refactor/zcode-cua add src test dist
git -C /Users/dev/.codex/worktrees/cua-refactor/zcode-cua commit -m "$(cat <<'EOF'
feat(lazy-start): fork the Windows helper on first broker use

Agent spawn no longer acquires the managed helper on win32; the SDK forks
it on the first CUA call using a host-minted stable pipe name delivered
via ZCODE_CUA_WIN_HELPER_RECIPE. The child is detached with
--parent-pid pointing at the host so its lifetime follows the host, not
the forking agent; concurrent first calls lose the pipe-bind race
harmlessly. warmHelperForBuiltInPlugin prewarming is removed — an eager
start contradicts the lazy-start invariant that only first use, explicit
user action, or permission maintenance may start the helper.

Confidence: high
Scope-risk: moderate
Tested: pnpm vitest run (win-fork + dev-helper-refresh + resolver suites)
EOF
)"
git -C /Users/dev/.codex/worktrees/cua-refactor/zcode-cua push -u origin feat/win-lazy-fork
```

（若 dist 重建含既有尾空格导致 `--check-diff` 报红：那是 main 上既有基线，非本次引入——如实区分，不要为过门改无关文件。）

---

### Task 4: z-code——稳定 pipe 名与 recipe 模块

**Files:**
- Create: `packages/services/src/cua-permission-broker/stableCuaTransport.ts`
- Create: `packages/services/test/stableCuaTransport.test.ts`

**Interfaces:**
- Produces:
  - `getStableCuaPipeName(): string`——进程级 singleton，首次调用用 `mintBrokerSocketPath({ env: process.env })` 铸造（与 `windowsCuaHelperHostSupport.ts` 的 `defaultSocketPathFactory` 同源，import 路径 `@zcode/zcode-cua/broker/socketPath`，照抄该文件现有 import）。
  - `resolveStableCuaWinRecipe(): Promise<StableCuaWinRecipe | null>`——`{ command, entryPath, root, addonPath, commandEnv }`；内部 `resolveWindowsCuaRuntime()`（`#src/cua-permission-broker/windowsCuaDevRuntime.js`），成功缓存、失败返回 null 并 warn 一次；并发调用共享同一 in-flight promise。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const { getStableCuaPipeName, __resetStableCuaTransportForTest } = await import(
  "../src/cua-permission-broker/stableCuaTransport.js"
);

describe("stableCuaTransport", () => {
  afterEach(() => __resetStableCuaTransportForTest());

  it("mints one pipe name per process and returns it forever", () => {
    const first = getStableCuaPipeName();
    expect(first).toBeTruthy();
    expect(getStableCuaPipeName()).toBe(first);
  });

  it("returns null recipe when runtime resolution fails", async () => {
    vi.doMock("../src/cua-permission-broker/windowsCuaDevRuntime.js", () => ({
      resolveWindowsCuaRuntime: vi.fn().mockRejectedValue(new Error("unsupported-platform")),
    }));
    const { resolveStableCuaWinRecipe } = await import(
      "../src/cua-permission-broker/stableCuaTransport.js"
    );
    expect(await resolveStableCuaWinRecipe()).toBeNull();
    vi.doUnmock("../src/cua-permission-broker/windowsCuaDevRuntime.js");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/services/test/stableCuaTransport.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
import { mintBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const logger = createServiceLogger("stable-cua-transport");

export interface StableCuaWinRecipe {
  command: string;
  entryPath: string;
  root: string;
  addonPath: string;
  commandEnv: Record<string, string>;
}

let stablePipeName: string | null = null;
let recipePromise: Promise<StableCuaWinRecipe | null> | null = null;

export function getStableCuaPipeName(): string {
  stablePipeName ??= mintBrokerSocketPath({ env: process.env });
  return stablePipeName;
}

export function resolveStableCuaWinRecipe(): Promise<StableCuaWinRecipe | null> {
  recipePromise ??= resolveWindowsCuaRuntime()
    .then((runtime) => ({
      command: runtime.command,
      entryPath: runtime.entryPath,
      root: runtime.root,
      addonPath: runtime.addonPath,
      commandEnv: runtime.commandEnv,
    }))
    .catch((error: unknown) => {
      logger.warn(
        undefined,
        `Windows CUA helper recipe unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
  return recipePromise;
}

export function __resetStableCuaTransportForTest(): void {
  stablePipeName = null;
  recipePromise = null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/services/test/stableCuaTransport.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/services/src/cua-permission-broker/stableCuaTransport.ts packages/services/test/stableCuaTransport.test.ts
git commit -m "$(cat <<'EOF'
feat(services): add process-stable CUA pipe name and win recipe cache

Why:
- win32 懒启动需要 spawn env 注入的 pipe 名与 helper 实际 bind 的名字
  恒一致（spec 不变量 5），且 recipe 解析结果跨 spawn 复用

What:
- getStableCuaPipeName 进程级 singleton（mintBrokerSocketPath 一次性铸造）
- resolveStableCuaWinRecipe 包装 resolveWindowsCuaRuntime，成功缓存、
  失败 warn 一次并返回 null（fail-closed 由 spawn env 分支处理）

Risk:
- 纯新增模块，无消费方；单测覆盖 singleton 与失败路径
EOF
)"
```

---

### Task 5: z-code——spawn env win32 懒分支

**Files:**
- Modify: `packages/services/src/node.ts:2175-2225`（Task 1 改后的块）
- Test: `packages/services/test/agentProxyEnv.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `getStableCuaPipeName` / `resolveStableCuaWinRecipe`；既有 `resolveBrokerSocketPath`、`BROKER_SOCKET_ENV`、`ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY`、`BROKER_UNAVAILABLE_ENV`、`randomBytes`。
- Produces: win32 spawn 不再调用 `getOrCreateDefaultCuaProductHelper`；env 含 `ZCODE_CUA_BROKER_SOCKET`、`ZCODE_CUA_PLUGIN_AUTHORITY`、`ZCODE_CUA_WIN_HELPER_RECIPE`。

- [ ] **Step 1: 写失败测试（source-guard，先断言锚点非空）**

`agentProxyEnv.test.ts` 的 lazy describe 里追加：

```ts
  it("keeps win32 spawn off the acquire path (MC-4)", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
    const cuaBlock = source.slice(spawnEnvStart, spawnEnvStart + 6000);
    expect(cuaBlock).toContain("getStableCuaPipeName()");
    expect(cuaBlock.indexOf("getStableCuaPipeName()")).toBeLessThan(
      cuaBlock.indexOf("getOrCreateDefaultCuaProductHelper(context)"),
    );
    expect(cuaBlock).toContain("ZCODE_CUA_WIN_HELPER_RECIPE");
  });
```

（`getOrCreateDefaultCuaProductHelper(context)` 字面此后不再出现在 resolveSpawnEnv 块内——indexOf 返回 -1 时 LessThan 判定天然成立且语义正确。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/services/test/agentProxyEnv.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改写 spawn env CUA 块**

Task 1 改后，把 helper 选择与后续消费整体删除（不再有过渡态）：

- 删除 `peekedHelper`、`helper`、`cuaProductHelperHost` 三个变量及 `cuaProductHelperWorkspaceRegistry.setEnabled(context, Boolean(cuaProductHelperHost))` 行；
- 删除 `else if (cuaProductHelperHost && helper) { …buildCuaProductHelperAgentEnv… }` 与 `else if (cuaPluginEnabled && defaultCuaProductHelperLifecycle.disposed)` 两个分支（`buildCuaProductHelperAgentEnv` 的调用点就此消失，函数本体留待 Task 8 删）。

懒注入分支改为两平台通用（替换现有 `if (!helper && cuaPluginEnabled && process.platform === "darwin")` 块）：

```ts
      let cuaProductHelperEnv: Record<string, string> = {};
      if (!helper && cuaPluginEnabled && (process.platform === "darwin" || process.platform === "win32")) {
        const brokerSocket =
          process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: brokerSocket,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        if (process.platform === "win32") {
          const recipe = await resolveStableCuaWinRecipe();
          if (recipe) {
            cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"] = JSON.stringify({
              ...recipe,
              hostPid: process.pid,
            });
          } else {
            cuaProductHelperEnv = {
              [BROKER_UNAVAILABLE_ENV]:
                "broker_unavailable: windows helper recipe could not be resolved",
            };
          }
        }
        cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
      }
```

后续 `else if (cuaProductHelperHost && helper) { …buildCuaProductHelperAgentEnv… }` 等分支已随变量删除（见上）。`randomBytes` 已在现状懒分支使用（node.ts:2203），无需补 import。顶部补 import：`getStableCuaPipeName`、`resolveStableCuaWinRecipe`（`#src/cua-permission-broker/stableCuaTransport.js`）。

- [ ] **Step 4: 跑测试与受影响面**

Run: `pnpm vitest run packages/services/test/agentProxyEnv.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`
Expected: agentProxyEnv PASS；cuaPermissionBrokerProductAgentEnv 中直接测 spawn 注入旧路径的 case（如 "injects the Helper broker socket, token and plugin authority…"、"marks zcode-cua unavailable…" 系列）预期转红——这些属 Task 8 收敛范围，**本步骤允许既有红**，但必须逐条确认红因是「被测路径已删除」，记录清单，不得有其他红。

- [ ] **Step 5: typecheck/lint**

Run: `pnpm typecheck && pnpm lint && pnpm architecture:check --changed`
Expected: 绿（`buildCuaProductHelperAgentEnv` 仍被导出，本任务不断引用）。

- [ ] **Step 6: Commit**

```bash
git add packages/services/src/node.ts packages/services/test/agentProxyEnv.test.ts
git commit -m "$(cat <<'EOF'
feat(services): inject stable CUA credentials at win32 spawn without IO

Why:
- win32 spawn 原先 await acquire + waitForTransport(1s)，且该 grace race
  等待的是完整 startup 而非真正需要的 tuple（结构性浪费）

What:
- win32 spawn 恒注入稳定 pipe 名 + spawn 铸 authority + fork recipe env；
  recipe 解析失败 fail-closed 到 BROKER_UNAVAILABLE
- spawn 不再 acquire 托管 host；darwin 分支沿用 Task 1 的稳定 socket 注入

Risk:
- cuaPermissionBrokerProductAgentEnv.test.ts 中直接测旧 spawn 注入路径的
  case 暂红，Task 8 统一收敛（清单已记录）
EOF
)"
```

---

### Task 6: z-code——getStatus win32 对齐（MC-9）

**Files:**
- Modify: `packages/services/src/node.ts:1894-1971`（getStatus）与 `node.ts:1037-1055`（win32 host 创建处注入 mintSocketPath）

**Interfaces:**
- Consumes: Task 4 的 `getStableCuaPipeName`；既有 `probeStableCuaHelperSocket`、`getOrCreateDefaultCuaProductHelper`、`callBrokerMethod`。
- Produces: win32 getStatus = probe → host fork（stable pipe）→ permission_status 真值 → idle 降级。

> 注：`getStatus` 是 `createNodeServices` 内的闭包，本文件既有测试均不直接触达它（测试清单可证）；
> 本任务不做单测，行为验证归 Task 9 的实机清单（darwin 侧 getStatus 行为沿 M7 不变，win32 侧本就无实机）。

- [ ] **Step 1: 实现**

1. `node.ts:1037-1055` `createWindowsCuaHelperHost({…})` 的 options 增加 `mintSocketPath: () => getStableCuaPipeName()`（经 `createDefaultCuaProductHelper` 的 win32 分支传入，保持其余选项不变）。
2. getStatus 开头的平台短路替换：

```ts
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
```

3. darwin 独占的 `launchStandaloneCuaHelperForStatus` 调用处（约 1929-1932）改为平台分派：

```ts
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable =
            process.platform === "darwin"
              ? await launchStandaloneCuaHelperForStatus()
              : await launchWindowsCuaHelperForStatus();
        }
```

4. 新增 `launchWindowsCuaHelperForStatus`（放在 `launchStandaloneCuaHelperForStatus` 之后，同层闭包）：

```ts
  const launchWindowsCuaHelperForStatus = async (): Promise<string | null> => {
    try {
      const managed = await getOrCreateDefaultCuaProductHelper(undefined);
      if (managed) void managed.host.start().catch(() => {});
    } catch {
      // 拉起 best-effort；失败由下面的轮询超时统一降级。
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
```

（`probeStableCuaHelperSocket` 用 `createConnection`，named pipe 同样适用，无需改。）

- [ ] **Step 2: 验证不回归**

Run: `pnpm typecheck && pnpm lint && pnpm architecture:check --changed && pnpm vitest run packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`
Expected: 绿（红的仍限 Task 5 记录的清单；本任务不新增测试，行为验证归 Task 9 实机）。

- [ ] **Step 3: Commit**

```bash
git add packages/services/src/node.ts
git commit -m "$(cat <<'EOF'
feat(services): serve win32 CUA permission status via stable pipe

Why:
- win32 设置页此前直接返回 "only available on macOS"，用户拿不到任何状态；
  懒启动规范 §3.5 要求两平台统一 probe→按需拉起→真值→idle 降级

What:
- getStatus 支持 win32：probe 稳定 pipe，无则经托管 host fork（注入
  stable mintSocketPath，与 SDK 自拉汇聚同一 pipe），5s 轮询后降级 idle:true
- 平台短路改为 darwin+win32 白名单

Risk:
- getStatus 为 services 闭包、无单测触达面（既有测试均不直接测它）；
  Windows 实机未验证（开发机 macOS），MC-9 归实机清单，MR 标注
EOF
)"
```

---

### Task 7: z-code——producer pin bump

**Files:**
- Modify（脚本自动）: `apps/zcode-cli/packages/zcode-cua-plugin/upstream.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 等 bump 脚本触达面。

- [ ] **Step 1: 确认 producer 分支已 push**

Run: `git -C /Users/dev/.codex/worktrees/cua-refactor/zcode-cua ls-remote origin feat/win-lazy-fork`
Expected: 输出远端 ref 与完整 sha（Task 3 已 push）。

- [ ] **Step 2: 原子 bump（完整 40 位 sha）**

```bash
export ZCODE_CUA_REPO=/Users/dev/.codex/worktrees/cua-refactor/zcode-cua
pnpm --filter @zcode/zcode-cua-plugin bump:producer <上一步的完整40位sha>
```

**禁止**手改 `pnpm-workspace.yaml` 的 SHA（`check-cua-baseline.mjs` 会拒），**禁止**短前缀。

- [ ] **Step 3: 安装与验证**

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm architecture:check --changed
```

- [ ] **Step 4: Commit**

```bash
git add apps/zcode-cli/packages/zcode-cua-plugin/upstream.json pnpm-workspace.yaml pnpm-lock.yaml
# 以 bump 脚本实际改动的文件清单为准（git status 逐个确认，只提交脚本产物）
git commit -m "$(cat <<'EOF'
chore(cua): bump zcode-cua producer for win32 lazy fork

Why:
- 懒启动 win32 分支的 SDK fork 能力与 warmHelper 删除都在 producer
  feat/win-lazy-fork，需 pin 到该提交

What:
- 经 bump:producer 原子命令同步 pin/lock/契约并自校验

Risk:
- 脚本自校验通过；producer CI 在远端分支验证
EOF
)"
```

---

### Task 8: z-code——删除 spawn 侧尸体与测试收敛

**Files:**
- Modify: `packages/services/src/node.ts`（`buildCuaProductHelperAgentEnv` 1123-1281、常量 566、相关 import）
- Modify: `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`（收敛 Task 5 记录的红名单）

**Interfaces:**
- Produces: `buildCuaProductHelperAgentEnv` 从 node.ts 导出面删除；`CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS` 删除。`getOrCreateDefaultCuaProductHelper` 保留（getStatus/restartHelper/resolver 仍用）。

- [ ] **Step 1: 定位全部引用**

Run:
```bash
rg -n "buildCuaProductHelperAgentEnv|CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS|trackCuaProductHelperStartup|cuaProductHelperAgentEnvRetryAt|cuaProductHelperReservedSpawns|cuaProductHelperTransportSpawns" packages/ apps/ --type ts | rg -v node_modules
```

预期：node.ts 定义处 + cuaPermissionBrokerProductAgentEnv.test.ts 测试处。若出现其他消费方（如 desktop main），停下核实——spec 假设无其他消费方，若假设不成立升级处理而非强删。

- [ ] **Step 2: 删除实现与常量**

删除 `buildCuaProductHelperAgentEnv` 整个函数、`CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS` 常量、以及只为它存在的伴生符号（`trackCuaProductHelperStartup`、`cuaProductHelperAgentEnvRetryAt`、`cuaProductHelperReservedSpawns`、`cuaProductHelperTransportSpawns`、`CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS`——按 Step 1 清单为准，仍被 getStatus/restart 引用的保留）。

- [ ] **Step 3: 测试收敛**

对 Task 5 记录的红名单逐条处置：直接测已删函数的 case 删除；测 resolver/lifecycle 行为且仍有效的 case 保留并修 fixture（如 marker 相关 case 改为只测 resolver 侧语义）。**每删一个 case，在 commit 正文里列出名字**。

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm architecture:check --changed && pnpm vitest run packages/services/test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add -A packages/services
git commit -m "$(cat <<'EOF'
refactor(services): remove the spawn-path helper wait machinery

Why:
- 懒启动规范落地后 buildCuaProductHelperAgentEnv 及其等待/探针/marker
  消费全部不可达（darwin Task 1、win32 Task 5 已切走）

What:
- 删除 buildCuaProductHelperAgentEnv、SPAWN_READY_DEADLINE 常量与只为它
  存在的伴生状态；收敛对应测试 case：<逐条列出删除的 case 名>

Risk:
- getOrCreateDefaultCuaProductHelper 保留（getStatus/restart/resolver 消费）；
  services 全量单测/typecheck/lint/arch 绿
EOF
)"
```

---

### Task 9: 端到端本机验证（darwin 实测 + Windows 标注）

**Files:** 无代码改动。

- [ ] **Step 1: darwin 实机冷启验证（MC-1/2/3）**

```bash
ZCODE_CUA_DEV_MODE=1 pnpm run dev:desktop
```

按 [本地跑 CUA Helper](../../docs/cua-permission-broker/local-dev-helper-runbook.md) 验证：
1. app 启动后 Activity Monitor 无 "ZCode Computer Use" 进程（懒启动未被触发）。
2. 新开对话让模型调 computer-use → Helper 进程出现、调用成功（MC-2）。
3. 在设置页完成一次权限授权流后再 spawn 新 agent → 新 agent env 里 `ZCODE_CUA_BROKER_SOCKET` 为稳定路径而非随机（MC-3；可用 dev 日志核对）。

- [ ] **Step 2: desktop E2E 评估**

按 [.agents/skills/e2e-case-lifecycle/SKILL.md](../../.agents/skills/e2e-case-lifecycle/SKILL.md) 评估
`docs/testing/cua-e2e-case-catalog.md` 是否需要新增/修订 case（spawn 时序断言无法在 E2E 层观测的如实标注；Windows 路径全部标注「待 Windows 实机」）。

- [ ] **Step 3: 汇总未验证项**

在最终 MR 说明中列出：Windows 全链路（fork/pipe/设置页/MC-4~7/9）待实机；producer CI job 状态；本机已验清单。

---

### Task 10: 收尾——spec 状态与 push

**Files:**
- Modify: `docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md`（状态节改为已实现 + 实测结论）

- [ ] **Step 1: 更新 spec §状态**

状态改为「MR1/MR2 已实现；darwin 本机实测通过（MC-1/2/3）；Windows 待实机（MC-4~9）」并附日期。

- [ ] **Step 2: 最终验证 + push**

```bash
pnpm typecheck && pnpm lint && pnpm architecture:check --changed
git add docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md
git commit -m "docs(cua): mark lazy startup spec implemented for mac"
git push
```

MR 创建由用户决定（走 zcode-mr 流程时另起）。
