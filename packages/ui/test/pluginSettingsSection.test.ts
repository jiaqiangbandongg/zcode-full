import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPluginScopeWorkspaceConnected } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Plugin settings section", () => {
  it("只把可用本地项目和已连接远端项目放进 Scope", () => {
    const workspace = (overrides: Partial<WorkspaceTabState>) =>
      ({
        id: "workspace-1",
        kind: "workspace",
        label: "Workspace",
        workspacePath: "/workspace",
        ...overrides,
      }) as WorkspaceTabState;

    expect(isPluginScopeWorkspaceConnected(workspace({}))).toBe(true);
    expect(
      isPluginScopeWorkspaceConnected(workspace({ availability: "unavailable-local-directory" })),
    ).toBe(false);
    expect(
      isPluginScopeWorkspaceConnected(
        workspace({ workspaceIdentity: "remote:ssh:host:/workspace" }),
      ),
    ).toBe(false);
    expect(
      isPluginScopeWorkspaceConnected(
        workspace({
          workspaceIdentity: "remote:ssh:host:/workspace",
          remoteSessionId: "remote-session-1",
        }),
      ),
    ).toBe(true);
  });

  it("uses a transparent dashed container for install empty states", () => {
    const source = readSource("src/settings/PluginInstallEmptyState.tsx");
    const pluginSource = readSource("src/settings/PluginsSection.tsx");
    expect(source).toContain("border border-dashed border-border bg-transparent");
    expect(source).not.toContain("rounded-xl bg-surface");
    expect(pluginSource).toContain(
      'className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle"',
    );
    expect(pluginSource).not.toContain("border-dashed border-border bg-surface px-4 py-8");
    expect(source).toContain("PluginLoadingState");
    expect(readSource("src/settings/PluginsSection.tsx")).toContain("<PluginLoadingState");
    expect(readSource("src/settings/SkillsSection.tsx")).toContain("<PluginLoadingState");
    expect(readSource("src/settings/PluginsSection.tsx")).toMatch(
      /<PluginInstallEmptyState[\s\S]*?size="lg"/,
    );
    expect(readSource("src/settings/McpSettingsSection.tsx")).toMatch(
      /<PluginInstallEmptyState[\s\S]*?size="lg"/,
    );
    expect(readSource("src/settings/SkillsSection.tsx")).toMatch(
      /<PluginInstallEmptyState[\s\S]*?size="lg"/,
    );
  });

  it("uses independent Plugin, MCP, Skill, and Command settings navigation entries", () => {
    const source = readSource("src/settings/settingsPageConfig.ts");
    const navigationSource = readSource("src/lib/settingsNavigation.ts");
    expect(source.indexOf('id: "plugin"')).toBeGreaterThan(-1);
    expect(source.indexOf('id: "mcp"')).toBeGreaterThan(-1);
    expect(source.indexOf('id: "skill"')).toBeGreaterThan(-1);
    expect(source.indexOf('id: "commands"')).toBeGreaterThan(-1);
    expect(source).toContain('id: "plugin"');
    expect(source).not.toContain('id: "plugins"');
    expect(source).toContain('titleId: "settings.plugins.title"');
    expect(navigationSource).not.toContain('| "customize"');
    expect(navigationSource).not.toContain('value === "customize"');
  });

  it("keeps the plugin marketplace outside Settings", () => {
    const source = readSource("src/SettingsPage.tsx");
    expect(source).toContain('activeSection === "plugin"');
    expect(source).not.toContain('activeSection === "customize"');
    expect(source).toContain("<PluginsSection");
    expect(source).not.toContain("PluginStorePage");
    expect(source).not.toContain('activeSection === "plugins"');
  });

  it("reuses the scoped capability section for independent MCP, Skill, and Command pages", () => {
    const pageSource = readSource("src/SettingsPage.tsx");
    const sectionSource = readSource("src/settings/PluginsSection.tsx");
    expect(pageSource).toContain('activeSection === "mcp"');
    expect(pageSource).toContain('mode="mcp"');
    expect(pageSource).toContain('activeSection === "skill"');
    expect(pageSource).toContain('mode="skill"');
    expect(pageSource).toContain('activeSection === "commands"');
    expect(pageSource).toContain('mode="command"');
    expect(sectionSource).toContain('mode?: "plugin" | "mcp" | "skill" | "command"');
    expect(sectionSource).toMatch(/mode === "mcp"\s*\? "mcps"/);
    // 插件与独立 MCP/Skill/Command 页面都需要 Scope 菜单。
    expect(sectionSource).toContain("<PluginScopeMenu");
    expect(sectionSource).toContain('mode === "plugin"');
    expect(sectionSource).toContain('data-independent-capability-count="true"');
    expect(sectionSource).toMatch(/mode === "mcp"\s*\? "settings\.plugin\.tab\.mcps"/);
    expect(sectionSource).toMatch(/mode === "mcp"\s*\? capabilityCounts\.mcps/);
    expect(sectionSource).toMatch(/mode === "command"\s*\? "commands"/);
    expect(sectionSource).toContain("<CommandsSection");
    expect(sectionSource).toContain("commandFormScopeKey");
    expect(sectionSource).toContain("effectiveCommandWorkspace");
    expect(sectionSource).toContain("onFormScopeKeyChange={setCommandFormScopeKey}");
    expect(sectionSource).toContain('className="hidden h-4 w-px bg-border sm:block"');
  });

  it("reuses the complete Plugin scope menu in the Command editor", () => {
    const formSource = readSource("src/settings/CommandForm.tsx");
    const commandSource = readSource("src/settings/CommandsSection.tsx");
    expect(formSource).toContain("<PluginScopeMenu");
    expect(formSource).toContain('align="end"');
    expect(formSource).toContain("selectedScopeKey={scopeKey}");
    expect(commandSource).toContain("parentScopeKey");
    expect(commandSource).toContain("onFormScopeKeyChange");
  });

  it("routes marketplace plugin management to Settings Plugins", () => {
    const marketplaceSource = readSource("src/settings/PluginStorePage.tsx");
    expect(marketplaceSource).toContain("onManageInstalled");
    expect(marketplaceSource).toContain("onOpenManage={onManageInstalled}");
    expect(marketplaceSource).not.toContain('"manage"');
    expect(marketplaceSource).not.toContain("PluginStoreManageView");
  });

  it("keeps User and Workspace as configuration views while the marketplace stays scope-free", () => {
    const source = readSource("src/settings/PluginsSection.tsx");
    const marketplaceSource = readSource("src/settings/PluginStorePage.tsx");
    const scopeMenuSource = readSource("src/settings/PluginScopeMenu.tsx");
    const configControlsSource = readSource("src/settings/PluginConfigControls.tsx");
    const navigationSource = readSource("src/lib/pluginStoreNavigation.ts");
    const appSource = readSource("src/App.tsx");
    const shellSource = readSource("src/app-shell/WorkspaceShellLayout.tsx");
    const zhLocale = readSource("src/i18n/locales/zh-CN.ts");
    const enLocale = readSource("src/i18n/locales/en-US.ts");
    expect(source).toContain('type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands"');
    expect(source).toContain("const selectedScopeKey = pickedScopeKey;");
    expect(source).toContain("configScope");
    expect(source).toContain('if (selectedScope.kind !== "user") return');
    expect(source).toContain('onOpenPluginStore("user", intent)');
    expect(source).toContain(
      'onAdd={selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined}',
    );
    expect(source).toContain("onOpenPluginStore={openPluginStoreForSelectedScope}");
    expect(source).toContain("partitionPluginsForSettings");
    expect(source).toContain("onInstall: () => onOpenPluginStore()");
    expect(navigationSource).toContain("new CustomEvent");
    expect(navigationSource).toContain("detail: pendingTarget");
    expect(appSource).toContain("pluginStoreReturnScopeKey");
    expect(appSource).toContain("pluginStoreOpenVersion");
    expect(appSource).toMatch(
      /handleNavigateToPluginStoreMain[\s\S]*?setPluginStoreReturnScopeKey\("user"\)/,
    );
    expect(appSource).toMatch(
      /handleOpenPluginStoreForScope[\s\S]*?const returnScopeKey = "user"[\s\S]*?handleOpenPluginStore\(\);[\s\S]*?setPluginStoreReturnScopeKey\(returnScopeKey\)/,
    );
    expect(shellSource).not.toContain("pluginScope=");
    expect(shellSource).toContain("handleManageInstalledPlugins");
    expect(shellSource).toContain("key={`plugin-store:${pluginStoreOpenVersion}`}");
    expect(configControlsSource).not.toContain("workspaceSecretGitWarning");
    expect(configControlsSource).not.toContain("plugin-store-workspace-secret-warning");
    expect(configControlsSource).toContain("onClearOption");
    expect(configControlsSource).toContain('scope === "workspace"');
    expect(configControlsSource).toContain('"settings.plugins.config.restoreOption"');
    expect(configControlsSource).toContain('data-testid="plugin-store-config-clear"');
    expect(configControlsSource).toContain("data-plugin-id={plugin.id}");
    expect(source).toContain("clearOptionKeys");
    expect(source).toMatch(
      /const configured = await configurePlugin[\s\S]*?if \(!configured\) return;[\s\S]*?setPluginOptionsDrafts/,
    );
    expect(marketplaceSource).not.toContain("PluginScopeMenu");
    expect(marketplaceSource).not.toContain("PluginConfigControls");
    expect(marketplaceSource).not.toContain("setEnabled");
    expect(marketplaceSource).toContain('configScope: "user"');
    expect(marketplaceSource).toMatch(
      /installPlugin\([\s\S]*?item\.name,[\s\S]*?item\.marketplace,[\s\S]*?pluginManagementService,[\s\S]*?"user"/,
    );
    expect(zhLocale).not.toContain('"settings.plugins.config.workspaceSecretGitWarning"');
    expect(enLocale).not.toContain('"settings.plugins.config.workspaceSecretGitWarning"');
    expect(zhLocale).toContain('"settings.plugins.config.clearSecret"');
    expect(enLocale).toContain('"settings.plugins.config.clearSecret"');
    // 57d9e78562 起 PluginScopeMenu 改用统一工具 getWorkspaceKey 构造隔离 key
    //（workspaceIdentity 语义禁止手写拼接），断言跟随实现改为校验工具调用。
    expect(scopeMenuSource).toContain("getWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)");
    expect(source).toContain('value="plugins"');
    expect(source).toContain('value="mcps"');
    expect(zhLocale).toContain('"settings.plugin.tab.mcps": "MCP"');
    expect(enLocale).toContain('"settings.plugin.tab.mcps": "MCP"');
    expect(source).toContain('value="skills"');
    expect(source).not.toMatch(/<TabsTrigger[\s\S]{0,180}value="commands"/);
    expect(zhLocale).toContain('"settings.plugin.tab.commands": "命令"');
    expect(source).not.toContain("flatSourceList");
    expect(scopeMenuSource).toContain('data-plugin-scope-trigger="true"');
    expect(scopeMenuSource).toContain("Monitor");
    expect(scopeMenuSource).not.toContain("LaptopMinimal");
    expect(scopeMenuSource).not.toContain("UserRound");
    // Scope 的 User 标签必须走 i18n（settings.plugin.scope.user 已有 en/zh 两份译文），
    // 之前这里断言的是硬编码英文字面量，等于把 bug 固化成契约。
    expect(scopeMenuSource).toContain(
      'const userLabel = intl.formatMessage({ id: "settings.plugin.scope.user" })',
    );
    expect(scopeMenuSource).not.toContain('const userLabel = "User"');
    expect(scopeMenuSource).not.toContain("<Badge");
    expect(scopeMenuSource).not.toContain("~/.zcode");
    expect(scopeMenuSource).toContain('size="default"');
    expect(scopeMenuSource).toMatch(
      /data-plugin-scope-trigger="true"\s+data-plugin-scope-key=\{selectedScopeKey\}\s+className="rounded-full"/,
    );
    expect(source).toMatch(/<TabsList\s+variant="line"/);
    expect(source).toContain("h-7 flex-none rounded-full px-3");
    expect(source).not.toContain("<Server aria-hidden");
    expect(source).not.toContain("<WandSparkles aria-hidden");
    expect(source).toContain("hover:bg-hover data-active:!bg-selected");
    expect(source).toContain("data-active:hover:!bg-hover");
    expect(source).toContain("searchQueries");
    expect(source).toContain("capabilityCounts");
    expect(source).toContain("mcpEditorOpen");
    expect(source).toContain("onEditorOpenChange={handleMcpEditorOpenChange}");
    expect(source).toContain("onFormScopeKeyChange={setMcpFormScopeKey}");
    expect(source).toContain("{!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (");
    expect(source).toContain("onVisibleCountChange");
    expect(source).toContain("getPluginTabCountClass");
    expect(source).toContain('"text-ui-sm text-foreground-subtle"');
    expect(source).toContain('"text-ui-sm text-foreground-subtlest"');
    expect(source.match(/<TabsContent\s+forceMount/g)).toHaveLength(4);
    expect(source.match(/data-\[state=inactive\]:hidden/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("SettingsSearchInput");
    expect(source).toContain("const hasEmptySearchResult =");
    expect(source).toContain("const hideInstalledGroup =");
    expect(source).toContain("hasEmptySearchResult ? (");
    expect(source).toContain('clearLabel={intl.formatMessage({ id: "settings.search.clear" })}');
    expect(source).toContain("onClear={() =>");
    expect(source).not.toContain("border-b border-border pb-5");
    expect(source).toContain('className="overflow-hidden rounded-xl bg-surface"');
    expect(source).toContain('className="h-px bg-border/50"');
    expect(source).not.toContain("divide-y divide-border/50");
    expect(source).toContain(
      '"group/plugin-row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"',
    );
    expect(source).not.toContain("rounded-xl border border-card-border bg-card");
    expect(source).not.toContain('index > 0 && "border-t border-border"');
    expect(source).not.toContain("{plugin.marketplace}");
    expect(source).toContain("resolvePluginDisplayName(");
    expect(source).toContain("storeItemById.get(plugin.id) ?? { name: plugin.name }");
    expect(source).toContain("buildStoreItems({");
    expect(source).toContain("<PluginStoreAvatar");
    expect(source).toContain("item={storeItemById.get(plugin.id) ?? { name: plugin.name }}");
    expect(source).toContain('className="size-9 bg-background"');
    expect(source).toContain("<SettingsResourceHeaderActions");
    expect(source).toContain("<PluginAddMenu");
    expect(source).toContain("<PluginInstallEmptyState");
    expect(source).toContain('id: "settings.plugin.plugins.emptyInstalledTitle"');
    expect(source).toContain("group/plugin-row");
    expect(source).toContain(
      "text-foreground-subtle opacity-0 group-hover/plugin-row:opacity-100 focus-visible:opacity-100",
    );
    expect(source).toMatch(/<MoreHorizontal[\s\S]*<Switch/);
    expect(source).toContain("<DropdownMenuItem");
    expect(source).toContain("uninstall.requestUninstall(plugin.id)");
    expect(source).toContain("handleUpdatePlugin(plugin.id)");
    expect(source).toContain("canUpdatePluginItem(storeItemById.get(plugin.id))");
    expect(source).toContain("selectBuiltInPlugins(plugins, installedPlugins)");
    expect(source).toContain("visibleInstalledPlugins.length");
    expect(source).toContain('id: "settings.plugin.plugins.builtIn"');
    expect(source).toContain("showUnavailableComputerUse");
    expect(source).toContain('id: "settings.computerUse.unsupported.badge"');
    expect(source).toContain("matchesComputerUseSearch(searchQuery)");
    expect(source).toContain('<section className="space-y-6"');
    expect(source).toContain(
      'className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"',
    );
    expect(source).toContain('className="text-ui-sm font-normal text-foreground-subtle"');
    expect(source).toContain("<PluginStoreDetailView");
    expect(source).toContain("<SettingsBreadcrumbReporter");
    expect(source).toContain("<PluginStoreAdvancedSection>");
    expect(source).not.toContain("<InstalledPluginDetailDialog");
    expect(source).toContain("actions.onOpenDetail(plugin.id)");
    expect(source).toContain("onUpdate: (pluginId)");
    expect(source).toContain("<PluginUninstallConfirmDialog");
    expect(source).not.toContain("setEditing");
    expect(source).not.toContain("settings.plugin.edit");
    expect(source).toContain("searchQuery={searchQueries.plugins}");
    expect(source).toContain("searchQuery={searchQueries.mcps}");
    expect(source).toContain("searchQuery={searchQueries.skills}");
    expect(source).not.toContain("hideSearchInput");
    expect(source).not.toContain('className="max-w-full gap-2 rounded-full"');
    expect(scopeMenuSource).toContain('className="size-4 text-foreground-subtlest"');
    expect(source).toContain('className="hidden h-4 w-px bg-border sm:block"');
    expect(source).not.toContain('className="hidden h-7 w-px bg-border sm:block"');
    expect(scopeMenuSource).toContain('className="w-64 max-w-[calc(100vw-2rem)]"');
    expect(source).not.toContain("username");
    expect(source).not.toContain("userDisplayName");
    expect(source).not.toContain("formatWorkspaceScopePath");
    expect(source).not.toContain("homeDir");
  });

  it("exposes the remote Plugin sync entry on the Plugins settings page", () => {
    const source = readSource("src/settings/PluginsSection.tsx");

    expect(source).toContain('id: "settings.plugins.remoteSync.open"');
    expect(source).toContain("canSyncPlugins");
    expect(source).toContain("remotePluginSyncOpen");
    expect(source).toContain("localPluginSyncService={baseServices.pluginSyncService}");
    expect(source).toContain(
      "remotePluginSyncService={targetServiceResolution.services.pluginSyncService}",
    );
    expect(source).toContain("<RemoteSyncDialogs");
  });

  it("shows the connected remote workspace context on the Plugin tab", () => {
    const source = readSource("src/settings/PluginsSection.tsx");

    expect(source).toContain(
      'import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";',
    );
    expect(source).toContain("const remotePluginSyncTargetLabel = connectedRemoteSyncTarget");
    expect(source).toContain('id: "settings.plugins.remoteContext"');
    expect(source).toMatch(
      /connectedRemoteSyncTarget \? \([\s\S]*?settings\.plugins\.remoteContext[\s\S]*?remotePluginSyncTargetLabel/,
    );
  });

  it("reuses the complete Plugin scope menu in the MCP editor", () => {
    const scopeMenuSource = readSource("src/settings/PluginScopeMenu.tsx");
    const sectionSource = readSource("src/settings/PluginsSection.tsx");
    const formSource = readSource("src/settings/McpServerForm.tsx");
    const mcpSource = readSource("src/settings/McpSettingsSection.tsx");

    expect(scopeMenuSource).toContain("export function PluginScopeMenu");
    expect(scopeMenuSource).toContain("export function isPluginScopeWorkspaceConnected");
    expect(scopeMenuSource).toContain('tab.availability === "unavailable-local-directory"');
    expect(scopeMenuSource).toContain("return Boolean(tab.remoteSessionId)");
    expect(scopeMenuSource).toContain('align = "start"');
    expect(scopeMenuSource).toContain("workspaceTabs");
    expect(scopeMenuSource).toContain(".map((tab) => ({");
    expect(scopeMenuSource).toContain("Cloud");
    expect(scopeMenuSource).toContain("remote: Boolean(tab.remoteTarget || tab.remoteSessionId)");
    expect(scopeMenuSource).toContain("workspace.remote ? Cloud : Folder");
    expect(sectionSource).toContain(".filter(isPluginScopeWorkspaceConnected)");
    expect(sectionSource).toContain("mcpEditorWorkspaceMissing");
    expect(sectionSource).toContain("commandEditorWorkspaceMissing");
    expect(sectionSource).toContain("setMcpEditorOpen(false)");
    expect(sectionSource).toContain("setCommandEditorOpen(false)");
    expect(sectionSource).toContain("const mcpTarget = mcpEditorWorkspaceMissing");
    expect(sectionSource).toContain("const commandTarget = commandEditorWorkspaceMissing");
    expect(formSource).toMatch(/<PluginScopeMenu\s+align="end"/);
    expect(formSource).not.toContain("function McpScopeSelect");
    expect(mcpSource).toContain("await ensureLoadedForWorkspace(");
    expect(mcpSource).toContain("const services = useWorkspaceServices(");
    expect(mcpSource).toContain("remoteSessionId,");
    expect(mcpSource).toContain("workspaceIdentity,");
    expect(mcpSource).toContain("formScopeKey");
    expect(mcpSource).toContain("onFormScopeKeyChange");
  });

  it("reuses the automation detail segmented tabs for Form and JSON", () => {
    const segmentedTabsSource = readSource("src/settings/SettingsSegmentedTabs.tsx");
    const automationSource = readSource("src/settings/AutomationDesignPrimitives.tsx");
    const mcpSource = readSource("src/settings/McpSettingsSection.tsx");

    expect(segmentedTabsSource).toContain("export function SettingsSegmentedTabs");
    expect(segmentedTabsSource).toContain("rounded-full bg-surface");
    expect(segmentedTabsSource).toContain("data-active:bg-background");
    expect(automationSource).toContain("<SettingsSegmentedTabs");
    expect(mcpSource).toContain("<SettingsSegmentedTabs");
    expect(mcpSource).not.toContain("function McpEditorModeTabs");
  });

  it("binds plugin-contributed MCPs and Skills to scoped plugin installations", () => {
    const mcpSource = readSource("src/settings/McpSettingsSection.tsx");
    const mcpListSource = readSource("src/settings/McpServerList.tsx");
    const skillsSource = readSource("src/settings/SkillsSection.tsx");
    const sharedGroupSource = readSource("src/settings/SettingsResourceGroup.tsx");
    expect(mcpSource).toMatch(
      /selectPluginsForScope\(\s*plugins,\s*installedPlugins,\s*scopeFilter,?\s*\)/,
    );
    expect(mcpSource).toContain("const query = searchQuery");
    expect(mcpSource).not.toContain("hideSearchInput");
    expect(mcpSource).toContain("onEditorOpenChange?.(isFormView)");
    expect(mcpSource).toContain('data-mcp-list-layout="grouped"');
    expect(mcpSource).toContain("groupPluginMcpServersByPlugin");
    expect(mcpSource).toContain("<SettingsResourceGroupHeader");
    expect(sharedGroupSource).toContain(
      'className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"',
    );
    expect(mcpSource).toContain('id: "settings.plugin.mcp.installed"');
    expect(mcpSource).toContain('className={hideInstalledGroup ? "hidden" : "space-y-4"}');
    expect(mcpSource).not.toContain("flatSourceList");
    expect(mcpSource).toContain("<SettingsResourceHeaderActions");
    expect(mcpSource).toContain('data-mcp-plugin-installed-actions="true"');
    expect(mcpSource).toContain("<PluginInstallEmptyState");
    expect(mcpSource).toContain("<PluginSearchEmptyState");
    expect(mcpSource).toContain("const hasEmptySearchResult =");
    expect(mcpSource).toContain("const hideInstalledGroup =");
    expect(mcpSource).toContain("hasEmptySearchResult ? (");
    expect(mcpSource).toContain('id: "settings.plugin.mcp.searchEmpty"');
    expect(mcpSource).toContain('id: "settings.plugin.mcp.emptyInstalledTitle"');
    expect(mcpSource).toContain('importActionId="settings.mcp.import.open"');
    expect(mcpSource).toContain("data-mcp-plugin-group={group.pluginId}");
    expect(mcpSource).not.toContain("sourceLabelOnly");
    expect(mcpSource).not.toContain("formatCanonicalMarketplaceName");
    expect(mcpSource).not.toContain("<Badge");
    expect(mcpSource).not.toContain("typeof item.toolCount");
    expect(mcpSource).toContain("<PluginStoreAvatar");
    expect(mcpSource).toContain("listing: pluginListingById.get(item.pluginId)");
    expect(mcpSource).toContain('className="size-9 bg-background"');
    expect(mcpSource).not.toContain('className="divide-y divide-border"');
    expect(sharedGroupSource).toContain('className="overflow-hidden rounded-xl bg-surface"');
    expect(sharedGroupSource).toContain('className="h-px bg-border/50"');
    expect(mcpSource).not.toContain('className="divide-y divide-border"');
    expect(mcpListSource).toContain("<SettingsResourceList");
    expect(mcpListSource).toContain(
      "size-9 shrink-0 items-center justify-center rounded-xl bg-background",
    );
    expect(mcpListSource).not.toContain('className="divide-y divide-border"');
    expect(mcpListSource).toContain("hideMetadata");
    expect(mcpListSource).toContain('variant="link"');
    expect(mcpSource).toContain('variant="link"');
    expect(mcpListSource).toContain('<ExternalLink className="size-4"');
    expect(mcpSource).toContain('<ExternalLink className="size-4"');
    expect(mcpListSource).toContain(
      'className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"',
    );
    expect(mcpSource).toContain(
      'className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"',
    );
    expect(skillsSource).toContain("selectSkillsForScope(");
    expect(skillsSource).toContain("groupScopedSkillsBySource(");
    expect(skillsSource).toContain("const query = searchQuery");
    expect(skillsSource).not.toContain("hideSearchInput");
    expect(skillsSource).toContain("SettingsResourceGroupHeader");
    expect(skillsSource).toContain('id: "settings.plugin.skills.installed"');
    expect(skillsSource).toContain('data-skills-plugin-direct-actions="true"');
    expect(skillsSource).toContain("<PluginInstallEmptyState");
    expect(skillsSource).toContain("<PluginSearchEmptyState");
    expect(skillsSource).toContain("const hasEmptySearchResult =");
    expect(skillsSource).toContain("const hideInstalledGroup =");
    expect(skillsSource).toContain("hasEmptySearchResult ? (");
    expect(skillsSource).toContain('id: "settings.plugin.skills.searchEmpty"');
    expect(skillsSource).toContain('id: "settings.plugin.skills.emptyInstalledTitle"');
    expect(skillsSource).toContain("<SettingsResourceList");
    expect(skillsSource).toContain(
      "size-9 shrink-0 items-center justify-center rounded-xl bg-background",
    );
    expect(skillsSource).toContain("<PluginStoreAvatar");
    expect(skillsSource).toContain("pluginIconItemById.get");
    expect(skillsSource).toContain('className="size-9 bg-background"');
    expect(skillsSource).toContain("<WandSparkles");
    expect(skillsSource).toContain("title={resolvePluginDisplayName(");
    expect(skillsSource).not.toContain("EnabledStatusFilterSelect");
    expect(skillsSource).not.toContain("enabledFilter");
    expect(skillsSource).not.toContain("!scopeFilter ? (");
    expect(skillsSource).not.toContain("data-skill-scope");
  });
});
