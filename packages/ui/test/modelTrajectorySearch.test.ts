import { describe, expect, it } from "vitest";
import { resolveTrajectoryTimelineItems } from "@/ModelTrajectoryPane.js";
import { buildTrajectorySearchIndex } from "@/ModelTrajectorySearch.js";

describe("model trajectory search", () => {
  it("indexes rendered message content and tool metadata without call metadata", () => {
    const items = resolveTrajectoryTimelineItems([
      {
        requestId: "req-1",
        attempt: 1,
        startedAt: "2026-08-24T01:00:00.000Z",
        durationMs: 9_999,
        model: { modelId: "hidden-model" },
        request: {
          messages: [
            { role: "system", parts: [{ kind: "text", text: "Alpha\n\tbeta" }] },
            {
              role: "tool",
              parts: [
                {
                  kind: "tool-result",
                  toolCallId: "call_visible-id",
                  toolName: "visible-tool",
                  output: { type: "error-text", value: "Failure needle" },
                },
              ],
            },
          ],
          toolNames: [],
        },
        response: {
          reasoningText: "Reasoning needle",
          text: "Assistant needle",
          toolCalls: [
            {
              kind: "tool-call",
              toolCallId: "call_write-file",
              toolName: "WriteFile",
              input: { path: "/tmp/needle.ts" },
            },
          ],
        },
      },
    ]);

    expect(buildTrajectorySearchIndex(items, "alpha beta").matches[0]).toMatchObject({
      callIndex: 0,
      expansionKey: "req-1:0:input:0",
      field: "content",
      sourceStart: 0,
      sourceEnd: 11,
    });
    expect(buildTrajectorySearchIndex(items, "needle").matches).toHaveLength(4);
    expect(buildTrajectorySearchIndex(items, "visible-tool").matches[0]).toMatchObject({
      expansionKey: "req-1:0:input:1",
      field: "tool-name",
    });
    expect(buildTrajectorySearchIndex(items, "visible-id").matches[0]).toMatchObject({
      field: "tool-id",
    });
    expect(buildTrajectorySearchIndex(items, "call_visible-id").matches).toHaveLength(0);
    expect(buildTrajectorySearchIndex(items, "hidden-model").matches).toHaveLength(0);
    expect(buildTrajectorySearchIndex(items, "9999").matches).toHaveLength(0);
  });

  it("tracks repeated occurrences with stable match keys", () => {
    const items = resolveTrajectoryTimelineItems([
      {
        requestId: "req-repeat",
        attempt: 1,
        startedAt: "2026-08-24T01:00:00.000Z",
        model: {},
        request: {
          messages: [{ role: "user", parts: [{ kind: "text", text: "find FIND find" }] }],
          toolNames: [],
        },
      },
    ]);

    const matches = buildTrajectorySearchIndex(items, "find").matches;
    expect(matches.map((match) => match.fieldMatchIndex)).toEqual([0, 1, 2]);
    expect(new Set(matches.map((match) => match.key)).size).toBe(3);
  });
});
