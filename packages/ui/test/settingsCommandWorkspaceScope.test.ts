import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getCommandWorkspaceTabs,
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "../src/settings/commandWorkspaceScope.js";
import type { WorkspaceTabState } from "../src/store/tabStore.js";

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Command settings concrete Workspace scope", () => {
  const localTab = {
    id: "local",
    kind: "workspace",
    label: "repo",
    workspacePath: "/repo",
  } as WorkspaceTabState;
  const remoteTabA = {
    id: "remote-a",
    kind: "workspace",
    label: "default",
    workspaceIdentity: "ssh://host-a/root",
    workspacePath: "/root",
    remoteSessionId: "session-a",
  } as WorkspaceTabState;
  const remoteTabB = {
    id: "remote-b",
    kind: "workspace",
    label: "default",
    workspaceIdentity: "ssh://host-b/root",
    workspacePath: "/root",
    remoteSessionId: "session-b",
  } as WorkspaceTabState;

  it("keeps same-path remote Workspaces isolated by identity", () => {
    const tabs = getCommandWorkspaceTabs([
      localTab,
      { ...localTab, id: "local-duplicate" },
      remoteTabA,
      remoteTabB,
    ]);

    expect(tabs).toEqual([localTab, remoteTabA, remoteTabB]);
    expect(resolveCommandStorageTarget("ssh://host-b/root", tabs)).toEqual({
      storageLevel: "project",
      workspace: remoteTabB,
    });
  });

  it("falls back only for create and closes an edit whose owner disappeared", () => {
    expect(
      resolveCommandScopeRecovery({
        editing: false,
        scopeKey: "ssh://closed/root",
        workspaceTabs: [remoteTabA],
      }),
    ).toBe("fallback-user");
    expect(
      resolveCommandScopeRecovery({
        editing: true,
        scopeKey: "ssh://closed/root",
        workspaceTabs: [remoteTabA],
      }),
    ).toBe("close-editor");
  });

  it("refreshes the parent projection only for User or the current Workspace", () => {
    expect(shouldRefreshCurrentCommandList("user", "workspace-a")).toBe(true);
    expect(shouldRefreshCurrentCommandList("workspace-a", "workspace-a")).toBe(true);
    expect(shouldRefreshCurrentCommandList("workspace-b", "workspace-a")).toBe(false);
  });

  it("reuses the concrete User and Workspace scope menu", () => {
    const formSource = readSource("src/settings/CommandForm.tsx");

    expect(formSource).toContain("PluginScopeMenu");
    expect(formSource).toContain("selectedScopeKey");
    expect(formSource).toContain("workspaceTabs");
    expect(formSource).toContain("onScopeKeyChange");
    expect(formSource).toMatch(/<PluginScopeMenu\s+align="end"/);
    expect(formSource).not.toContain("function CommandScopeSelect");
    expect(formSource).not.toContain("<SelectItem");
  });

  it("resolves the selected Workspace Host instead of reusing the current service", () => {
    const sectionSource = readSource("src/settings/CommandsSection.tsx");

    expect(sectionSource).toContain("useWorkspaceServicesResolution");
    expect(sectionSource).toContain("getPluginWorkspaceKey");
    expect(sectionSource).toContain("formScopeKey");
    expect(sectionSource).toContain("formTargetWorkspace");
    expect(sectionSource).toContain("formServices.commandsService");
    expect(sectionSource).toContain("currentWorkspaceKey");
    expect(sectionSource).not.toContain(
      'storageLevel === "project" ? (workspacePath ?? undefined) : undefined',
    );
  });

  it("keeps the current list projection isolated from another Workspace save", () => {
    const sectionSource = readSource("src/settings/CommandsSection.tsx");

    expect(sectionSource).toContain("shouldRefreshCurrentCommandList");
    expect(sectionSource).toContain("await refresh()");
    expect(sectionSource).toContain("writeCommandFile");
    expect(sectionSource).not.toContain("await createCommand(");
  });

  it("locks edit ownership and recovers when a selected Workspace closes", () => {
    const sectionSource = readSource("src/settings/CommandsSection.tsx");
    const formSource = readSource("src/settings/CommandForm.tsx");

    expect(sectionSource).toContain("setFormScopeKey");
    expect(sectionSource).toContain('setFormScopeKey("user")');
    expect(sectionSource).toContain("resolveCommandScopeRecovery");
    expect(formSource).toContain("disabled={Boolean(initial)}");
  });
});
