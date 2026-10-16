import { readSourceText } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readSourceText(new URL(relativePath, import.meta.url), "utf8");
}

const settingsPagePartsSource = readSource("../src/settings/SettingsPageParts.tsx");
const settingsPageSource = readSource("../src/SettingsPage.tsx");
const automationsSectionSource = readSource("../src/settings/AutomationsSection.tsx");
const automationEditViewSource = readSource("../src/settings/AutomationEditView.tsx");
const offPeakEditViewSource = readSource("../src/settings/OffPeakEditView.tsx");
const workspaceShellSource = readSource("../src/app-shell/WorkspaceShellLayout.tsx");
const automationsBreadcrumbFrameSource = readSource(
  "../src/settings/AutomationsMainBreadcrumbFrame.tsx",
);

describe("settings frame content layout", () => {
  it("shares one frame-aligned content column across Settings and Automations views", () => {
    expect(settingsPagePartsSource).toContain(
      '"mx-auto w-full max-w-4xl px-4 pb-8 pt-0 lg:px-8 lg:pb-10"',
    );

    for (const source of [
      settingsPageSource,
      automationsSectionSource,
      automationEditViewSource,
      offPeakEditViewSource,
    ]) {
      expect(source).toContain("SETTINGS_FRAME_CONTENT_CLASSNAME");
    }

    for (const source of [
      automationsSectionSource,
      automationEditViewSource,
      offPeakEditViewSource,
    ]) {
      expect(source).not.toContain("max-w-[866px]");
    }
  });

  it("keeps Model Provider settings on the shared 4xl content column", () => {
    expect(settingsPageSource).not.toContain('activeSection === "modelProvider" && "max-w-6xl"');
  });

  it("keeps the remote Automations shell frame with drag and scroll responsibilities", () => {
    expect(workspaceShellSource).toContain(
      'className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6"',
    );
    expect(automationsBreadcrumbFrameSource).toContain(
      'data-testid="automations-main-drag-region"',
    );
    expect(workspaceShellSource).toContain(
      "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]",
    );
  });

  it("limits the independent plugin marketplace to the 4xl content width", () => {
    expect(
      workspaceShellSource.match(
        /className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6"[\s\S]{0,120}<PluginStorePage/g,
      ),
    ).toHaveLength(2);
  });

  it("returns to chat before creating a task from plugin detail prompts", () => {
    const pluginStoreUsages = workspaceShellSource.match(
      /<PluginStorePage[\s\S]{0,500}?onCreateTask=\{handleCreateTaskInChat\}/g,
    );

    // Desktop 与窄屏 Shell 都必须使用包含 showChatMainView 的包装回调。
    expect(pluginStoreUsages).toHaveLength(2);
    expect(workspaceShellSource).not.toMatch(
      /<PluginStorePage[\s\S]{0,500}?onCreateTask=\{onCreateTask\}/,
    );
  });

  it("renders the read-only Settings breadcrumb inside the caption drag region", () => {
    expect(settingsPageSource).toMatch(
      /min-w-0 flex-1 \[app-region:drag\][\s\S]*?<SettingsHeaderBreadcrumb/,
    );
    expect(settingsPageSource).toContain(
      "settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel",
    );
    expect(settingsPageSource).toContain("hasVisibleSettingsBreadcrumb");
    expect(settingsPageSource).toContain(
      'const showActiveSectionTitle =\n    !hasVisibleSettingsBreadcrumb ||\n    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store")',
    );
    expect(settingsPageSource).toMatch(/showActiveSectionTitle[\s\S]*?<h2/);
  });

  it("remounts capability routes when Settings navigation is selected", () => {
    expect(settingsPageSource).toContain("settingsSectionNavigationVersion");
    expect(settingsPageSource).toContain("setSettingsSectionNavigationVersion");
    expect(settingsPageSource).toContain("key={`plugin:${settingsSectionNavigationVersion}`}");
    expect(settingsPageSource).toContain("key={`mcp:${settingsSectionNavigationVersion}`}");
    expect(settingsPageSource).toContain("key={`skill:${settingsSectionNavigationVersion}`}");
  });

  it("only exposes the Project Memory viewer from the desktop host", () => {
    expect(settingsPageSource).toContain("projectMemoryViewerAvailable={Boolean(isDesktop)}");
    expect(settingsPageSource).not.toContain("projectMemoryViewerAvailable={!isWebRemoteControl}");
  });

  it("pins the Project Memory viewer subtree to the local base host", () => {
    expect(settingsPageSource).toMatch(
      /<ServiceProvider services=\{localHostServices\}>[\s\S]*?<MemorySettingsSection[\s\S]*?<\/ServiceProvider>/,
    );
  });

  it("lets Project Memory share the Settings main scroll chain like Plugins", () => {
    expect(settingsPageSource).toContain("grid-rows-[minmax(0,1fr)]");
    expect(settingsPageSource).toContain(
      'className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"',
    );
    expect(settingsPageSource).not.toContain("usesContainedMemoryViewerLayout");
  });
});
