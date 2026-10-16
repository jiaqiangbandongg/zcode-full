import { describe, expect, it } from "vitest";

import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  MicrocompactStrategy,
  MicrocompactTrigger,
  annotateBoundaryWithPreservedSegment,
  buildPostCompactItems,
  compactBoundaryPayloadSchema,
  compactTimelinePayloadSchema,
  getItemsAfterLastCompactBoundary,
  isCompactBoundaryItem,
  microcompactBoundaryPayloadSchema,
  parseCompactBoundaryPayload,
  parseMicrocompactBoundaryPayload,
  type CompactBoundaryPayload,
  type CompactContextItem,
  type MicrocompactBoundaryPayload,
} from "../src/compact/index.js";
import type { MessageId, ToolCallId, TraceId, TurnId } from "../src/interfaces/shared.js";

describe("compact contracts", () => {
  const boundaryPayload: CompactBoundaryPayload = {
    boundaryId: "compact_1",
    trigger: CompactTrigger.Manual,
    phase: CompactPhase.StandaloneTurn,
    compactReason: CompactReason.UserRequested,
    summarySource: "model",
    preCompactTokenCount: 120000,
    postCompactTokenCount: 18000,
    truePostCompactTokenCount: 22000,
    summarizedMessageCount: 8,
    keptMessageCount: 2,
    summaryMessageIds: ["msg_summary" as MessageId],
    traceId: "trace_1" as TraceId,
  };

  it("validates compact boundary payloads at runtime", () => {
    expect(parseCompactBoundaryPayload(boundaryPayload)).toMatchObject({
      boundaryId: "compact_1",
      compactReason: "user_requested",
      phase: "standalone_turn",
      trigger: "manual",
      summaryMessageIds: ["msg_summary"],
    });

    expect(() =>
      compactBoundaryPayloadSchema.parse({
        ...boundaryPayload,
        trigger: "unsupported",
      }),
    ).toThrow();
  });

  it("validates compact timeline payloads at runtime", () => {
    const payload = compactTimelinePayloadSchema.parse({
      operationId: "cmp_1",
      messageId: "msg_compact",
      status: CompactTimelineStatus.Started,
      trigger: CompactTrigger.Auto,
      phase: CompactPhase.PreRequest,
      compactReason: CompactReason.ContextLimit,
      text: "正在自动压缩上下文",
    });

    expect(payload).toMatchObject({
      compactReason: "context_limit",
      display: "separator",
      operationId: "cmp_1",
      phase: "pre_request",
      status: "started",
    });
    expect(payload).not.toHaveProperty("text");

    expect(
      compactTimelinePayloadSchema.parse({
        operationId: "cmp_skipped",
        messageId: "msg_compact_skipped",
        status: CompactTimelineStatus.Skipped,
        trigger: CompactTrigger.Manual,
      }),
    ).toMatchObject({
      display: "separator",
      operationId: "cmp_skipped",
      status: "skipped",
      trigger: "manual",
    });
  });

  it("validates microcompact boundary payloads at runtime", () => {
    const payload: MicrocompactBoundaryPayload = {
      clearedMessageCount: 2,
      clearedToolCallIds: ["tool_old_1", "tool_old_2"] as ToolCallId[],
      keptToolCallIds: ["tool_latest"] as ToolCallId[],
      postMicrocompactTokenCount: 4000,
      preMicrocompactTokenCount: 8000,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved: 4000,
      traceId: "trace_1" as TraceId,
      trigger: MicrocompactTrigger.TokenPressure,
      turnId: "turn_1" as TurnId,
    };

    expect(parseMicrocompactBoundaryPayload(payload)).toMatchObject({
      clearedMessageCount: 2,
      strategy: "local_tool_result_clear",
      tokensSaved: 4000,
      trigger: "token_pressure",
    });
    expect(() =>
      microcompactBoundaryPayloadSchema.parse({
        ...payload,
        strategy: "provider_cache_edit",
      }),
    ).toThrow();
  });

  it("accepts legacy compact payloads without phase metadata", () => {
    const { compactReason: _compactReason, phase: _phase, ...legacyPayload } = boundaryPayload;

    expect(compactBoundaryPayloadSchema.parse(legacyPayload)).toMatchObject({
      boundaryId: "compact_1",
      trigger: "manual",
    });
  });

  it("builds post-compact context in the fixed restore order", () => {
    const boundary = item("boundary", { compactBoundary: boundaryPayload });
    const summary = item("summary", { isCompactSummary: true });
    const kept = item("kept");
    const attachment = item("attachment");
    const hook = item("hook");

    expect(
      buildPostCompactItems({
        boundaryMarker: boundary,
        summaryMessages: [summary],
        messagesToKeep: [kept],
        attachments: [attachment],
        hookResults: [hook],
      }).map((message) => message.id),
    ).toEqual(["boundary", "summary", "kept", "attachment", "hook"]);
  });

  it("returns items from the last compact boundary, inclusive", () => {
    const firstBoundary = item("boundary-1", { compactBoundary: boundaryPayload });
    const secondBoundary = item("boundary-2", {
      compactBoundary: { ...boundaryPayload, boundaryId: "compact_2" },
    });
    const items = [
      item("old"),
      firstBoundary,
      item("summary-1"),
      secondBoundary,
      item("summary-2"),
    ];

    expect(getItemsAfterLastCompactBoundary(items).map((message) => message.id)).toEqual([
      "boundary-2",
      "summary-2",
    ]);
  });

  it("leaves the full chain intact when no compact boundary exists", () => {
    const items = [item("one"), item("two")];

    expect(getItemsAfterLastCompactBoundary(items)).toEqual(items);
  });

  it("annotates preserved segment metadata without mutating the original boundary", () => {
    const boundary = item("boundary", { compactBoundary: boundaryPayload });
    const annotated = annotateBoundaryWithPreservedSegment(boundary, {
      headMessageId: "msg_keep_head" as MessageId,
      anchorMessageId: "msg_summary" as MessageId,
      tailMessageId: "msg_keep_tail" as MessageId,
    });

    expect(annotated.compactBoundary?.preservedSegment).toEqual({
      headMessageId: "msg_keep_head",
      anchorMessageId: "msg_summary",
      tailMessageId: "msg_keep_tail",
    });
    expect(boundary.compactBoundary?.preservedSegment).toBeUndefined();
  });

  it("recognizes only schema-valid compact boundary items", () => {
    expect(isCompactBoundaryItem(item("boundary", { compactBoundary: boundaryPayload }))).toBe(
      true,
    );
    expect(
      isCompactBoundaryItem(item("broken", { compactBoundary: {} as CompactBoundaryPayload })),
    ).toBe(false);
  });
});

function item(id: string, extra?: Partial<CompactContextItem>): CompactContextItem {
  return {
    id,
    ...extra,
  };
}
