import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function readSource(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Settings target workspace service routing", () => {
  it("keeps Model Provider settings on the Local Environment", async () => {
    const source = await readSource("src/SettingsPage.tsx");

    expect(source).toContain("const localHostServices = useBaseWorkspaceServices();");
    expect(source).toContain("<ServiceProvider services={localHostServices}>");
    expect(source).toContain("localModelProviderConnectivityWorkspacePath");
    expect(source).toContain("connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}");
    expect(source).not.toContain("modelProviderServiceResolution");

    const modelProviderStart = source.indexOf('activeSection === "modelProvider"');
    const modelProviderEnd = source.indexOf('activeSection === "memory"', modelProviderStart);
    const modelProviderSection = source.slice(modelProviderStart, modelProviderEnd);
    expect(modelProviderSection).not.toContain("workspaceIdentity={activeWorkspaceIdentity}");
  });

  it("does not expose remote Provider settings or a manual sync action", async () => {
    const source = await readSource("src/settings/ModelProviderSection.tsx");

    expect(source).not.toContain("remoteProviderProvisioningService");
    expect(source).not.toContain("syncLocalToRemote");
    expect(source).not.toContain("remoteProvisioningSupported");
    expect(source).not.toContain("syncRemoteConfirmDescription");
  });

  it("routes Plugin management through the selected workspace services", async () => {
    const source = await readSource("src/settings/PluginsSection.tsx");

    expect(source).toContain("useWorkspaceServicesResolution");
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*target\?\.workspacePath,\s*target\?\.remoteSessionId,\s*target\?\.workspaceIdentity,\s*target\?\.remoteTarget,\s*\)/,
    );
    expect(source).toContain(
      "const { pluginManagementService } = targetServiceResolution.services;",
    );
    expect(source).toContain("if (!target || !targetServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /selectedPlugin &&\s*selectedStoreItem &&\s*targetServiceResolution\.rpcReady/,
    );
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("routes Hooks through the selected workspace services", async () => {
    const source = await readSource("src/settings/HooksSection.tsx");

    expect(source).toContain("useWorkspaceServicesResolution");
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*targetWorkspacePath,\s*selectedWorkspace\?\.remoteSessionId,\s*targetWorkspaceIdentity,\s*selectedWorkspace\?\.remoteTarget,\s*\)/,
    );
    expect(source).toContain(
      "const { hooksService, pluginManagementService } = targetServiceResolution.services;",
    );
    expect(source).toContain("if (!targetServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("keeps Subagent settings on the Local Environment services and model view", async () => {
    const source = await readSource("src/settings/SubagentsSection.tsx");

    expect(source).toContain("const localHostServices = useBaseWorkspaceServices();");
    expect(source).toContain("localHostServices.modelSelectionService");
    expect(source).toContain(
      "const { pluginManagementService, subagentsService } = localHostServices;",
    );
    expect(source).toContain(
      ".filter((tab) => !tab.remoteTarget && !tab.remoteSessionId && !tab.workspaceIdentity)",
    );
    expect(source).not.toContain("useWorkspaceServicesResolution");
  });

  it("routes Skills through the target passed by PluginsSection", async () => {
    const source = await readSource("src/settings/SkillsSection.tsx");

    expect(source).toContain("useWorkspaceServicesResolution");
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*activeWorkspacePath,\s*remoteSessionId,\s*activeWorkspaceIdentity,\s*remoteTarget,\s*\)/,
    );
    expect(source).toMatch(
      /const \{ pluginManagementService, skillSyncService, skillsService \}\s*=\s*targetServiceResolution\.services;/,
    );
    expect(source).toContain("if (!targetServiceResolution.rpcReady) return;");
    expect(source).toContain("open={importDialogOpen && targetServiceResolution.rpcReady}");
    expect(source).toMatch(
      /skillOpen=\{\s*remoteSkillSyncOpen && targetServiceResolution\.rpcReady\s*\}/,
    );
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
    expect(source).toContain("projectionMatchesTarget");
    expect(source).toMatch(/loading \|\| !projectionMatchesTarget/);
  });

  it("routes Commands list reads and writes through the selected workspace services", async () => {
    const source = await readSource("src/settings/CommandsSection.tsx");

    expect(source).not.toContain('useServices.js"');
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*currentWorkspaceTab\?\.workspacePath \?\? workspacePath,\s*currentWorkspaceTab\?\.remoteSessionId,\s*currentWorkspaceTab\?\.workspaceIdentity \?\? workspaceIdentity,\s*currentWorkspaceTab\?\.remoteTarget,\s*\)/,
    );
    expect(source).toMatch(
      /const \{ commandsService, pluginManagementService, settingsSyncService \}\s*=\s*listServiceResolution\.services;/,
    );
    // 导入入口的 service 必须与列表 target 同源，且连接未就绪时不允许打开对话框。
    expect(source).toMatch(
      /<CommandsImportDialog\s*open=\{importDialogOpen && listServiceResolution\.rpcReady\}[\s\S]*?settingsSyncService=\{settingsSyncService\}/,
    );
    // 命令列表读写与插件投影都必须拿到 target service，并在连接就绪前暂停 RPC。
    expect(source).toMatch(
      /useCommands\(\{[\s\S]*?commandsService,\s*enabled: listServiceResolution\.rpcReady,\s*\}\)/,
    );
    expect(source).toContain("if (!workspacePath || !listServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /!listServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("requires callers to inject a target-scoped settings sync service into the import dialog", async () => {
    const dialog = await readSource("src/settings/ExternalAgentImportDialog.tsx");

    // Bug 原因：detect/importSelected 携带调用方传入的 target 路径，而 service 曾取自
    // useServices()，跨 host 时会在激活 host 上按另一个 workspace 的路径做 symlink/copy 落盘。
    expect(dialog).not.toContain('useServices.js"');
    expect(dialog).toMatch(/settingsSyncService: ISettingsSyncService;/);

    // 三个 Scope 感知入口都必须注入自己 target 的 service，并在连接未就绪时不开对话框。
    const skills = await readSource("src/settings/SkillsSection.tsx");
    expect(skills).toContain(
      "settingsSyncService={targetServiceResolution.services.settingsSyncService}",
    );
    const mcp = await readSource("src/settings/McpSettingsSection.tsx");
    expect(mcp).toContain("settingsSyncService={services.settingsSyncService}");
    expect(mcp).toContain("PluginLoadingState");
    expect(mcp).toMatch(
      /!mcpProjectionReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.loading"/,
    );
    expect(mcp).toContain("open={importDialogOpen && mcpStoreMatchesActiveWorkspace}");
  });

  it("requires callers to inject a target-scoped commands service", async () => {
    const source = await readSource("src/hooks/useCommands.ts");

    // Bug 原因：service 隐式取自 useServices() 时，Scope 选中的远程 workspace 路径会被
    // 发往当前激活 host。必传参数让错误路由在类型层面就无法通过。
    expect(source).not.toContain('useServices.js"');
    expect(source).toMatch(/commandsService: ICommandsService;/);
    expect(source).toContain("export function useCommands(options: UseCommandsOptions)");
  });
});
