import { describe, expect, it } from "vitest";
import { createSessionId, createTraceId } from "@zcode/contracts";

import { stampMemoryOriginSessionId } from "../src/memory/origin-session.js";
import { editHandler } from "../src/tool/handlers/edit.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const MEMORY_ROOT = "/storage/memories/projects/project-0123456789abcdef/memory";

describe("Memory file metadata", () => {
  it("adds the fixed node type and creating session to standard Memory frontmatter", () => {
    const content = [
      "---",
      "name: feedback-agent-sdk-naming",
      'description: "Keep internal naming local"',
      "metadata:",
      "  type: feedback",
      "---",
      "",
      "Use local semantic names for internal code.",
    ].join("\n");

    expect(
      stampMemoryOriginSessionId({
        content,
        filePath: `${MEMORY_ROOT}/feedback-agent-sdk-naming.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe(
      [
        "---",
        "name: feedback-agent-sdk-naming",
        'description: "Keep internal naming local"',
        "metadata:",
        "  node_type: memory",
        "  type: feedback",
        "  originSessionId: sess_origin",
        "---",
        "",
        "Use local semantic names for internal code.",
      ].join("\n"),
    );
  });

  it("preserves the original file when the first origin session is already present", () => {
    const content = [
      "---",
      "name: existing-memory",
      "description: Existing memory",
      "metadata:",
      "  node_type: other",
      "  type: project",
      "  originSessionId: sess_original",
      "---",
      "",
      "Updated fact.",
    ].join("\n");

    expect(
      stampMemoryOriginSessionId({
        content,
        filePath: `${MEMORY_ROOT}/existing-memory.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_later",
      }),
    ).toBe(content);
  });

  it("adds a missing origin session through the Edit write boundary", async () => {
    const filePath = `${MEMORY_ROOT}/edited-memory.md`;
    const original = [
      "---",
      "name: edited-memory",
      "description: Existing memory without provenance",
      "metadata:",
      "  type: project",
      "---",
      "",
      "Old fact.",
    ].join("\n");
    const fileSystemPort = new MemoryFileSystem({ [filePath]: original });
    const sessionId = createSessionId("memory-edit-origin");
    const context: ToolExecutionContext = {
      abortSignal: new AbortController().signal,
      fileSystemPort,
      memoryRoot: MEMORY_ROOT,
      sessionId,
      toolCallId: "edit-memory-origin",
      traceId: createTraceId(),
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    await editHandler(
      { file_path: filePath, old_string: "Old fact.", new_string: "Updated fact." },
      context,
    );

    expect(fileSystemPort.files[filePath]).toBe(
      original
        .replace(
          "  type: project",
          `  node_type: memory\n  type: project\n  originSessionId: ${sessionId}`,
        )
        .replace("Old fact.", "Updated fact."),
    );
  });

  it("does not change files outside Memory or Markdown without frontmatter", () => {
    expect(
      stampMemoryOriginSessionId({
        content: "ordinary project note",
        filePath: "/workspace/note.md",
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe("ordinary project note");
    expect(
      stampMemoryOriginSessionId({
        content: "- [Fact](fact.md) — index entry",
        filePath: `${MEMORY_ROOT}/MEMORY.md`,
        memoryRoot: MEMORY_ROOT,
        sessionId: "sess_origin",
      }),
    ).toBe("- [Fact](fact.md) — index entry");
  });
});
