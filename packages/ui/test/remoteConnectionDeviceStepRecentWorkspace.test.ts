// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceServerManagementSnapshot } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));

import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const preferredProfileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const historyProfileId = "28ef20b3-622d-4a53-98c1-0cdff29f3e6d";

function snapshotOf(online: boolean): SourceServerManagementSnapshot {
  return {
    generation: 1,
    profiles: [
      {
        profileId: preferredProfileId,
        transport: "ssh",
        target: { kind: "ssh", host: "10.0.0.4", username: "dev" },
        sourceServerId,
        createdAt: 1,
        lifecycleState: "active",
      },
      {
        profileId: historyProfileId,
        transport: "ssh",
        target: { kind: "ssh", host: "10.0.0.5", username: "dev" },
        sourceServerId,
        createdAt: 2,
        lifecycleState: "active",
      },
    ],
    servers: [
      {
        sourceServerId,
        displayName: "devbox",
        installState: "installed",
        preferredProfileId,
      },
    ],
    workspaceHistory: [
      {
        workspacePath: "/home/dev",
        profileId: preferredProfileId,
        sourceServerId,
        lastOpenedAt: 1,
      },
      {
        workspacePath: "/home/dev/test",
        profileId: historyProfileId,
        sourceServerId,
        lastOpenedAt: 2,
      },
    ],
    states: online
      ? [
          {
            profileId: preferredProfileId,
            sourceServerId,
            state: "online",
            updateAvailability: "none",
            updatedAt: 1,
          },
        ]
      : [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  } as never;
}

function renderDeviceStep(snapshot: SourceServerManagementSnapshot) {
  const onSelectProfile = vi.fn();
  render(
    createElement(RemoteConnectionSelection, {
      snapshot,
      onSelectProfile,
      onNewConnection: vi.fn(),
      aliases: [],
      distros: [],
      containers: [],
      availableKinds: ["ssh"],
      dockerAvailable: null,
      loading: false,
      discoveryError: "",
      onSelectAlias: vi.fn(),
      onSelectTarget: vi.fn(),
      remoteConversationWorkspaceBySourceServerId: {},
    }),
  );
  return onSelectProfile;
}

/**
 * 设备卡「最近目录」交互合同（docs/design/r3-remote-ui-redesign.md 首屏：最近目录一键打开）：
 * 点击目录行 = 直接沿该目录所属线路打开工作区；「选择其他目录」= 只负责进入目录浏览器。
 * 两者互不耦合，目录行不再是一个需要二次确认的“选中”态。
 */
describe("RemoteConnectionDeviceStep recent workspace entries", () => {
  it("opens the workspace immediately when a recent directory row is clicked", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(true));

    fireEvent.click(screen.getByText("/home/dev/test"));

    expect(onSelectProfile).toHaveBeenCalledTimes(1);
    expect(onSelectProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: historyProfileId }),
      "/home/dev/test",
    );
  });

  it("always opens the directory browser from the choose-directory button", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(true));

    // 先点过目录行，再点「选择其他目录」：按钮不能继承任何“已选目录”，必须进入目录浏览器。
    fireEvent.click(screen.getByText("/home/dev"));
    fireEvent.click(screen.getByText("devbox"));

    expect(onSelectProfile).toHaveBeenCalledTimes(2);
    expect(onSelectProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: preferredProfileId }),
    );
  });

  it("connects and opens recent directories while the device is offline", () => {
    const onSelectProfile = renderDeviceStep(snapshotOf(false));

    const row = screen.getByText("/home/dev/test").closest("button");
    expect(row?.disabled).toBe(false);
    fireEvent.click(row!);
    expect(onSelectProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: historyProfileId }),
      "/home/dev/test",
    );
  });
});
