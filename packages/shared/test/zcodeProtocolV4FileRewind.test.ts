import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationFileRewindPreviewResultSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("zcode-protocol-v4 file summary queries", () => {
  it("defines fileChanges and fileRewindPreview v4 methods", () => {
    expect(V4_METHODS.conversationFileChanges).toBe("v4/conversation/fileChanges");
    expect(V4_METHODS.conversationFileRewindPreview).toBe(
      "v4/conversation/fileRewindPreview",
    );
  });

  it("validates fileChanges query params and readonly diff result", () => {
    const params = v4ConversationFileChangesParamsSchema.parse({
      sessionId: "s-1",
      target: { rowId: 42, entityId: "turn-42" },
      baseRevision: 9,
      baseLogEpoch: "epoch-9",
    });
    const result = v4ConversationFileChangesResultSchema.parse({
      files: 1,
      additions: 2,
      deletions: 1,
      state: "active",
      items: [
        {
          path: "/work/src/demo.ts",
          additions: 2,
          deletions: 1,
          writeCount: 2,
          toolNames: ["Edit"],
          patches: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: ["-a", "+b", "+c"],
            },
          ],
        },
      ],
    });
    expect(params.target).toEqual({ rowId: 42, entityId: "turn-42" });
    expect(result.items[0]?.patches[0]?.lines).toEqual(["-a", "+b", "+c"]);
  });

  it("validates file rewind preview query result", () => {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse({
      sessionId: "s-1",
      target: { rowId: 42, entityId: "turn-42" },
      baseRevision: 9,
      baseLogEpoch: "epoch-9",
    });
    const result = v4ConversationFileRewindPreviewResultSchema.parse({
      canApply: false,
      safeFiles: [],
      unsafeFiles: [
        {
          path: "/work/src/demo.ts",
          reason: "external_modified",
          operationCount: 1,
          toolNames: ["Edit"],
          currentHash: "abc",
          expectedHash: "def",
        },
      ],
      ignoredFiles: [],
    });
    expect(params.sessionId).toBe("s-1");
    expect(result.unsafeFiles[0]?.reason).toBe("external_modified");
  });

  it("hard-rejects legacy row-only preview params", () => {
    expect(
      v4ConversationFileRewindPreviewParamsSchema.safeParse({
        sessionId: "s-1",
        targetRowId: 42,
      }).success,
    ).toBe(false);
  });
});
