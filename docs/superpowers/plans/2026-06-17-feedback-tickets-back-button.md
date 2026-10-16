# 我的反馈返回按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“我的反馈”页面 header 左侧增加返回按钮，点击后回到“提交反馈”页面。

**Architecture:** `FeedbackCenter` 继续作为反馈 Dialog 的 tab 控制层。仅当 tab 为 `tickets` 时在 header 标题前渲染一个低强调 icon button，点击复用 `setTab("submit")`；i18n 新增返回提交页 aria-label。

**Tech Stack:** React 19, Zustand, Vitest, lucide-react, existing `Button`/`DialogHeader` primitives.

## Global Constraints

- 先保留 spec，再实现代码；spec 已提交到 `docs/superpowers/specs/2026-06-17-feedback-tickets-back-button-design.md`。
- 修改 `packages/ui` 已读取并遵守根目录 `DESIGN.md`；使用现有 Button 和语义 token，不新增可见样式体系。
- import 路径使用 `@/` 或包名绝对路径。
- 不改变工单列表加载、刷新、复制 ID、选中高亮、提交反馈或反馈上传逻辑。
- 不修改远控 relay、main 进程、session/task stream、snapshot、queue、replayable 恢复语义。
- 完成后执行 `pnpm typecheck` 和 `pnpm lint`。

---

### Task 1: Feedback Center Tickets Back Button

**Files:**
- Modify: `packages/ui/src/feedback/FeedbackCenter.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/test/feedbackCenter.test.ts`

**Interfaces:**
- Consumes: `useFeedbackStore((state) => state.setTab)` and current `tab`.
- Produces: tickets header back button with aria-label `feedback.center.backToSubmit`.

- [x] **Step 1: Write the failing test**

Update `packages/ui/test/feedbackCenter.test.ts`:

```ts
expect(source).toContain("ArrowLeftIcon");
expect(source).toContain('tab === "tickets"');
expect(source).toContain('data-feedback-back-to-submit="true"');
expect(source).toContain('feedback.center.backToSubmit');
expect(source).toContain('setTab("submit")');
```

Add localized copy assertions for `feedback.center.backToSubmit` in both locale files.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ui/test/feedbackCenter.test.ts`

Expected: FAIL because the tickets header does not render a back button or aria-label.

- [x] **Step 3: Implement minimal UI and i18n**

Update `packages/ui/src/feedback/FeedbackCenter.tsx`:

```ts
import { ArrowLeftIcon, XIcon } from "lucide-react";
```

Replace the title section in `DialogHeader` with a left title group:

```tsx
<DialogHeader className="flex-row items-center justify-between gap-2 p-6 pb-0">
  <div className="flex min-w-0 items-center gap-2">
    {tab === "tickets" ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className="shrink-0 rounded-lg text-foreground-subtle hover:text-foreground"
        aria-label={intl.formatMessage({ id: "feedback.center.backToSubmit" })}
        data-feedback-back-to-submit="true"
        onClick={() => setTab("submit")}
      >
        <ArrowLeftIcon className="size-4" />
      </Button>
    ) : null}
    <DialogTitle className="min-w-0 truncate text-base font-medium text-foreground">
      {intl.formatMessage({ id: titleId })}
    </DialogTitle>
  </div>
  <Button ... />
</DialogHeader>
```

Add locale entries near feedback center title keys:

```ts
"feedback.center.backToSubmit": "返回提交反馈",
```

```ts
"feedback.center.backToSubmit": "Back to submit feedback",
```

- [x] **Step 4: Run focused test to verify it passes**

Run: `pnpm exec vitest run packages/ui/test/feedbackCenter.test.ts`

Expected: PASS.

---

### Task 2: Full Verification And Commit

**Files:**
- Verify all files changed by Task 1 and this plan.

**Interfaces:**
- Consumes: implementation from Task 1.
- Produces: committed feature implementation.

- [x] **Step 1: Run required typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [x] **Step 2: Run required lint**

Run: `pnpm lint`

Expected: exit 0. Existing unrelated warnings may remain.

- [x] **Step 3: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- docs/superpowers/plans/2026-06-17-feedback-tickets-back-button.md packages/ui/src/feedback/FeedbackCenter.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/test/feedbackCenter.test.ts
```

Expected: only plan, feedback center header, locale strings, and focused tests changed.

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-17-feedback-tickets-back-button.md packages/ui/src/feedback/FeedbackCenter.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/test/feedbackCenter.test.ts
git commit -m "feat: add feedback tickets back button"
```
