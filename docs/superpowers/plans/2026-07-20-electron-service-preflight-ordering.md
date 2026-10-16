# Electron Service Preflight Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 Desktop E2E 项目 preflight 与 `wdio-electron-service` 初始化同阶段并发导致的 ContextId/窗口竞态。

**Architecture:** `config.before` 只保存 worker specs，不执行任何 browser 命令；`mochaOpts.rootHooks.beforeAll` 在 WDIO 等待全部 service/config `before` hooks 后执行 renderer bridge preflight。必须使用真正由 Mocha 管理的 root hook，不能使用会吞普通异常的 WDIO config `beforeSuite`；preflight rejection 要中止 test body 并产生非零 failure count，同时禁止在同一 hook 内 `reloadSession()`。

**Tech Stack:** WebdriverIO 9、`wdio-electron-service` 9、Mocha、Vitest、TypeScript。

## Global Constraints

- 不增加固定 sleep 或基于 `browser.electron` 单字段的伪完成轮询。
- Mocha root `beforeAll` 必须复用 `currentE2EWorkerSpecs`，保留错误中的 spec 归属。
- 禁止用 WDIO config `beforeSuite` 承载失败屏障；其普通异常不会传播给 Mocha。
- preflight 失败不得在 worker hook 内创建第二个 Electron session。
- bug 原因和修复理由使用中文注释，并记录独立 `before-suite` lifecycle。
- 保留用户已有 I55 未提交改动，本次 commit 只包含此计划列出的文件。
- 必须执行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。

---

### Task 1: 串行化 Electron service 与 renderer preflight

**Files:**

- Modify: `docs/testing/desktop-e2e-runtime-performance.md`
- Modify: `packages/desktop/wdio.conf.ts`
- Modify: `packages/desktop/test/e2eWindowTargetBinding.test.ts`
- Create: `packages/desktop/test/e2eRendererBridgeRootHook.test.ts`
- Create: `packages/desktop/test/e2e/helpers/e2e-renderer-bridge-root-hook.ts`
- Modify: `packages/desktop/test/e2e/helpers/e2e-worker-isolation.ts`
- Modify: `packages/desktop/test/e2eWorkerIsolation.test.ts`
- Modify: `packages/desktop/test/e2e/reporting/e2e-reporting-types.ts`

**Interfaces:**

- Consumes: WDIO `before(capabilities, specs)` 和 Mocha root `beforeAll` 生命周期。
- Produces: `before` 仅设置 `currentE2EWorkerSpecs`；`mochaOpts.rootHooks.beforeAll` 调用 `runE2ERendererBridgePreflight(currentE2EWorkerSpecs)`；失败由 Mocha 计为 root-hook failure，test body 不执行。

- [ ] **Step 1: 先写失败的配置契约测试**

在 `e2eWindowTargetBinding.test.ts` 读取 `wdio.conf.ts`，断言 `before` 不调用 preflight、配置不声明 WDIO `beforeSuite`、`mochaOpts.rootHooks` 调用 preflight 并记录 `before-suite`，同时断言 `runE2ERendererBridgePreflight` 函数片段不含 `browser.reloadSession()`。在 `e2eRendererBridgeRootHook.test.ts` 用真实 Mocha runner 验证 preflight rejection 产生一个 failure 且 test body 不执行，健康路径顺序为 preflight 后 test body。

- [ ] **Step 2: 运行测试并确认因旧实现失败**

Run: `pnpm vitest run packages/desktop/test/e2eWindowTargetBinding.test.ts`

Expected: FAIL，错误指向仍声明 `async beforeSuite`、缺少 `rootHooks` 或 preflight 函数仍包含 `browser.reloadSession()`。

- [ ] **Step 3: 实现最小修复**

在 `wdio.conf.ts` 中实现以下生命周期结构：

```ts
async before(_capabilities, specs) {
  currentE2EWorkerSpecs = specs;
},
mochaOpts: {
  rootHooks: createE2ERendererBridgeRootHooks(async () => {
    await measureE2ELifecyclePhase("before-suite", { specs: currentE2EWorkerSpecs }, async () => {
      await runE2ERendererBridgePreflight(currentE2EWorkerSpecs);
    });
  }),
},
```

`createE2ERendererBridgeRootHooks` 只把 callback 注册为真正的 Mocha `beforeAll`。`runE2ERendererBridgePreflight` 只执行一次 `waitForE2ERendererBridgePreflight()`；成功返回，失败直接调用 `createE2ERendererBridgePreflightError(..., false)`。删除不再使用的 `shouldRebuildE2ESessionAfterPreflightFailure` 导入、实现和对应单测，并把 `"before-suite"` 加入 `E2ELifecyclePhase`。

- [ ] **Step 4: 运行定向单测并确认通过**

Run: `pnpm vitest run packages/desktop/test/e2eWindowTargetBinding.test.ts packages/desktop/test/e2eRendererBridgeRootHook.test.ts packages/desktop/test/e2eWorkerIsolation.test.ts packages/desktop/test/e2eReportingLifecycle.test.ts`

Expected: PASS，0 failures。

- [ ] **Step 5: 执行强制验证**

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Run: `pnpm typecheck`

Run: `pnpm lint`

Expected: 三条命令 exit 0；既有 warning 与新增 failure 分开报告。

- [ ] **Step 6: 复核并提交**

只 stage 本任务七个实现/测试文件与两个文档，复核 staged diff 后提交：

```text
fix(desktop-e2e): serialize renderer preflight startup
```
