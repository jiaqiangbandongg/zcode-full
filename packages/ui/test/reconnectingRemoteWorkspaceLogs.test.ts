import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceReconnectLogLabelPrefix,
  resolveRemoteWorkspaceReconnectLogHistoryIds,
} from "@/root/reconnectingRemoteWorkspaceLogs.js";

describe("reconnecting remote workspace runtime logs", () => {
  it("matches reconnecting SSH history entry by runtime log label", () => {
    const historyIds = resolveRemoteWorkspaceReconnectLogHistoryIds({
      runtimeLabel: "remote-workspace-ssh-github.com-a1b2c3d4-9",
      reconnectingEntries: [
        {
          id: "history-ssh",
          target: {
            kind: "ssh",
            host: "github.com",
            username: "git",
          },
        },
        {
          id: "history-docker",
          target: {
            kind: "docker",
            container: "zcode-dev",
          },
        },
      ],
    });

    expect(historyIds).toEqual(["history-ssh"]);
  });

  it("uses sanitized label prefix for docker container names", () => {
    const prefix = buildRemoteWorkspaceReconnectLogLabelPrefix({
      kind: "docker",
      container: "project/container#1",
    });

    expect(prefix).toBe("remote-workspace-docker-project-container-1-");
  });

  it("matches WSL default distro logs", () => {
    const historyIds = resolveRemoteWorkspaceReconnectLogHistoryIds({
      runtimeLabel: "remote-workspace-wsl-default-b7e89f10-3",
      reconnectingEntries: [
        {
          id: "history-wsl",
          target: {
            kind: "wsl",
          },
        },
      ],
    });

    expect(historyIds).toEqual(["history-wsl"]);
  });

  it("does not guess a workspace when entries share one target prefix without request id", () => {
    const historyIds = resolveRemoteWorkspaceReconnectLogHistoryIds({
      runtimeLabel: "remote-workspace-ssh-build-host-ff001122-5",
      reconnectingEntries: [
        {
          id: "history-a",
          target: {
            kind: "ssh",
            host: "build host",
            username: "dev",
          },
        },
        {
          id: "history-b",
          target: {
            kind: "ssh",
            host: "build host",
            username: "ops",
          },
        },
      ],
    });

    expect(historyIds).toEqual([]);
  });

  it("prefers request id over target prefix when concurrent reconnects share one target", () => {
    const historyIds = resolveRemoteWorkspaceReconnectLogHistoryIds({
      runtimeLabel: "remote-workspace-ssh-build-host-ff001122-5",
      runtimeRequestId: "request-b",
      reconnectingEntries: [
        {
          id: "history-a",
          requestId: "request-a",
          target: {
            kind: "ssh",
            host: "build host",
            username: "dev",
          },
        },
        {
          id: "history-b",
          requestId: "request-b",
          target: {
            kind: "ssh",
            host: "build host",
            username: "ops",
          },
        },
      ],
    });

    expect(historyIds).toEqual(["history-b"]);
  });

  it("matches request-scoped window Host logs without relying on the legacy runtime label", () => {
    const historyIds = resolveRemoteWorkspaceReconnectLogHistoryIds({
      runtimeLabel: "window-host-7",
      runtimeRequestId: "request-ssh",
      reconnectingEntries: [
        {
          id: "history-ssh",
          requestId: "request-ssh",
          target: {
            kind: "ssh",
            host: "linux-amd64",
            username: "root",
          },
        },
      ],
    });

    expect(historyIds).toEqual(["history-ssh"]);
  });
});
