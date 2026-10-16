import { describe, expect, it, beforeEach } from "vitest";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

describe("useSlashCommands", () => {
  beforeEach(() => {
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  it("remote workspace 会按 workspaceIdentity 读取 slash commands", () => {
    const workspacePath = "/root";
    const workspaceIdentity = "remote:ssh:demo:22:root:/root";
    useZCodeSessionStore.getState().setSlashCommands(
      workspacePath,
      [{ name: "remote-command", description: "remote command" }],
      workspaceIdentity,
    );

    const identityCommands = selectWorkspaceZCodeState(
      useZCodeSessionStore.getState(),
      workspacePath,
      workspaceIdentity,
    ).slashCommands;
    const pathOnlyCommands = selectWorkspaceZCodeState(useZCodeSessionStore.getState(), workspacePath).slashCommands;

    expect(identityCommands.map((command) => command.name)).toEqual(["remote-command"]);
    expect(pathOnlyCommands).toEqual([]);
  });
});
