# 问题上报自动截图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击帮助菜单“问题上报”时，先截取当前窗口任务画面，并把截图放进“提交反馈”弹窗截图区域。

**Architecture:** 在 UI 层新增一个小 helper，把可选平台截图能力转换为 `FeedbackAttachmentDraft[]`；`WorkspaceHelpMenuButton` 在打开反馈前调用 helper。反馈弹窗、上传链路、Electron IPC 截图实现保持不变。

**Tech Stack:** React 19, Zustand, Vitest, TypeScript, existing `IPlatformService.captureWindowScreenshot`.

## Global Constraints

- 先保留 spec，再实现代码；spec 已提交到 `docs/superpowers/specs/2026-06-17-issue-report-auto-screenshot-design.md`。
- 修改 `packages/ui` 已读取并遵守根目录 `DESIGN.md`；本计划不新增可见 UI 样式。
- UI 日志如需新增必须走 `packages/ui/src/logger.ts`；本计划不新增日志。
- import 路径使用 `@/` 或包名绝对路径。
- Web/手机端 `captureWindowScreenshot` 不存在、返回 `null` 或失败时静默降级，仍打开反馈弹窗。
- 不修改远控 relay、main 进程、session/task stream、snapshot、queue、replayable 恢复语义。
- 完成后执行 `pnpm typecheck` 和 `pnpm lint`。

---

### Task 1: Feedback Screenshot Draft Helper

**Files:**
- Create: `packages/ui/src/feedback/feedbackScreenshotDraft.ts`
- Test: `packages/ui/test/feedbackScreenshotDraft.test.ts`

**Interfaces:**
- Consumes: `IPlatformService.captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>`
- Produces: `captureFeedbackScreenshotDraft(platform): Promise<FeedbackAttachmentDraft[]>`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import type { IPlatformService, WindowScreenshotResult } from "@zcode/shared";
import { captureFeedbackScreenshotDraft } from "@/feedback/feedbackScreenshotDraft.js";

const screenshot: WindowScreenshotResult = {
  dataBase64: "base64-image",
  filename: "zcode-error-2026-06-17.png",
  contentType: "image/png",
  size: 12,
};

describe("captureFeedbackScreenshotDraft", () => {
  it("returns a feedback attachment draft when platform screenshot succeeds", async () => {
    const platform = {
      captureWindowScreenshot: vi.fn(async () => screenshot),
    } as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([screenshot]);
    expect(platform.captureWindowScreenshot).toHaveBeenCalledTimes(1);
  });

  it("returns an empty draft when platform screenshot is unavailable", async () => {
    const platform = {} as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([]);
  });

  it("returns an empty draft when platform screenshot fails", async () => {
    const platform = {
      captureWindowScreenshot: vi.fn(async () => {
        throw new Error("capture failed");
      }),
    } as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ui/test/feedbackScreenshotDraft.test.ts`

Expected: FAIL because `@/feedback/feedbackScreenshotDraft.js` does not exist.

- [x] **Step 3: Write minimal implementation**

```ts
import type { IPlatformService } from "@zcode/shared";
import type { FeedbackAttachmentDraft } from "@/feedback/feedbackStore.js";

export async function captureFeedbackScreenshotDraft(
  platform: Pick<IPlatformService, "captureWindowScreenshot">,
): Promise<FeedbackAttachmentDraft[]> {
  const screenshot = await platform.captureWindowScreenshot?.().catch(() => null);
  return screenshot ? [screenshot] : [];
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/ui/test/feedbackScreenshotDraft.test.ts`

Expected: PASS.

---

### Task 2: Workspace Help Menu Uses Screenshot Draft

**Files:**
- Modify: `packages/ui/src/WorkspaceHelpMenuButton.tsx`
- Modify: `packages/ui/test/workspaceHeaderActionSection.test.ts`

**Interfaces:**
- Consumes: `captureFeedbackScreenshotDraft(platform)`
- Produces: help menu issue report draft with `screenshots: FeedbackAttachmentDraft[]`

- [x] **Step 1: Write the failing test**

Update `packages/ui/test/workspaceHeaderActionSection.test.ts`:

```ts
const screenshot = {
  dataBase64: "base64-image",
  filename: "zcode-error-2026-06-17.png",
  contentType: "image/png",
  size: 12,
};

const capturedHeaderHelp = vi.hoisted(() => ({
  openCommunity: vi.fn(),
  openExternal: vi.fn(),
  exportLogs: vi.fn(async () => ({ success: true })),
  captureWindowScreenshot: vi.fn(async () => screenshot),
  openSubmit: vi.fn(),
  openFeatureRequest: vi.fn(),
  menuItems: [] as Array<{
    onSelect: (() => void | Promise<void>) | undefined;
  }>,
}));
```

Mock `usePlatform` with `captureWindowScreenshot`, then update the routing test:

```ts
capturedHeaderHelp.captureWindowScreenshot.mockClear();
capturedHeaderHelp.captureWindowScreenshot.mockResolvedValue(screenshot);

await capturedHeaderHelp.menuItems[0]?.onSelect?.();
capturedHeaderHelp.menuItems[1]?.onSelect?.();
capturedHeaderHelp.menuItems[2]?.onSelect?.();
capturedHeaderHelp.menuItems[3]?.onSelect?.();
capturedHeaderHelp.menuItems[4]?.onSelect?.();

expect(capturedHeaderHelp.captureWindowScreenshot).toHaveBeenCalledTimes(1);
expect(capturedHeaderHelp.openSubmit).toHaveBeenNthCalledWith(
  1,
  expect.objectContaining({
    type: "bug",
    includeLogs: true,
    screenshots: [screenshot],
  }),
);
```

Add a second failure-path assertion:

```ts
it("opens issue report without screenshots when window screenshot fails", async () => {
  capturedHeaderHelp.menuItems = [];
  capturedHeaderHelp.openSubmit.mockClear();
  capturedHeaderHelp.captureWindowScreenshot.mockReset();
  capturedHeaderHelp.captureWindowScreenshot.mockRejectedValue(new Error("capture failed"));
  const { WorkspaceHeaderActionSection } =
    await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

  renderToStaticMarkup(
    createElement(WorkspaceHeaderActionSection, {
      workspaceAbsPath: "/workspace",
      isTerminalOpen: false,
      isSidePaneOpen: false,
      onToggleTerminal: vi.fn(),
      onToggleSidePane: vi.fn(),
    }),
  );

  await capturedHeaderHelp.menuItems[0]?.onSelect?.();

  expect(capturedHeaderHelp.openSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "bug",
      includeLogs: true,
      screenshots: [],
    }),
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ui/test/workspaceHeaderActionSection.test.ts`

Expected: FAIL because the current issue report handler does not call `captureWindowScreenshot` and does not pass `screenshots`.

- [x] **Step 3: Write minimal implementation**

Update `packages/ui/src/WorkspaceHelpMenuButton.tsx`:

```ts
import { captureFeedbackScreenshotDraft } from "@/feedback/feedbackScreenshotDraft.js";
```

Replace `handleOpenIssueReport`:

```ts
const handleOpenIssueReport = async () => {
  const screenshots = await captureFeedbackScreenshotDraft(platform);
  openFeedbackSubmit({
    type: "bug",
    module: "其它",
    severity: "P2-中",
    includeLogs: true,
    screenshots,
  });
};
```

Keep menu binding as `onSelect={handleOpenIssueReport}`.

- [x] **Step 4: Run focused tests to verify they pass**

Run:

```bash
pnpm exec vitest run packages/ui/test/feedbackScreenshotDraft.test.ts packages/ui/test/workspaceHeaderActionSection.test.ts
```

Expected: PASS.

---

### Task 3: Full Verification And Commit

**Files:**
- Verify all files changed by Tasks 1-2.

**Interfaces:**
- Consumes: implementation from Tasks 1-2.
- Produces: committed feature implementation.

- [x] **Step 1: Run required typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [x] **Step 2: Run required lint**

Run: `pnpm lint`

Expected: PASS.

- [x] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff -- packages/ui/src/feedback/feedbackScreenshotDraft.ts packages/ui/src/WorkspaceHelpMenuButton.tsx packages/ui/test/feedbackScreenshotDraft.test.ts packages/ui/test/workspaceHeaderActionSection.test.ts`

Expected: only helper, help menu, focused tests, and this implementation plan are changed.

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-17-issue-report-auto-screenshot.md packages/ui/src/feedback/feedbackScreenshotDraft.ts packages/ui/src/WorkspaceHelpMenuButton.tsx packages/ui/test/feedbackScreenshotDraft.test.ts packages/ui/test/workspaceHeaderActionSection.test.ts
git commit -m "feat: attach screenshot to issue reports"
```
