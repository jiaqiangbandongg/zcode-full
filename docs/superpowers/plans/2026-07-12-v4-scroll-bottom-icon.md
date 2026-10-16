# V4 Scroll-to-Bottom Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the v4 timeline scroll-to-bottom control to the icon-only design used by `~/workspace/z-code-2` while preserving its position and accessible name.

**Architecture:** Keep `ConversationTimeline` as the owner of visibility and click behavior. Add one module-level button renderer that uses the shared `Button` primitive and `ArrowDownIcon`, then reuse it in both the composer-dock and no-dock placements.

**Tech Stack:** React 19, TypeScript, Vitest, lucide-react, shared UI `Button`.

## Global Constraints

- Preserve the existing timeline anchoring, visibility state, and click handler.
- Use the existing `chat.scrollToBottom` translation for `aria-label` and `title`; do not show label text inside the button.
- Reuse semantic theme classes and the shared `Button` primitive on desktop and mobile Web.
- Add a Chinese bug-cause comment beside the fix.

---

### Task 1: Replace the visible label with the shared arrow icon control

**Files:**

- Modify: `packages/ui/test/v4SessionPaneLayoutParity.test.ts`
- Modify: `packages/ui/src/v4/ConversationTimeline.tsx`

**Interfaces:**

- Consumes: existing `handleBackToBottom`, `TID_V4_TIMELINE_BOTTOM`, and `chat.scrollToBottom` translation.
- Produces: an icon-only button with the same test id, click behavior, placement, accessible label, and title.

- [x] **Step 1: Write the failing regression test**

Add a source-level parity assertion to the existing layout test:

```ts
expect(timelineSource).toContain('<ArrowDownIcon className="size-4" />');
expect(timelineSource).not.toMatch(/>\s*回到底部\s*</);
expect(timelineSource).toContain('id: "chat.scrollToBottom"');
```

- [x] **Step 2: Run the focused test to verify RED**

Run: `pnpm exec vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts`

Expected: FAIL because `ConversationTimeline.tsx` still renders the visible text `回到底部` and does not render `ArrowDownIcon`.

- [x] **Step 3: Implement the minimal icon-only control**

In `ConversationTimeline.tsx`, import `ArrowDownIcon`, the shared `Button`, and `useZCodeIntl`. Define a module-level `ConversationBackToBottomButton` that renders:

```tsx
<Button
  aria-label={label}
  title={label}
  type="button"
  size="icon"
  variant="outline"
  className={cn("rounded-full bg-card hover:bg-card-selected", className)}
  data-testid={TID_V4_TIMELINE_BOTTOM}
  onClick={onClick}
>
  <ArrowDownIcon className="size-4" />
</Button>
```

Use `intl.formatMessage({ id: "chat.scrollToBottom" })` for `label` and reuse the component in both existing placement branches without changing their positioning semantics.

- [x] **Step 4: Run the focused test to verify GREEN**

Run: `pnpm exec vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the workspace and commit**

Run:

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all commands exit 0.

Commit:

```bash
git add docs/superpowers/plans/2026-07-12-v4-scroll-bottom-icon.md packages/ui/test/v4SessionPaneLayoutParity.test.ts packages/ui/src/v4/ConversationTimeline.tsx
git commit -m "fix(ui): restore scroll-to-bottom arrow icon"
```
