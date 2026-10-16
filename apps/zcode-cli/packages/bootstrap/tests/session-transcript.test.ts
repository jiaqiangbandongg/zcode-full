import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "@zcode/contracts";
import { projectSessionTranscript } from "../src/session-transcript.js";

describe("session transcript projection", () => {
  it("filters model-only goal continuation user inputs", () => {
    const transcript = projectSessionTranscript([
      {
        info: { role: "user" },
        parts: [
          {
            id: "part-user",
            text: "加一个地址系统，可以加，可以选",
            type: "text",
          },
        ],
      },
      {
        info: {
          role: "user",
          source: "goal-continuation",
          synthetic: true,
          visibility: "model-only",
        },
        parts: [
          {
            id: "part-goal",
            metadata: {
              source: "goal-continuation",
              visibility: "model-only",
            },
            synthetic: true,
            text: [
              '<system-reminder source="goal-continuation">',
              "Continue working toward the active session goal.",
              "</system-reminder>",
            ].join("\n"),
            type: "text",
          },
        ],
      },
      {
        info: { role: "assistant" },
        parts: [
          {
            id: "part-assistant",
            text: "继续完成并验证了地址系统。",
            type: "text",
          },
        ],
      },
    ] as unknown as MessageWithParts[]);

    expect(transcript).toEqual([
      {
        content: "加一个地址系统，可以加，可以选",
        role: "user",
      },
      {
        content: "继续完成并验证了地址系统。",
        role: "agent",
      },
    ]);
  });

  it("preserves assistant thought and tool parts for resume rendering", () => {
    const transcript = projectSessionTranscript([
      {
        info: { role: "user" },
        parts: [
          {
            id: "part-user",
            text: "read the file",
            type: "text",
          },
        ],
      },
      {
        info: { role: "assistant" },
        parts: [
          {
            id: "part-thought",
            text: "I should inspect package.json first.",
            type: "reasoning",
          },
          {
            id: "part-text",
            text: "I'll inspect it.",
            type: "text",
          },
          {
            callID: "call-read",
            id: "part-tool",
            state: {
              input: { file_path: "/workspace/project/package.json" },
              output: '{"name":"demo"}',
              status: "completed",
              title: "Read",
            },
            tool: "Read",
            type: "tool",
          },
        ],
      },
    ] as unknown as MessageWithParts[]);

    expect(transcript).toEqual([
      {
        content: "read the file",
        role: "user",
      },
      {
        content: "I'll inspect it.",
        parts: [
          {
            text: "I should inspect package.json first.",
            type: "thought",
          },
          {
            text: "I'll inspect it.",
            type: "text",
          },
          {
            input: { file_path: "/workspace/project/package.json" },
            output: '{"name":"demo"}',
            status: "completed",
            title: "Read",
            toolCallId: "call-read",
            toolName: "Read",
            type: "tool",
          },
        ],
        role: "agent",
      },
    ]);
  });

  it("restores persisted file diff display metadata for completed tools", () => {
    const display = {
      additions: 1,
      deletions: 1,
      filePath: "/workspace/project/src/app.ts",
      kind: "file_diff" as const,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
      truncated: false,
    };
    const transcript = projectSessionTranscript([
      {
        info: { role: "assistant" },
        parts: [
          {
            callID: "call-edit",
            id: "part-tool",
            state: {
              input: {
                file_path: "/workspace/project/src/app.ts",
                old_string: "old",
                new_string: "new",
              },
              metadata: {
                schemaVersion: 1,
                display,
                serialization: {
                  budgetStrategy: "inline",
                  originalBytes: 42,
                  returnedBytes: 42,
                  truncated: false,
                },
              },
              output: "The file has been updated successfully.",
              status: "completed",
              title: "Edit",
              time: { start: 1, end: 2 },
            },
            tool: "Edit",
            type: "tool",
          },
        ],
      },
    ] as unknown as MessageWithParts[]);

    expect(transcript[0]?.parts?.[0]).toMatchObject({
      input: {
        file_path: "/workspace/project/src/app.ts",
        old_string: "old",
        new_string: "new",
      },
      output: "The file has been updated successfully.",
      resultDisplay: display,
      status: "completed",
      toolCallId: "call-edit",
      toolName: "Edit",
      type: "tool",
    });
  });

  it.each([
    {
      toolName: "TaskOutput",
      input: { task_id: "task-1", block: false, timeout: 0 },
      display: {
        kind: "task_output",
        retrievalStatus: "not_ready",
        taskStatus: "running",
        output: "partial output",
      } as const,
    },
    {
      toolName: "RespondToCoordinator",
      input: { summary: "Reply", message: "Continue working." },
      display: {
        kind: "respond_to_coordinator",
        status: "success",
      } as const,
    },
  ])("restores persisted $toolName display metadata", ({ toolName, input, display }) => {
    const transcript = projectSessionTranscript([
      {
        info: { role: "assistant" },
        parts: [
          {
            callID: `call-${toolName}`,
            id: `part-${toolName}`,
            state: {
              input,
              metadata: {
                schemaVersion: 1,
                display,
              },
              output: "provider-visible content",
              status: "completed",
              title: toolName,
              time: { start: 1, end: 2 },
            },
            tool: toolName,
            type: "tool",
          },
        ],
      },
    ] as unknown as MessageWithParts[]);

    expect(transcript[0]?.parts?.[0]).toMatchObject({
      input,
      output: "provider-visible content",
      resultDisplay: display,
      status: "completed",
      toolName,
      type: "tool",
    });
  });
});
