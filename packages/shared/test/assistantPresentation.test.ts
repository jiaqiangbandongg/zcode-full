import { describe, expect, it } from "vitest";
import {
  appendAssistantMessagePart,
  buildZCodeAssistantPresentation,
  type ZCodeAssistantMessagePart,
} from "../src/index.js";

describe("assistant presentation", () => {
  it("uses the final content block as latestPart", () => {
    const parts: ZCodeAssistantMessagePart[] = [
      { type: "content", content: "历史正文" },
      { type: "tool-call", toolId: "tool-1" },
      { type: "content", content: "最终正文" },
    ];

    const presentation = buildZCodeAssistantPresentation({
      content: "",
      parts,
      toolCalls: [
        {
          toolId: "tool-1",
          kind: "edit",
          title: "Edit file",
          input: {},
          status: "completed",
        },
      ],
    });

    expect(presentation.latestPart?.content).toBe("最终正文");
    expect(presentation.historyBlocks).toMatchObject([
      { type: "content", content: "历史正文" },
      { type: "tool-call", toolCall: { toolId: "tool-1" } },
    ]);
  });

  it("suppresses latestPart while streaming, interrupted, or settling", () => {
    for (const state of [
      { streaming: true },
      { interrupted: true },
      { settling: true },
    ]) {
      expect(
        buildZCodeAssistantPresentation({
          content: "正文",
          ...state,
        }).latestPart,
      ).toBeNull();
    }
  });

  it("merges continuous text chunks before presentation is built", () => {
    const parts = appendAssistantMessagePart(
      appendAssistantMessagePart(undefined, { type: "content", content: "A" }),
      { type: "content", content: "B" },
    );

    expect(buildZCodeAssistantPresentation({ content: "", parts }).blocks).toEqual([
      { type: "content", content: "AB" },
    ]);
  });

  it("keeps child tool calls inside the parent tree instead of rendering duplicate root blocks", () => {
    const presentation = buildZCodeAssistantPresentation({
      content: "",
      parts: [
        { type: "tool-call", toolId: "parent" },
        { type: "tool-call", toolId: "child" },
      ],
      toolCalls: [
        {
          toolId: "parent",
          kind: "task",
          title: "Task",
          input: {},
          status: "completed",
        },
        {
          toolId: "child",
          parentToolUseId: "parent",
          kind: "read",
          title: "Read",
          input: {},
          status: "completed",
        },
      ],
    });

    expect(presentation.blocks).toMatchObject([
      { type: "tool-call", toolCall: { toolId: "parent" } },
    ]);
  });
});
