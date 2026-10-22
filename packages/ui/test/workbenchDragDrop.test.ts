import { describe, expect, it } from "vitest";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  parseWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";

describe("workbench session drag/drop helpers", () => {
  it("serializes and parses session drag payloads", () => {
    const serialized = serializeWorkbenchSessionDragPayload({
      kind: "zcode/session",
      workspacePath: "/ws/a",
      workspaceIdentity: " remote:ssh:host:/ws/a ",
      remoteSessionId: "remote-1",
      sessionId: "sess-a",
    });

    expect(serialized).toContain("sess-a");
    expect(
      parseWorkbenchSessionDragPayload({
        types: [WORKBENCH_SESSION_DRAG_MIME],
        getData: () => serialized,
      }),
    ).toEqual({
      kind: "zcode/session",
      workspacePath: "/ws/a",
      workspaceIdentity: " remote:ssh:host:/ws/a ",
      remoteSessionId: "remote-1",
      sessionId: "sess-a",
    });
  });

  it("rejects missing, malformed, or non-session drag payloads", () => {
    expect(
      parseWorkbenchSessionDragPayload({
        types: [],
        getData: () => "",
      }),
    ).toBeNull();
    expect(
      parseWorkbenchSessionDragPayload({
        types: [WORKBENCH_SESSION_DRAG_MIME],
        getData: () => "{bad json",
      }),
    ).toBeNull();
    expect(
      parseWorkbenchSessionDragPayload({
        types: [WORKBENCH_SESSION_DRAG_MIME],
        getData: () => JSON.stringify({ kind: "other" }),
      }),
    ).toBeNull();
  });

  it("falls back to the active renderer-local payload when dragover cannot read data", () => {
    const payload = {
      kind: "zcode/session" as const,
      workspacePath: "/ws/a",
      sessionId: "sess-a",
    };
    setActiveWorkbenchSessionDragPayload(payload);

    expect(
      parseWorkbenchSessionDragPayload({
        types: [WORKBENCH_SESSION_DRAG_MIME],
        getData: () => "",
      }),
    ).toEqual(payload);

    clearActiveWorkbenchSessionDragPayload();
    expect(
      parseWorkbenchSessionDragPayload({
        types: [WORKBENCH_SESSION_DRAG_MIME],
        getData: () => "",
      }),
    ).toBeNull();
  });
});
