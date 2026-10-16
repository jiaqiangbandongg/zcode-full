# Feedback Ticket Detail Issue ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the feedback ticket issue ID in the “My feedback” detail view and provide a copy button for the raw ID.

**Architecture:** Keep the feature inside `TicketDetailView` because the existing `FeedbackTicketDetail.id` already contains the stable issue identifier. Use the browser clipboard API directly from the UI component and log copy failures through the UI logger.

**Tech Stack:** React 19, TypeScript, Vitest static markup tests, lucide-react icons, existing `Button` UI primitive.

---

### Task 1: Document The UI Contract

**Files:**
- Create: `docs/ui/feedback-ticket-detail-issue-id.md`

- [x] **Step 1: Write the spec**

Document that `FeedbackTicketDetail.id` is displayed as `Issue #<id>`, the copy action writes only `<id>`, and failure logging uses `packages/ui/src/logger.ts`.

- [x] **Step 2: Check scope**

Confirm the change does not alter feedback service APIs, realtime stream boundaries, or remote-control delivery semantics.

### Task 2: Add A Failing Detail View Test

**Files:**
- Modify: `packages/ui/test/feedbackTicketDetail.test.ts`

- [x] **Step 1: Add the test**

```ts
it("shows the issue id with a copy action", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TicketDetailView, {
        ticket: createTicket(),
        feedbackService: {} as IFeedbackService,
        onRefresh: vi.fn(),
        onOpenProcess: vi.fn(),
      }),
    ),
  );

  expect(html).toContain("Issue #");
  expect(html).toContain("ticket-1");
  expect(html).toContain('aria-label="复制 issue 编号"');
});
```

- [x] **Step 2: Run the focused test and verify red**

Run: `pnpm vitest run packages/ui/test/feedbackTicketDetail.test.ts`

Expected: the new test fails because `TicketDetailView` does not render the issue ID or copy action yet.

### Task 3: Implement The Detail Header Control

**Files:**
- Modify: `packages/ui/src/feedback/TicketDetail.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

- [x] **Step 1: Add component state and copy handler**

Import `useCallback`, `useEffect`, `useRef`, `useState`, `Check`, `CopyIcon`, and the UI `logger`. Track a transient copied state and write `ticket.id` to `navigator.clipboard.writeText`.

- [x] **Step 2: Render the issue ID row**

Place a compact `Issue #<id>` row below the status indicator and above the title. The copy button uses `Button variant="ghost" size="icon-sm"` and an accessible localized label.

- [x] **Step 3: Add localization strings**

Add:

```ts
"feedback.detail.issueCopy": "复制 issue 编号",
"feedback.detail.issueCopied": "已复制 issue 编号",
"feedback.detail.issueCopyFailed": "复制 issue 编号失败",
```

and English equivalents:

```ts
"feedback.detail.issueCopy": "Copy issue ID",
"feedback.detail.issueCopied": "Issue ID copied",
"feedback.detail.issueCopyFailed": "Failed to copy issue ID",
```

### Task 4: Verify And Commit

**Files:**
- Test: `packages/ui/test/feedbackTicketDetail.test.ts`

- [x] **Step 1: Run focused test**

Run: `pnpm vitest run packages/ui/test/feedbackTicketDetail.test.ts`

Expected: all tests in the file pass.

- [x] **Step 2: Run required project checks**

Run: `pnpm typecheck`

Expected: TypeScript completes successfully.

Run: `pnpm lint`

Expected: oxlint completes successfully.

- [x] **Step 3: Commit**

Run:

```bash
git add docs/ui/feedback-ticket-detail-issue-id.md docs/superpowers/plans/2026-06-16-feedback-ticket-detail-issue-id.md packages/ui/test/feedbackTicketDetail.test.ts packages/ui/src/feedback/TicketDetail.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts
git commit -m "feat(ui): show feedback issue id in details"
```
