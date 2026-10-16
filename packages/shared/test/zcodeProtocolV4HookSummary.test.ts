import { describe, expect, it } from "vitest";
import {
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  hookInvocationRowSchema,
  type HookInvocationRow,
} from "../src/zcode-protocol-v4/index.js";

function hookRow(): HookInvocationRow {
  return {
    rowId: 3,
    turnId: "turn-1",
    entityId: "hook-invocation-1",
    productTurnId: "turn-1",
    visibility: "visible",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 3,
    kind: "hookInvocation",
    hookInvocationId: "hook-invocation-1",
    hookEventName: "PreToolUse",
    hookCount: 1,
    state: "completed",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_025,
    durationMs: 25,
    lane: "toolBefore",
    anchorToolCallId: "tool-1",
    executions: [
      {
        hookRunId: "hook-run-1",
        hookIndex: 0,
        didExecute: true,
        state: "completed",
        outcome: "success",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_025,
        durationMs: 25,
        displayName: "validate-write",
        sourceKind: "project",
        toolName: "Write",
      },
    ],
  };
}

describe("V4 Hook turn summary schema", () => {
  it("accepts only the client-safe execution summary", () => {
    const parsed = hookInvocationRowSchema.parse(hookRow());
    expect(parsed.executions[0]).toMatchObject({
      didExecute: true,
      displayName: "validate-write",
      sourceKind: "project",
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /commandDisplay|sourcePath|stdin|stdout|stderr|toolInput/u,
    );
  });

  it("rejects Desktop-only command and path details at the strict wire boundary", () => {
    const row = hookRow();
    expect(() =>
      hookInvocationRowSchema.parse({
        ...row,
        executions: [
          {
            ...row.executions[0],
            commandDisplay: "node hooks/check.mjs --token secret",
            sourcePath: "/workspace/.zcode/config.json",
          },
        ],
      }),
    ).toThrow();
  });

  it.each([DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable])(
    "keeps the same safe Hook row for $flushWindowMs ms profile",
    (profile) => {
      const row = hookRow();
      expect(filterConversationRowsForProfile([row], profile)).toEqual([row]);
      expect(
        filterConversationDeltasForProfile([{ op: "row.appended", row }], profile),
      ).toEqual([{ op: "row.appended", row }]);
    },
  );
});
