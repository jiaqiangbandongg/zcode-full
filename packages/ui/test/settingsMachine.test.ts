// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

afterEach(cleanup);

describe("设置机器标注", () => {
  const remote: WorkspaceTabState = {
    id: "remote",
    kind: "workspace",
    label: "project",
    workspacePath: "/project",
    workspaceIdentity: "remote:server:source-a:/project",
    remoteSessionId: "session",
    remoteTarget: { kind: "docker", container: "dev-container" },
  };
  function wrap(child: React.ReactNode) {
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        SettingsMachinesProvider,
        {
          servers: [
            { sourceServerId: "source-a", displayName: "构建机", installState: "installed" },
          ],
        },
        createElement(TooltipProvider, {}, child),
      ),
    );
  }

  it("插件用户与项目菜单均写出设备名，远端用户不使用显示器图标", () => {
    render(
      wrap(
        createElement(PluginScopeMenu, {
          selectedScopeKey: "user",
          userTarget: remote,
          workspaceTabs: [remote],
          onScopeKeyChange: vi.fn(),
        }),
      ),
    );
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toContain("构建机（远程）");
    expect(trigger.querySelector(".lucide-monitor")).toBeNull();
    expect(trigger.querySelector(".lucide-cloud")).toBeTruthy();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitemradio", { name: "project · 构建机（远程）" })).toBeTruthy();
  });
});
