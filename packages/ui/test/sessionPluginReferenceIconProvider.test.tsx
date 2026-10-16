// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";

const usePluginReferenceCatalog = vi.fn(() => ({
  authority: "session" as const,
  entries: [],
  error: null,
  loading: false,
}));

vi.mock("@/hooks/usePluginReferenceCatalog.js", () => ({
  usePluginReferenceCatalog,
}));

describe("SessionPluginReferenceIconBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not mount the catalog hook until a matching Session contains Plugin references", () => {
    const { rerender } = render(
      <SessionPluginReferenceIconBoundary
        enabled={false}
        remoteSessionId="remote-a"
        sessionId="session-a"
        workspaceIdentity="ssh://host/workspace"
        workspacePath="/workspace"
      >
        <span>timeline</span>
      </SessionPluginReferenceIconBoundary>,
    );

    expect(screen.getByText("timeline")).toBeTruthy();
    expect(usePluginReferenceCatalog).not.toHaveBeenCalled();

    rerender(
      <SessionPluginReferenceIconBoundary
        enabled
        remoteSessionId="remote-a"
        sessionId="session-a"
        workspaceIdentity="ssh://host/workspace"
        workspacePath="/workspace"
      >
        <span>timeline</span>
      </SessionPluginReferenceIconBoundary>,
    );

    expect(usePluginReferenceCatalog).toHaveBeenCalledWith(
      "/workspace",
      "ssh://host/workspace",
      "session-a",
      true,
      {
        dedupeSessionRequest: true,
        preferredRemoteSessionId: "remote-a",
        suppressErrorLog: true,
      },
    );
  });
});
