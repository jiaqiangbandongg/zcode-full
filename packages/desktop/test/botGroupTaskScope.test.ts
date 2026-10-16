import { describe, expect, it } from "vitest";
import { bindBotGroupTaskScope } from "../src/host/botGroupTaskScope.js";

describe("group remote task attachment", () => {
  it("injects the validated remote identity and session over caller supplied routing", () => {
    expect(
      bindBotGroupTaskScope(
        { taskId: "task", workspaceIdentity: "forged", remoteSessionId: "stale" },
        {
          kind: "remote",
          workspacePath: "/work",
          workspaceIdentity: "ssh://host/work",
          remoteSessionId: "current",
        },
      ),
    ).toEqual({
      taskId: "task",
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
      remoteSessionId: "current",
    });
  });
  it("keeps local task routing unchanged", () => {
    const params = { taskId: "task" };
    expect(bindBotGroupTaskScope(params, { kind: "local" })).toBe(params);
  });
});
