import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  conversationDeltaSchema,
  filterConversationDeltasForProfile,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const preview = {
  text: "latest",
  fullText: "earlier\nlatest",
  totalBytes: 40960,
  totalLines: 500,
  linesEstimated: true,
};
function harness() {
  const projection = new ProductProjection("bash-progress", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown, source?: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "bash-progress",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
      ...(source ? { source } : {}),
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "run", messageId: "user-1" });
  apply(SessionEventType.ToolCallScheduled, {
    toolCallId: "bash-1",
    toolName: "Bash",
    input: { command: "build" },
    schedule: { parallelGroups: [["bash-1"]], executionOrder: ["bash-1"] },
  });
  apply(SessionEventType.ToolCallStarted, { toolCallId: "bash-1", toolName: "Bash" });
  const row = () =>
    projection.getSnapshot().rows.window.find((r) => r.kind === "toolCall") as ToolCallRow;
  const progress = () =>
    apply(SessionEventType.ToolCallProgress, {
      toolCallId: "bash-1",
      toolName: "Bash",
      outputPreview: preview,
    });
  return { projection, apply, row, progress };
}
describe("Bash progress product projection", () => {
  it("publishes a bounded preview in whole rows for both delivery profiles", () => {
    const h = harness();
    const deltas = h.progress();
    expect(h.row().outputPreview).toEqual(preview);
    expect(
      deltas.some((delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall"),
    ).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      expect(filterConversationDeltasForProfile(deltas, profile)).toEqual(deltas);
    }
    expect(h.row().progress).toBeUndefined();
  });
  it.each([
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
    SessionEventType.TurnComplete,
  ])("clears preview on %s and rejects late progress", (type) => {
    const h = harness();
    h.progress();
    h.apply(
      type,
      type === SessionEventType.ToolCallResult
        ? { toolCallId: "bash-1", result: { success: true, content: "done" }, duration: 1 }
        : {
            toolCallId: "bash-1",
            error: { type: "tool_cancelled", message: "stopped" },
            reason: "user",
            resultType: "cancelled",
          },
    );
    expect(h.row().outputPreview).toBeUndefined();
    expect(h.progress()).toEqual([]);
    expect(h.row().outputPreview).toBeUndefined();
  });
  it("clears the launch preview while the committed background work stays running", () => {
    const h = harness();
    h.progress();
    h.apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "background-1",
      toolCallId: "bash-1",
      taskKind: "bash",
      toolName: "Bash",
      status: "running",
      cancellable: true,
    });
    h.apply(SessionEventType.ToolCallResult, {
      toolCallId: "bash-1",
      result: { success: true, content: "Command running in background. Output file: /output.log" },
      duration: 1,
    });
    expect(h.row().outputPreview).toBeUndefined();
    expect(h.progress()).toEqual([]);
    expect(h.projection.getSnapshot().backgroundWorks).toContainEqual(
      expect.objectContaining({ workId: "background-1", status: "running" }),
    );
  });
  it("ignores child tool mirrors in the parent while child topics use normal progress", () => {
    const parent = harness();
    expect(
      parent.apply(SessionEventType.ToolCallProgress, {
        toolCallId: "bash-1",
        source: "subagent",
        outputPreview: preview,
      }),
    ).toEqual([]);
    expect(parent.row().outputPreview).toBeUndefined();
    const child = harness();
    child.progress();
    expect(child.row().outputPreview).toEqual(preview);
  });
  it("does not create a row for unknown or invalid previews", () => {
    const h = harness();
    expect(
      h.apply(SessionEventType.ToolCallProgress, { toolCallId: "missing", outputPreview: preview }),
    ).toEqual([]);
    expect(
      h.apply(SessionEventType.ToolCallProgress, {
        toolCallId: "bash-1",
        outputPreview: { ...preview, fullText: "x".repeat(4097) },
      }),
    ).toEqual([]);
    expect(h.row().outputPreview).toBeUndefined();
  });
});

describe("Bash result display projection", () => {
  it("preserves structured output in both profiles and the final snapshot", () => {
    const h = harness();
    const display = {
      kind: "bash_output",
      output: "head",
      truncated: true,
      outputPath: "/tmp/full.output",
    };
    const deltas = h.apply(SessionEventType.ToolCallResult, {
      toolCallId: "bash-1",
      result: { success: true, content: "model preview", display },
      duration: 1,
    });
    expect(h.row().output?.display).toEqual(display);
    for (const profile of Object.values(DELIVERY_PROFILES)) {
      const filtered = filterConversationDeltasForProfile(deltas, profile);
      for (const delta of filtered) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    }
  });
});
