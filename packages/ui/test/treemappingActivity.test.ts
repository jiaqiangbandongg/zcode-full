import { describe, expect, it } from "vitest";
import { buildTreemappingActivityModel } from "../src/lib/treemappingActivity.js";
import type { TaskChatMessage, TaskChatToolCall } from "../src/lib/taskChatMessageTypes.js";

function message(toolCalls: TaskChatToolCall[]): TaskChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 1,
    toolCalls,
  };
}

function toolCall(overrides: Partial<TaskChatToolCall>): TaskChatToolCall {
  return {
    toolId: overrides.toolId ?? "tool-1",
    kind: overrides.kind ?? "read",
    title: overrides.title,
    input: overrides.input ?? {},
    output: overrides.output,
    raw: overrides.raw,
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? 10,
  };
}

describe("buildTreemappingActivityModel", () => {
  it("derives read, search, edit, write and delete file activity", () => {
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "read-1",
          kind: "read",
          input: { file_path: "/workspace/src/app.ts" },
        }),
        toolCall({
          toolId: "search-1",
          kind: "search",
          output: { files: ["src/app.ts", "src/util.ts"] },
        }),
        toolCall({
          toolId: "edit-1",
          kind: "edit",
          raw: {
            changes: {
              "src/app.ts": {
                type: "update",
                oldText: "one\n",
                newText: "one\ntwo\n",
              },
            },
          },
        }),
        toolCall({
          toolId: "write-1",
          kind: "write",
          input: { file_path: "src/new.ts", content: "hello\nworld\n" },
        }),
        toolCall({
          toolId: "delete-1",
          kind: "delete",
          input: { file_path: "src/old.ts", content: "bye\n" },
        }),
      ]),
      "/workspace",
    );

    const app = model.files.find((file) => file.path === "src/app.ts");
    const util = model.files.find((file) => file.path === "src/util.ts");
    const written = model.files.find((file) => file.path === "src/new.ts");
    const deleted = model.files.find((file) => file.path === "src/old.ts");

    expect(app).toMatchObject({ kind: "modified", views: 2, added: 1, removed: 0 });
    expect(util).toMatchObject({ kind: "viewed", views: 1 });
    expect(written).toMatchObject({ kind: "written", added: 2 });
    expect(deleted).toMatchObject({ kind: "deleted", removed: 1 });
  });

  it("keeps write priority when a file is written then modified", () => {
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "write-1",
          kind: "write",
          input: { file_path: "src/new.ts", content: "hello\n" },
        }),
        toolCall({
          toolId: "edit-1",
          kind: "edit",
          raw: {
            changes: {
              "src/new.ts": {
                type: "update",
                oldText: "hello\n",
                newText: "hello\nworld\n",
              },
            },
          },
        }),
      ]),
      "/workspace",
    );

    expect(model.files[0]).toMatchObject({
      path: "src/new.ts",
      kind: "written",
      added: 2,
      removed: 0,
    });
  });

  it("keeps delete priority over write, edit and view for the same file", () => {
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "read-1",
          kind: "read",
          input: { file_path: "src/new.ts" },
        }),
        toolCall({
          toolId: "write-1",
          kind: "write",
          input: { file_path: "src/new.ts", content: "hello\n" },
        }),
        toolCall({
          toolId: "edit-1",
          kind: "edit",
          raw: {
            changes: {
              "src/new.ts": {
                type: "update",
                oldText: "hello\n",
                newText: "hello\nworld\n",
              },
            },
          },
        }),
        toolCall({
          toolId: "delete-1",
          kind: "delete",
          input: { file_path: "src/new.ts", content: "hello\nworld\n" },
        }),
      ]),
      "/workspace",
    );

    expect(model.files[0]).toMatchObject({
      path: "src/new.ts",
      kind: "deleted",
      views: 1,
      added: 2,
      removed: 1,
    });
  });

  it("tracks directory views from ls and search scopes", () => {
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "ls-1",
          kind: "list",
          input: { path: "src/components" },
        }),
        toolCall({
          toolId: "grep-1",
          kind: "grep",
          input: { directory: "src" },
        }),
      ]),
      "/workspace",
    );

    expect(model.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/components", views: 1 }),
        expect.objectContaining({ path: "src", views: 1 }),
      ]),
    );
  });

  it("only consumes structured changes for shell calls", () => {
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "shell-1",
          kind: "execute",
          input: { command: "cat src/ignored.ts && rm src/also-ignored.ts" },
          output: "deleted src/also-ignored.ts\nread src/ignored.ts",
        }),
        toolCall({
          toolId: "shell-2",
          kind: "execute",
          raw: {
            rawOutput: {
              changes: {
                "src/changed.ts": { type: "update", added: 3, removed: 1 },
              },
            },
          },
        }),
      ]),
      "/workspace",
    );

    expect(model.files.map((file) => file.path)).toEqual(["src/changed.ts"]);
    expect(model.files[0]).toMatchObject({ kind: "modified", added: 3, removed: 1 });
  });

  it("uses ZCode file_diff display stats without treating title=Write as written", () => {
    const filePath = "/workspace/src/app/components/TodoList.tsx";
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "zcode-edit-1",
          kind: "edit",
          title: "Write",
          input: { file_path: filePath, content: "large content" },
          output: {
            success: true,
            display: {
              kind: "file_diff",
              filePath,
              additions: 541,
              deletions: 110,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 44,
                  newStart: 1,
                  newLines: 502,
                  lines: [
                    ' "use client";',
                    "-import { useState } from \"react\";",
                    "+import { useState, useEffect } from \"react\";",
                  ],
                },
              ],
            },
          },
          raw: {
            rawOutput: {
              success: true,
              display: {
                kind: "file_diff",
                filePath,
                additions: 541,
                deletions: 110,
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 44,
                    newStart: 1,
                    newLines: 502,
                    lines: [
                      ' "use client";',
                      "-import { useState } from \"react\";",
                      "+import { useState, useEffect } from \"react\";",
                    ],
                  },
                ],
              },
            },
          },
        }),
      ]),
      "/workspace",
    );

    expect(model.files).toHaveLength(1);
    expect(model.files[0]).toMatchObject({
      path: "src/app/components/TodoList.tsx",
      kind: "modified",
      added: 541,
      removed: 110,
    });
  });

  it("uses rawOutput content type as the ZCode write/edit/delete source of truth", () => {
    const createPath = "/workspace/src/created.ts";
    const updatePath = "/workspace/src/updated.ts";
    const deletePath = "/workspace/src/deleted.ts";
    const model = buildTreemappingActivityModel(
      message([
        toolCall({
          toolId: "zcode-create-1",
          kind: "edit",
          title: "Write",
          input: { file_path: createPath, content: "one\ntwo\n" },
          raw: {
            rawOutput: {
              content: JSON.stringify({
                type: "create",
                filePath: createPath,
                content: "one\ntwo\n",
              }),
              display: {
                kind: "file_diff",
                filePath: createPath,
                additions: 2,
                deletions: 0,
              },
            },
          },
        }),
        toolCall({
          toolId: "zcode-update-1",
          kind: "edit",
          title: "Write",
          input: { file_path: updatePath, content: "changed\n" },
          raw: {
            rawOutput: {
              content: JSON.stringify({
                type: "update",
                filePath: updatePath,
                content: "changed\n",
              }),
              display: {
                kind: "file_diff",
                filePath: updatePath,
                additions: 3,
                deletions: 1,
              },
            },
          },
        }),
        toolCall({
          toolId: "zcode-delete-1",
          kind: "edit",
          title: "Write",
          input: { file_path: deletePath },
          raw: {
            rawOutput: {
              content: JSON.stringify({
                type: "remove",
                filePath: deletePath,
              }),
              display: {
                kind: "file_diff",
                filePath: deletePath,
                additions: 0,
                deletions: 4,
              },
            },
          },
        }),
      ]),
      "/workspace",
    );

    expect(model.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/created.ts",
          kind: "written",
          added: 2,
          removed: 0,
        }),
        expect.objectContaining({
          path: "src/updated.ts",
          kind: "modified",
          added: 3,
          removed: 1,
        }),
        expect.objectContaining({
          path: "src/deleted.ts",
          kind: "deleted",
          added: 0,
          removed: 4,
        }),
      ]),
    );
  });
});
