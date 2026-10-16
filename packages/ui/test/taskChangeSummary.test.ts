import { describe, expect, it } from "vitest";
import {
  buildTaskChangeSummary,
  buildTaskChangeSummaryFromToolCalls,
} from "@/lib/taskChangeSummary.js";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";

describe("buildTaskChangeSummary", () => {
  it("按当前 task 会话 fileChanges 聚合同一文件的多轮改动", () => {
    const summary = buildTaskChangeSummary([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\n",
            afterContent: "line1\nline2\nline3\n",
            writeCount: 1,
          },
        ],
      },
      {
        turnIndex: 1,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "line1\nline2\nline3\n",
            afterContent: "line0\nline1\nline2\nline3\n",
            writeCount: 2,
          },
          {
            path: "/repo/src/b.ts",
            beforeContent: null,
            afterContent: "new file\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    expect(summary).toEqual({
      fileCount: 2,
      added: 3,
      removed: 0,
      files: [
        {
          path: "/repo/src/a.ts",
          added: 2,
          removed: 0,
          writeCount: 3,
          lastTurnIndex: 1,
        },
        {
          path: "/repo/src/b.ts",
          added: 1,
          removed: 0,
          writeCount: 1,
          lastTurnIndex: 1,
        },
      ],
    });
  });

  it("文件最终回到原内容时仍保留触达记录", () => {
    const summary = buildTaskChangeSummary([
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "same\n",
            afterContent: "changed\n",
            writeCount: 1,
          },
        ],
      },
      {
        turnIndex: 1,
        snapshots: [
          {
            path: "/repo/src/a.ts",
            beforeContent: "changed\n",
            afterContent: "same\n",
            writeCount: 1,
          },
        ],
      },
    ]);

    expect(summary).toEqual({
      fileCount: 1,
      added: 0,
      removed: 0,
      files: [
        {
          path: "/repo/src/a.ts",
          added: 0,
          removed: 0,
          writeCount: 2,
          lastTurnIndex: 1,
        },
      ],
    });
  });

  it("没有会话文件变更时返回 null", () => {
    expect(buildTaskChangeSummary([])).toBeNull();
    expect(buildTaskChangeSummary(undefined)).toBeNull();
  });

  it("按当前 task 消息里的 tool call changes 聚合 Recent changes", () => {
    const messages: TaskChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "edit files",
        timestamp: 1,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: 2,
        turnIndex: 0,
        toolCalls: [
          {
            toolId: "tool-1",
            toolName: "edit",
            kind: "edit",
            title: "Edit src/a.ts",
            input: { path: "src/a.ts" },
            status: "completed",
            raw: {
              display: {
                kind: "file_diffs",
                files: [
                  {
                    filePath: "/repo/src/a.ts",
                    additions: 2,
                    deletions: 1,
                  },
                  {
                    filePath: "/repo/src/b.ts",
                    additions: 3,
                    deletions: 0,
                  },
                ],
              },
            },
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "",
        timestamp: 3,
        turnIndex: 2,
        toolCalls: [
          {
            toolId: "tool-2",
            toolName: "edit",
            kind: "edit",
            title: "Edit src/a.ts",
            input: { path: "src/a.ts" },
            status: "completed",
            raw: {
              display: {
                kind: "file_diff",
                filePath: "/repo/src/a.ts",
                additions: 1,
                deletions: 2,
              },
            },
          },
        ],
      },
    ];

    const summary = buildTaskChangeSummaryFromToolCalls(messages);

    expect(summary).toEqual({
      fileCount: 2,
      added: 6,
      removed: 3,
      files: [
        {
          path: "/repo/src/a.ts",
          added: 3,
          removed: 3,
          writeCount: 2,
          lastTurnIndex: 2,
        },
        {
          path: "/repo/src/b.ts",
          added: 3,
          removed: 0,
          writeCount: 1,
          lastTurnIndex: 0,
        },
      ],
    });
  });

  it("Recent changes 不把非写类 tool call 当作文件变更", () => {
    const summary = buildTaskChangeSummaryFromToolCalls([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        turnIndex: 0,
        toolCalls: [
          {
            toolId: "tool-1",
            toolName: "read",
            kind: "explore",
            title: "Read src/a.ts",
            input: { path: "/repo/src/a.ts" },
            status: "completed",
            raw: {
              display: {
                kind: "file_diff",
                filePath: "/repo/src/a.ts",
                additions: 9,
                deletions: 1,
              },
            },
          },
        ],
      },
    ]);

    expect(summary).toBeNull();
  });

  it("Recent changes 不把失败或拒绝的写工具输入当作文件变更", () => {
    const summary = buildTaskChangeSummaryFromToolCalls([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        turnIndex: 0,
        toolCalls: [
          {
            toolId: "tool-1",
            toolName: "Write",
            kind: "write",
            title: "Write denied.ts",
            input: {
              file_path: "/repo/denied.ts",
              content: "must not be counted\n",
            },
            status: "failed",
            raw: { status: "failed" },
          },
          {
            toolId: "tool-2",
            toolName: "Write",
            kind: "write",
            title: "Write rejected.ts",
            input: {
              file_path: "/repo/rejected.ts",
              content: "must not be counted either\n",
            },
            status: "denied",
            raw: { status: "denied" },
          },
        ],
      },
    ]);

    expect(summary).toBeNull();
  });
});
