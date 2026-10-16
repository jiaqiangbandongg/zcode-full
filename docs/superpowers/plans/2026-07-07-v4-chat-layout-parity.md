# V4 Chat Layout Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align v4 conversation layout with z-code-2 so the message list and composer share one scroll viewport and one `max-w-3xl` content column.

**Architecture:** Keep `ConversationTimeline` as the owner of virtual scrolling and bottom-following state, but add a `bottomDock` render slot inside its scroll viewport. `SessionPane` passes the existing composer node through that slot for bound sessions and keeps draft layout unchanged.

**Tech Stack:** React 19, Vitest SSR tests, `@tanstack/react-virtual`, Tailwind utility classes, existing v4 `SessionPane` and `ConversationTimeline`.

## Global Constraints

- UI changes must follow root `DESIGN.md` tokens, compact density, responsive desktop/web/mobile behavior, and both light/dark themes.
- UI logs must use `packages/ui/src/logger.ts`; this change adds no logs.
- Import paths stay absolute with `@/`.
- Do not alter remote replayable / desktop continuous message delivery semantics.
- Preserve v4 multi-pane isolation: scroll state remains per `ConversationTimeline` instance.
- Existing user changes in unrelated docs must not be reverted or staged.

---

### Task 1: Layout Parity Test

**Files:**
- Create: `packages/ui/test/v4SessionPaneLayoutParity.test.ts`

**Interfaces:**
- Consumes: `SessionPane` props `paneId`, `sessionId`, `workspacePath`.
- Produces: a regression test that fails until the composer is rendered inside the timeline scroll viewport and both timeline content and dock share `max-w-3xl`.

- [ ] **Step 1: Write the failing test**

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSnapshot,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: { acquire: vi.fn() },
    sendCommand: vi.fn(),
    attachmentPut: vi.fn(),
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    draftConfigRef: { current: {} },
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    prewarmSessionId: null,
    markPromoted: vi.fn(),
    discardPrewarm: vi.fn(),
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: () =>
      React.createElement("div", { "data-testid": "mock-composer" }, "composer"),
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () =>
      React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () =>
      React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () =>
      React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/v4/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () =>
      React.createElement("div", { "data-testid": "mock-turn-group" }),
  };
});

function userInputRow(): UserInputRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1_777_777_777,
    createdAtSeq: 1,
    kind: "userInput",
    text: "hello",
    origin: "realUser",
  };
}

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [userInputRow()], totalCount: 1, firstRowId: 1 },
  };
}

function renderPane(): string {
  projectionState.current = {
    status: "live",
    snapshot: makeSnapshot(),
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SessionPane, {
        paneId: "workspace-main",
        sessionId: "session-1",
        workspacePath: "/workspace",
      }),
    ),
  );
}

describe("SessionPane v4 chat layout parity", () => {
  it("renders composer inside the timeline scroll viewport with the shared content width", () => {
    const html = renderPane();

    expect(html).toContain('data-v4-timeline-scroll="true"');
    expect(html).toContain('data-v4-timeline-content-column="true"');
    expect(html).toContain('data-v4-composer-dock="true"');
    expect(html.indexOf('data-v4-timeline-scroll="true"')).toBeLessThan(
      html.indexOf('data-v4-composer-dock="true"'),
    );
    expect(html.indexOf('data-v4-composer-dock="true"')).toBeLessThan(
      html.indexOf('data-testid="mock-composer"'),
    );
    expect(html).toContain("max-w-3xl");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts`

Expected: FAIL because `data-v4-composer-dock` and `data-v4-timeline-content-column` are not present yet.

### Task 2: Shared Scroll Dock

**Files:**
- Modify: `packages/ui/src/v4/ConversationTimeline.tsx`
- Modify: `packages/ui/src/v4/SessionPane.tsx`
- Modify: `packages/ui/src/v4/ConversationComposer.tsx`

**Interfaces:**
- `ConversationTimelineProps` adds `bottomDock?: ReactNode`.
- `SessionPane` passes `composerNode` as `bottomDock` only in bound-session mode.
- `ConversationComposer` keeps draft `centered` behavior and lets the dock own horizontal padding for session mode.

- [ ] **Step 1: Implement minimal production change**

Add `bottomDock?: ReactNode` to `ConversationTimeline`, render it as a sticky bottom child inside the scroll viewport, wrap virtual rows in a centered `max-w-3xl` column, and move session composer rendering from `SessionPane` sibling position into the timeline `bottomDock`.

- [ ] **Step 2: Run targeted test**

Run: `pnpm vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts`

Expected: PASS.

- [ ] **Step 3: Run existing adjacent tests**

Run: `pnpm vitest run packages/ui/test/v4SessionPaneErrorBanner.test.ts packages/ui/test/v4ConversationComposerErrorBanner.test.ts packages/ui/test/v4TimelineScrollAnchor.test.ts`

Expected: PASS.

### Task 3: Full Verification And Commit

**Files:**
- Verify all touched files.

**Interfaces:**
- Produces a Conventional Commit containing only this task's docs, test, and v4 UI layout code.

- [ ] **Step 1: Run required repo checks**

Run: `pnpm typecheck`

Expected: exit code 0.

Run: `pnpm lint`

Expected: exit code 0.

- [ ] **Step 2: Review staged diff**

Run: `git diff -- docs/v4-refactor/v4-chat-layout-parity.md docs/superpowers/plans/2026-07-07-v4-chat-layout-parity.md packages/ui/test/v4SessionPaneLayoutParity.test.ts packages/ui/src/v4/ConversationTimeline.tsx packages/ui/src/v4/SessionPane.tsx packages/ui/src/v4/ConversationComposer.tsx`

Expected: only layout parity changes.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/v4-refactor/v4-chat-layout-parity.md docs/superpowers/plans/2026-07-07-v4-chat-layout-parity.md packages/ui/test/v4SessionPaneLayoutParity.test.ts packages/ui/src/v4/ConversationTimeline.tsx packages/ui/src/v4/SessionPane.tsx packages/ui/src/v4/ConversationComposer.tsx
git commit -m "fix(ui): align v4 chat scroll layout"
```

Expected: commit succeeds; unrelated pre-existing docs remain unstaged.
