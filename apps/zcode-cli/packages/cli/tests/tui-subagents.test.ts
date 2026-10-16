import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import type { ScrollBoxRenderable } from "@mbears/opentui-core";
import {
  createSessionEvent,
  createSessionId,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import { getZCodeCopy } from "@zcode/i18n";
import { runTuiWithRenderer } from "../../tui/src/tui.js";
import {
  applyMainSessionEvent,
  isMainSessionEvent,
} from "../../tui/src/app-session-event-handler.js";
import {
  applySubagentTranscriptEvent,
  hydrateSubagentTranscript,
} from "../../tui/src/app-subagent-transcript.js";
import type { TuiOptions, TuiSubagentTranscriptSnapshot } from "../../tui/src/types.js";

const parent = createSessionId("parent");
const child = createSessionId("child");
const child2 = createSessionId("child2");
const event = (
  type: SessionEvent["type"],
  sessionId = child,
  payload: Record<string, unknown> = {},
  sequenceNumber = 1,
) => createSessionEvent(type, sessionId, payload, { sequenceNumber });
const stream = (delta: string, sequenceNumber: number, sessionId = child) =>
  event(
    SessionEventType.ModelStreaming,
    sessionId,
    { kind: "text_delta", assistantMessageId: "answer", delta },
    sequenceNumber,
  );
const directory: ZCodeSessionSubagentsResult = {
  revision: 1,
  childSessionIds: [child, child2],
  running: [child, child2].map((id, index) => ({
    childSessionId: id,
    title: index ? "Review tests" : "Inspect auth",
    status: "running",
    subagentType: "Explore",
  })),
  ended: { total: 0, items: [] },
};
const snapshot = (sessionId = child): TuiSubagentTranscriptSnapshot => ({
  sessionId,
  sequenceNumber: 2,
  messages: [],
  replayMessageIds: ["answer"],
  events: [
    event(SessionEventType.ModelStreaming, sessionId, {
      kind: "start",
      assistantMessageId: "answer",
    }),
    stream("Child answer", 2, sessionId),
  ],
});

test("main admission rejects raw child events and parent-ID tool mirrors before any state changes", () => {
  let mutations = 0;
  const handlers = new Proxy(
    { copy: getZCodeCopy("en-US").tui, getMainSessionId: () => parent },
    {
      get(target, property) {
        return property in target
          ? Reflect.get(target, property)
          : () => {
              mutations++;
            };
      },
    },
  );
  for (const type of [
    SessionEventType.ToolCallScheduled,
    SessionEventType.ToolCallStarted,
    SessionEventType.ToolCallProgress,
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
  ]) {
    const mirror = event(type, parent, {
      source: "subagent",
      childSessionId: child,
      toolCallId: "mirrored",
      toolName: "Bash",
    });
    assert.equal(isMainSessionEvent(mirror, parent), false);
    assert.equal(
      applyMainSessionEvent(
        mirror,
        new Set(),
        handlers as Parameters<typeof applyMainSessionEvent>[2],
      ),
      false,
    );
    assert.equal(isMainSessionEvent(event(type, child), parent), false);
  }
  assert.equal(mutations, 0);
  assert.equal(
    isMainSessionEvent(
      event(SessionEventType.ToolCallScheduled, parent, { toolName: "Agent" }),
      parent,
    ),
    true,
  );
  assert.equal(
    isMainSessionEvent(
      event(SessionEventType.SubagentSpawned, parent, { childSessionId: child }),
      parent,
    ),
    true,
  );
});

test("child history/live handoff deduplicates events and keeps other sessions isolated", () => {
  let state = hydrateSubagentTranscript(snapshot());
  state = applySubagentTranscriptEvent(state, stream("Child answer", 2));
  state = applySubagentTranscriptEvent(state, stream(" FOREIGN", 3, child2));
  state = applySubagentTranscriptEvent(state, stream(" live", 3));
  const text = state.messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  assert.equal(text, "Child answer live");
  assert.equal(state.sequenceNumber, 3);
});

async function fixture(overrides: Partial<TuiOptions> = {}) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    width: 145,
    height: 40,
    screenMode: "alternate-screen",
    useThread: false,
  });
  terminal.renderer.waitForThemeMode = async () => "dark";
  let sink: ((event: SessionEvent) => void) | undefined;
  let submitted = 0;
  let outcome!: Promise<number>;
  await React.act(async () => {
    outcome = runTuiWithRenderer(
      {
        noColor: true,
        locale: "en-US",
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        getMainSessionId: () => parent,
        initialResult: { response: "Main answer" },
        readSubagents: async () => directory,
        readSubagentTranscript: async (id) => snapshot(id as typeof child),
        subscribeSessionEvents: (callback) => {
          sink = callback;
          return () => {
            sink = undefined;
          };
        },
        submitPrompt: async () => {
          submitted++;
          return { response: "unexpected submission" };
        },
        ...overrides,
      },
      terminal.renderer,
    );
  });
  const action = async (work: () => unknown) => {
    await React.act(async () => {
      await work();
    });
    await React.act(async () => {
      await terminal.flush();
    });
    await React.act(async () => {
      await terminal.flush();
    });
  };
  await action(() => terminal.renderOnce());
  return {
    ...terminal,
    action,
    emit: (e: SessionEvent) => sink?.(e),
    async expectText(pattern: RegExp) {
      // Markdown parsing runs in OpenTUI's worker. Wait for the visible result,
      // rather than assuming it finishes within a fixed number of paint frames.
      for (let attempt = 0; attempt < 100; attempt++) {
        const frame = terminal.captureCharFrame();
        if (pattern.test(frame)) return frame;
        await action(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }
      const frame = terminal.captureCharFrame();
      assert.match(frame, pattern);
      return frame;
    },
    submitted: () => submitted,
    async click(id: string) {
      const target = terminal.renderer.root.findDescendantById(id);
      assert.ok(target, `Missing ${id}`);
      await action(() => terminal.mockMouse.click(target.x + 2, target.y));
    },
    async close() {
      await React.act(async () => {
        terminal.renderer.destroy();
      });
      await outcome;
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
}

test("native click opens read-only child output, streams independently and Escape restores the draft", async () => {
  const tui = await fixture();
  try {
    await tui.action(() => tui.mockInput.typeText("keep my draft"));
    await tui.action(() => {
      tui.emit(stream("leaked child text", 3));
      tui.emit(
        event(SessionEventType.ToolCallScheduled, parent, {
          source: "subagent",
          toolCallId: "mirror",
          toolName: "Bash",
          input: { command: "child-private-command" },
        }),
      );
    });
    assert.doesNotMatch(tui.captureCharFrame(), /leaked child|child-private-command/);
    await tui.click(`subagent-${child}`);
    await tui.expectText(/Child answer/);
    await tui.expectText(/Read-only/);
    assert.doesNotMatch(tui.captureCharFrame(), /keep my draft|Main answer/);
    await tui.action(() => {
      tui.emit(stream(" live update", 3));
      tui.emit(
        event(SessionEventType.AssistantMessage, parent, { content: "Main kept running" }, 5),
      );
    });
    await tui.expectText(/Child answer live update/);
    assert.doesNotMatch(tui.captureCharFrame(), /Main kept running/);
    await tui.action(() => tui.mockInput.typeText("should not edit"));
    await tui.action(() => tui.mockInput.pressEnter());
    assert.equal(tui.submitted(), 0);
    await tui.action(async () => {
      tui.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await tui.expectText(/keep my draft/);
    await tui.expectText(/Main kept running/);
    assert.doesNotMatch(tui.captureCharFrame(), /should not edit|Child answer/);
    await tui.click(`subagent-${child2}`);
    await tui.click("subagent-back");
    await tui.expectText(/keep my draft/);
  } finally {
    await tui.close();
  }
});

test("late child loads cannot replace a different selected child or reopen after Back", async () => {
  let resolve!: (value: TuiSubagentTranscriptSnapshot) => void;
  const slow = new Promise<TuiSubagentTranscriptSnapshot>((r) => {
    resolve = r;
  });
  const tui = await fixture({
    readSubagentTranscript: async (id) =>
      id === child
        ? slow
        : {
            ...snapshot(child2),
            messages: [{ role: "agent", content: "Second child" }],
            events: [],
            replayMessageIds: [],
          },
  });
  try {
    await tui.click(`subagent-${child}`);
    await tui.click(`subagent-${child2}`);
    await tui.action(() => resolve(snapshot()));
    await tui.expectText(/Second child/);
    assert.doesNotMatch(tui.captureCharFrame(), /Child answer/);
    await tui.action(async () => {
      tui.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await tui.expectText(/Main answer/);
  } finally {
    await tui.close();
  }
});

test("main scroll position survives child viewing while new main output arrives", async () => {
  const tui = await fixture({
    initialResult: {
      response: "",
      restoredMessages: Array.from({ length: 40 }, (_, i) => ({
        role: "user",
        content: `History entry ${i}`,
      })),
    },
  });
  try {
    const scroll = tui.renderer.root.findDescendantById("main-transcript") as ScrollBoxRenderable;
    await tui.action(() => scroll.scrollTo(12));
    const position = scroll.scrollTop;
    assert.ok(position > 0);
    await tui.click(`subagent-${child}`);
    await tui.action(() =>
      tui.emit(event(SessionEventType.AssistantMessage, parent, { content: "New main output" }, 8)),
    );
    await tui.click("subagent-back");
    assert.equal(scroll.scrollTop, position);
  } finally {
    await tui.close();
  }
});

test("events arriving during hydration are applied once above the snapshot watermark", async () => {
  let resolve!: (value: TuiSubagentTranscriptSnapshot) => void;
  const pending = new Promise<TuiSubagentTranscriptSnapshot>((r) => {
    resolve = r;
  });
  const tui = await fixture({ readSubagentTranscript: async () => pending });
  try {
    await tui.click(`subagent-${child}`);
    await tui.action(() => {
      tui.emit(stream("Child answer", 2));
      tui.emit(stream(" buffered", 3));
    });
    await tui.action(() => resolve(snapshot()));
    const frame = await tui.expectText(/Child answer buffered/);
    assert.match(frame, /Child answer buffered/);
    assert.equal(frame.split("Child answer").length - 1, 1);
  } finally {
    await tui.close();
  }
});

test("narrow sidebar overlay closes on selection and Back returns to the main view", async () => {
  const tui = await fixture();
  try {
    await tui.action(() => tui.resize(100, 30));
    assert.equal(tui.renderer.root.findDescendantById(`subagent-${child}`), undefined);
    await tui.action(() => tui.mockInput.pressKey("x", { ctrl: true }));
    await tui.action(() => tui.mockInput.pressKey("b"));
    await tui.click(`subagent-${child}`);
    await tui.expectText(/Child answer/);
    assert.equal(tui.renderer.root.findDescendantById(`subagent-${child}`), undefined);
    await tui.click("subagent-back");
    await tui.expectText(/Main answer/);
  } finally {
    await tui.close();
  }
});

test("switching main sessions clears selection and ignores the previous child's late snapshot", async () => {
  let current = parent;
  let resolve!: (value: TuiSubagentTranscriptSnapshot) => void;
  const pending = new Promise<TuiSubagentTranscriptSnapshot>((r) => {
    resolve = r;
  });
  const tui = await fixture({
    getMainSessionId: () => current,
    readSubagents: async () =>
      current === parent
        ? directory
        : { revision: 1, childSessionIds: [], running: [], ended: { total: 0, items: [] } },
    readSubagentTranscript: async () => pending,
  });
  try {
    await tui.click(`subagent-${child}`);
    await tui.action(() => {
      current = createSessionId("new-parent");
      tui.emit(event(SessionEventType.SessionCreated, current, { mode: "build" }));
    });
    await tui.action(() => resolve(snapshot()));
    assert.equal(tui.renderer.root.findDescendantById("subagent-view"), undefined);
    assert.doesNotMatch(tui.captureCharFrame(), /Inspect auth|Child answer/);
  } finally {
    await tui.close();
  }
});

test("child tools and final fallback output appear only in the child transcript", () => {
  let state = hydrateSubagentTranscript({
    sessionId: child,
    sequenceNumber: 0,
    messages: [],
    events: [],
    replayMessageIds: [],
  });
  state = applySubagentTranscriptEvent(
    state,
    event(
      SessionEventType.ToolCallScheduled,
      child,
      { toolCallId: "read", toolName: "Read", input: { file_path: "auth.ts" } },
      1,
    ),
  );
  state = applySubagentTranscriptEvent(
    state,
    event(
      SessionEventType.ToolCallResult,
      child,
      { toolCallId: "read", result: { content: "private child tool output" } },
      2,
    ),
  );
  state = applySubagentTranscriptEvent(
    state,
    event(SessionEventType.TurnComplete, child, { response: "Final child response" }, 3),
  );
  assert.equal(
    state.messages.flatMap((message) => message.parts ?? []).find((part) => part.type === "tool")
      ?.output,
    "private child tool output",
  );
  assert.equal(state.messages.at(-1)?.content, "Final child response");
});

test("cold multi-turn history does not replay old final replies", () => {
  const restored = hydrateSubagentTranscript({
    sessionId: child,
    sequenceNumber: 2,
    replayMessageIds: [],
    messages: [
      { id: "first", role: "agent", content: "First response" },
      { id: "second", role: "agent", content: "Second response" },
    ],
    events: [
      event(SessionEventType.TurnComplete, child, { response: "First response" }, 1),
      event(SessionEventType.TurnComplete, child, { response: "Second response" }, 2),
    ],
  });
  assert.deepEqual(
    restored.messages.map((message) => message.content),
    ["First response", "Second response"],
  );
});
