import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type ToolPart,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

const workspaceRoot = "/tmp/zcode-read-state-hydrator";

describe("read file state hydrator", () => {
  it("restores full Read state from structured completed metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-full");
    const file = join(workspaceRoot, "src", "index.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read", 10, [
          completedToolPart(sessionID, "assistant-full-read", "tool-read", "Read", {
            input: { file_path: "src/index.ts" },
            output: "1\texport const answer = 42;\n2\t",
            metadata: readStateMetadata(file, "export const answer = 42;\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStateKey(file, 1, undefined))).toMatchObject({
      content: "export const answer = 42;\n",
      isPartialView: false,
      limit: undefined,
      mtimeMs: 1,
      offset: undefined,
      path: file,
      revisionId: `rev:${file}:${Buffer.byteLength("export const answer = 42;\n", "utf8")}:1`,
    });
  });

  it.each([0, 1])(
    "restores explicit offset %i Read without limit as a full Read",
    async (offset) => {
      const sessionID = createSessionId(`hydrate-read-state-full-offset-${offset}`);
      const file = join(workspaceRoot, "src", `offset-${offset}.ts`);
      const readFileState: ReadFileStateMap = new Map();

      const result = await hydrateReadFileStateFromSession({
        messages: [
          assistantToolMessage(sessionID, `assistant-full-offset-${offset}`, 10, [
            completedToolPart(sessionID, `assistant-full-offset-${offset}`, "tool-read", "Read", {
              input: { file_path: file, offset },
              output: "1\talpha\n2\tbeta\n",
              metadata: readStateMetadata(file, "alpha\nbeta\n", { offset }),
            }),
          ]),
        ],
        readFileState,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      });

      expect(result.restoredCount).toBe(1);
      expect(result.skippedRangeReadCount).toBe(0);
      expect(readFileState.get(createReadFileStateKey(file, 1, undefined))).toMatchObject({
        content: "alpha\nbeta\n",
        isPartialView: false,
        limit: undefined,
        offset: undefined,
        path: file,
      });
    },
  );

  it("skips string-only Read output when completed metadata is missing", async () => {
    const sessionID = createSessionId("hydrate-read-state-legacy-output");
    const file = join(workspaceRoot, "src", "legacy.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-legacy-read", 10, [
          completedToolPart(sessionID, "assistant-legacy-read", "tool-read-legacy", "Read", {
            input: { file_path: file },
            output:
              "1\talpha\n2\tbeta\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware.\n</system-reminder>\n",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips empty Read warning output when completed metadata is missing", async () => {
    const sessionID = createSessionId("hydrate-read-state-empty-output");
    const file = join(workspaceRoot, "src", "empty.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-empty-read", 10, [
          completedToolPart(sessionID, "assistant-empty-read", "tool-read-empty", "Read", {
            input: { file_path: file },
            output:
              "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips Read metadata without complete freshness fields", async () => {
    const sessionID = createSessionId("hydrate-read-state-incomplete-metadata");
    const file = join(workspaceRoot, "src", "incomplete.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-incomplete-read", 10, [
          completedToolPart(sessionID, "assistant-incomplete-read", "tool-read-incomplete", "Read", {
            input: { file_path: file },
            output: "1\tincomplete\n2\t",
            metadata: {
              readFileState: {
                content: "incomplete\n",
                isPartialView: false,
                path: file,
                readAtMs: 2,
                schemaVersion: 1,
                sizeBytes: Buffer.byteLength("incomplete\n", "utf8"),
                tool: "Read",
              },
              schemaVersion: 1,
            },
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips historical range Reads during resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-range");
    const file = join(workspaceRoot, "src", "range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-range-read", 10, [
          completedToolPart(sessionID, "assistant-range-read", "tool-read-range", "Read", {
            input: { file_path: file, offset: 2, limit: 1 },
            output: "2\tline two",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(result.skippedRangeReadCount).toBe(1);
    expect(readFileState.size).toBe(0);
  });

  it("keeps earlier full Read state when a later range Read is skipped during resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-range");
    const file = join(workspaceRoot, "src", "full-then-range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-range", 10, [
          completedToolPart(sessionID, "assistant-full-read-before-range", "tool-read-full", "Read", {
            input: { file_path: file },
            output: "1\tline one\n2\tline two\n3\t",
            metadata: readStateMetadata(file, "line one\nline two\n"),
          }),
        ]),
        assistantToolMessage(sessionID, "assistant-range-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-range-read-after-full",
            "tool-read-range-after-full",
            "Read",
            {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(result.skippedRangeReadCount).toBe(1);
    expect(readFileState.get(createReadFileStateKey(file, 1, undefined))).toMatchObject({
      content: "line one\nline two\n",
      isPartialView: false,
      limit: undefined,
      offset: undefined,
      path: file,
    });
  });

  it("restores a later token-truncated full Read as partial state over an earlier full Read", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-partial");
    const file = join(workspaceRoot, "src", "full-then-partial.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-partial", 10, [
          completedToolPart(
            sessionID,
            "assistant-full-read-before-partial",
            "tool-read-full-before-partial",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n"),
            },
          ),
        ]),
        assistantToolMessage(sessionID, "assistant-partial-full-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-partial-full-read-after-full",
            "tool-read-partial-after-full",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n<system-reminder>partial view</system-reminder>",
              metadata: readStateMetadata(file, "line one\n", { isPartialView: true }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStateKey(file, 1, undefined))).toMatchObject({
      content: "line one\n",
      isPartialView: true,
      limit: undefined,
      offset: undefined,
      path: file,
    });
  });

  it("restores Write state from structured metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-completed-time");
    const file = join(workspaceRoot, "src", "write-completed-time.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-completed-time", 10, [
          completedToolPart(
            sessionID,
            "assistant-write-completed-time",
            "tool-write-completed-time",
            "Write",
            {
              input: { file_path: file, content: "written\n" },
              output: "The file has been updated successfully.",
              metadata: readStateMetadata(file, "written\n", { tool: "Write" }),
              time: { start: 100, end: 200 },
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.get(createReadFileStateKey(file, 1, undefined))).toMatchObject({
      content: "written\n",
      mtimeMs: 1,
      path: file,
      readAt: new Date(2),
      revisionId: `rev:${file}:${Buffer.byteLength("written\n", "utf8")}:1`,
    });
  });

  it("skips legacy Write and Edit parts without structured read state metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit-legacy-skip");
    const writeFile = join(workspaceRoot, "legacy-written.ts");
    const editFile = join(workspaceRoot, "legacy-edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit-legacy", 10, [
          completedToolPart(sessionID, "assistant-write-edit-legacy", "tool-write-legacy", "Write", {
            input: { file_path: writeFile, content: "written content\n" },
            output: "The file has been updated successfully.",
          }),
          completedToolPart(sessionID, "assistant-write-edit-legacy", "tool-edit-legacy", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("restores Write and Edit states from structured metadata without reading current disk", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit");
    const writeFile = join(workspaceRoot, "written.ts");
    const editFile = join(workspaceRoot, "edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit", 10, [
          completedToolPart(sessionID, "assistant-write-edit", "tool-write", "Write", {
            input: { file_path: writeFile, content: "written content\n" },
            metadata: readStateMetadata(writeFile, "written content\n", { tool: "Write" }),
            output: "The file has been updated successfully.",
          }),
          completedToolPart(sessionID, "assistant-write-edit", "tool-edit", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            metadata: readStateMetadata(editFile, "edited from metadata\n", { tool: "Edit" }),
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStateKey(writeFile, 1, undefined))).toMatchObject({
      content: "written content\n",
      isPartialView: false,
      path: writeFile,
    });
    expect(readFileState.get(createReadFileStateKey(editFile, 1, undefined))).toMatchObject({
      content: "edited from metadata\n",
      isPartialView: false,
      path: editFile,
    });
  });

  it("only restores tool state from messages after the active compaction boundary", async () => {
    const sessionID = createSessionId("hydrate-read-state-compact");
    const oldFile = join(workspaceRoot, "old.ts");
    const newFile = join(workspaceRoot, "new.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-before-compact", 10, [
          completedToolPart(sessionID, "assistant-before-compact", "tool-old", "Read", {
            input: { file_path: oldFile },
            output: "1\told\n2\t",
            metadata: readStateMetadata(oldFile, "old\n"),
          }),
        ]),
        compactionMessage(sessionID, "compact-boundary", 20),
        assistantToolMessage(sessionID, "assistant-after-compact", 30, [
          completedToolPart(sessionID, "assistant-after-compact", "tool-new", "Read", {
            input: { file_path: newFile },
            output: "1\tnew\n2\t",
            metadata: readStateMetadata(newFile, "new\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.has(createReadFileStateKey(oldFile, 1, undefined))).toBe(false);
    expect(readFileState.has(createReadFileStateKey(newFile, 1, undefined))).toBe(true);
  });
});

function completedToolPart(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  callID: string,
  tool: string,
  state: {
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    output: string;
    time?: {
      end: number;
      start: number;
    };
  },
): ToolPart {
  const messageID = createMessageId(messageIDText);
  return {
    callID,
    id: createPartId(`${callID}-part`),
    messageID,
    sessionID,
    state: {
      input: state.input,
      metadata: state.metadata ?? { schemaVersion: 1 },
      output: state.output,
      status: "completed",
      title: tool,
      time: state.time ?? { start: 1, end: 2 },
    },
    tool,
    type: "tool",
  };
}

function assistantToolMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
  parts: ToolPart[],
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      cost: 0,
      id: messageID,
      mode: "build",
      modelID: "model-test",
      parentID: createMessageId(`${messageIDText}-user`),
      path: { cwd: workspaceRoot, root: workspaceRoot },
      providerID: "provider-test",
      role: "assistant",
      sessionID,
      time: { created },
      tokens: emptyTokens(),
    },
    parts,
  };
}

function compactionMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      id: messageID,
      model: { modelID: "model-test", providerID: "provider-test" },
      role: "user",
      sessionID,
      time: { created },
    },
    parts: [
      {
        id: createPartId(`${messageIDText}-part`),
        messageID,
        sessionID,
        type: "compaction",
      } as MessageWithParts["parts"][number],
    ],
  };
}

function readStateMetadata(
  filePath: string,
  content: string,
  options: {
    isPartialView?: boolean;
    limit?: number;
    offset?: number;
    tool?: "Read" | "Write" | "Edit";
  } = {},
): Record<string, unknown> {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  return {
    readFileState: {
      content,
      isPartialView: options.isPartialView ?? false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      mtimeMs: 1,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      path: filePath,
      readAtMs: 2,
      revisionId: `rev:${filePath}:${sizeBytes}:1`,
      schemaVersion: 1,
      sizeBytes,
      tool: options.tool ?? "Read",
    },
    schemaVersion: 1,
  };
}

function emptyTokens() {
  return {
    cache: {
      read: 0,
      write: 0,
    },
    input: 0,
    output: 0,
    reasoning: 0,
  };
}
