import { describe, expect, it } from "vitest";
import { shouldShowRemoteSkillSyncAction } from "../src/WorkspaceHeaderSections.js";

describe("shouldShowRemoteSkillSyncAction", () => {
  it("only shows the remote skill sync action for connected SSH workspaces", () => {
    expect(
      shouldShowRemoteSkillSyncAction({
        remoteSessionId: "session-1",
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          username: "alice",
          port: 22,
        },
      }),
    ).toBe(true);

    expect(
      shouldShowRemoteSkillSyncAction({
        remoteSessionId: "session-1",
        remoteTarget: { kind: "docker", container: "app" },
      }),
    ).toBe(false);

    expect(
      shouldShowRemoteSkillSyncAction({
        remoteSessionId: null,
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          username: "alice",
          port: 22,
        },
      }),
    ).toBe(false);
  });
});
