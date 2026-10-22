// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteProjectMenu } from "@/project-sidebar/RemoteProjectMenu.js";
import type { SourceServerManagementSnapshot } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(cleanup);

it.each(["online", "offline"] as const)(
  "设备列表不依赖项目；%s 设备保留连接后选目录意图",
  async (state) => {
    const onOpenRemoteWorkspace = vi.fn();
    const snapshot: SourceServerManagementSnapshot = {
      generation: 1,
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
      servers: [
        { sourceServerId: "a", displayName: "Device without project", installState: "installed" },
      ],
      profiles: [
        {
          profileId: "p",
          sourceServerId: "a",
          displayName: "SSH",
          transport: "ssh",
          lifecycleState: "active",
          createdAt: 1,
          target: { kind: "ssh", host: "dev", username: "me" },
        },
      ],
      states: [{ profileId: "p", state, updatedAt: 1 }],
      workspaceHistory: [],
    };
    // 默认线路离线、其他线路在线时，只传入实际展示的 Profile，避免设备偏好二次覆盖。
    snapshot.servers[0]!.preferredProfileId = "default-offline";
    snapshot.profiles.unshift({ ...snapshot.profiles[0]!, profileId: "default-offline" });
    snapshot.states.unshift({ profileId: "default-offline", state: "offline", updatedAt: 0 });
    render(
      createElement(RemoteProjectMenu, { snapshot, onOpenRemoteWorkspace, onOpenFolder: vi.fn() }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "workspaceSidebar.addProject" }), {
      key: "Enter",
    });
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: "workspaceSidebar.openRemoteProject" }),
      { key: "ArrowRight" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Device without project/ }));
    expect(onOpenRemoteWorkspace).toHaveBeenCalledWith({ preferredProfileId: "p" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "workspaceSidebar.addProject" }), {
      key: "Enter",
    });
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: "workspaceSidebar.openRemoteProject" }),
      { key: "ArrowRight" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "workspaceSidebar.newRemoteConnection" }),
    );
    expect(onOpenRemoteWorkspace).toHaveBeenLastCalledWith();
  },
);
