import { describe, expect, it } from "vitest";
import { resolveSidebarOpenWorkspaceAction } from "@/lib/remoteConnectionEntryBehavior.js";

describe("remoteConnectionEntryBehavior", () => {
  it("keeps sidebar open-workspace action on the project selector while a remote connection is active", () => {
    expect(
      resolveSidebarOpenWorkspaceAction({ remoteConnectionInProgress: true }),
    ).toBe("open-workspace");
  });

  it("keeps sidebar open-workspace action unchanged when no connection is active", () => {
    expect(
      resolveSidebarOpenWorkspaceAction({ remoteConnectionInProgress: false }),
    ).toBe("open-workspace");
  });
});
