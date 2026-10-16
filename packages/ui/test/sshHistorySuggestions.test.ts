import { describe, expect, it } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";

describe("buildSshConnectionHistorySuggestions", () => {
  it("dedupes ssh history by recent order and ignores non-ssh entries", () => {
    const sessions: RemoteWorkspaceSessionEntry[] = [
      {
        kind: "remote",
        workspacePath: "/workspace/recent",
        workspaceIdentity: "remote:ssh:prod.internal:/workspace/recent",
        lastOpenedAt: 30,
        lastConnectionStatus: "connected",
        target: {
          kind: "ssh",
          host: "prod.internal",
          port: 2200,
          username: "deploy",
          privateKeyPath: "~/.ssh/deploy_ed25519",
        },
      },
      {
        kind: "remote",
        workspacePath: "/workspace/older",
        workspaceIdentity: "remote:ssh:prod.internal:/workspace/older",
        lastOpenedAt: 20,
        lastConnectionStatus: "connected",
        target: {
          kind: "ssh",
          host: "prod.internal",
          port: 2200,
          username: "deploy",
          privateKeyPath: "~/.ssh/deploy_ed25519",
        },
      },
      {
        kind: "remote",
        workspacePath: "/workspace/default-port",
        workspaceIdentity: "remote:ssh:demo.internal:/workspace/default-port",
        lastOpenedAt: 10,
        lastConnectionStatus: "connected",
        target: {
          kind: "ssh",
          host: "demo.internal",
          username: "root",
        },
      },
      {
        kind: "remote",
        workspacePath: "/workspace/docker",
        workspaceIdentity: "remote:docker:toolbox:/workspace/docker",
        lastOpenedAt: 5,
        lastConnectionStatus: "connected",
        target: {
          kind: "docker",
          container: "toolbox",
        },
      },
    ];

    expect(buildSshConnectionHistorySuggestions(sessions)).toEqual({
      hosts: ["prod.internal", "demo.internal"],
      ports: ["2200", "22"],
      usernames: ["deploy", "root"],
      privateKeyPaths: ["~/.ssh/deploy_ed25519"],
    });
  });
});
