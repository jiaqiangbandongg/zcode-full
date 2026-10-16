# Root Startup Render Block Desktop Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Root startup render block apply only on desktop, while mobile Web remote control keeps the paired loading page visible until the task list can render.

**Architecture:** Keep `RootStartupLoading` as a desktop display component and place the environment decision before `shouldBlockRootRender(...)` is evaluated in `Root.tsx`. For mobile Web remote control, pass a Web-owned loading fallback into `Root` and render it only while the initial workspace tab is not yet available.

**Tech Stack:** React 19, Vitest, React DOM server rendering, TypeScript.

---

### Task 1: Add Root Startup Render Gate Tests

**Files:**
- Modify: `packages/ui/test/rootUpdateReadyOverlay.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a mutable `mockShouldBlockRootRender` and two test cases:

```ts
const mockShouldBlockRootRender = vi.fn(() => false);

vi.mock("@/lib/rootStartupGate.js", () => ({
  isProviderStartupSyncPending: () => false,
  shouldBlockRootRender: () => mockShouldBlockRootRender(),
}));

it("桌面启动阻塞态会挂载 RootStartupLoading", async () => {
  mockShouldBlockRootRender.mockReturnValue(true);

  const html = await renderRoot({ isDesktop: true });

  expect(html).toContain('data-testid="root-startup-loading"');
});

it("Web 端不使用启动阻塞 gate", async () => {
  mockShouldBlockRootRender.mockImplementation(() => {
    throw new Error("web should not call shouldBlockRootRender");
  });

  await expect(renderRoot({ isDesktop: false })).resolves.not.toContain(
    'data-testid="root-startup-loading"',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/rootUpdateReadyOverlay.test.ts`

Expected: the Web startup gate test fails because `Root.tsx` still calls `shouldBlockRootRender(...)` before checking `isDesktop`.

### Task 2: Gate Root Startup Render Block By Desktop

**Files:**
- Modify: `packages/ui/src/Root.tsx`

- [ ] **Step 1: Write minimal implementation**

Short-circuit the startup render gate before calling `shouldBlockRootRender(...)`:

```ts
const isStartupRenderBlocked = Boolean(isDesktop) && shouldBlockRootRender({
  isResolvingStartupAuthState,
  isRestoring,
  isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace ||
    isCreatingFallbackWorkspace,
});
```

Keep `RootStartupLoading` inside the existing blocked branch without a nested Web check.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run packages/ui/test/rootUpdateReadyOverlay.test.ts packages/ui/test/rootStartupLoading.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run required repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0.

### Task 3: Keep Mobile Web Loading Continuous Until Workspace Renders

**Files:**
- Modify: `packages/ui/src/root/types.ts`
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/ui/test/rootUpdateReadyOverlay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("Web 初始 workspace 注入前会渲染入口传入的 loading fallback", async () => {
  const html = await renderRoot({
    isDesktop: false,
    initialWorkspaceAbsPath: "/repo/demo",
    initialWorkspaceLoadingFallback: createElement(
      "div",
      { "data-testid": "web-remote-initial-loading-fallback" },
      "已配对，正在加载工作区...",
    ),
  });

  expect(html).toContain('data-testid="web-remote-initial-loading-fallback"');
});
```

- [ ] **Step 2: Implement the fallback prop**

Add `initialWorkspaceLoadingFallback?: ReactNode` to `RootProps`, destructure it in `RootInner`, and render it only when `!isDesktop && initialWorkspaceAbsPath && !workspaceShellPath`.

- [ ] **Step 3: Pass the Web remote loading screen**

Refactor `renderWebRemoteControlLoading(...)` to reuse a `WebRemoteControlLoadingScreen` component, then pass `<WebRemoteControlLoadingScreen state="paired" />` as `initialWorkspaceLoadingFallback` from Web remote control root renders.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/ui/root-startup-render-block-desktop-only.md docs/superpowers/plans/2026-06-10-root-startup-render-block-desktop-only.md packages/ui/src/root/types.ts packages/ui/src/Root.tsx packages/web/src/main.tsx packages/ui/test/rootUpdateReadyOverlay.test.ts
git commit -m "fix(ui): keep mobile remote loading continuous"
```
