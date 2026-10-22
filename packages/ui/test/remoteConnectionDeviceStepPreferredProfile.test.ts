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

function profileOf(profileId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    profileId,
    transport: "docker" as const,
    target: { kind: "docker" as const, container: profileId },
    sourceServerId,
    createdAt: 1,
    ...overrides,
  };
}

function snapshotOf(
  profiles: Array<ReturnType<typeof profileOf>>,
  overrides: Partial<SourceServerManagementSnapshot> = {},
): SourceServerManagementSnapshot {
  return {
    generation: 1,
    profiles,
    servers: [
      {
        sourceServerId,
        displayName: "devbox",
        installState: "installed",
        preferredProfileId: "p-preferred",
      },
    ],
    workspaceHistory: [],
    states: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
    ...overrides,
  } as SourceServerManagementSnapshot;
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

/** 合同 §8.1.1 线路选择规则：preferred 有效用之 → 已删/归档回退第一条 active → 无 active 禁用。 */
describe("RemoteConnectionDeviceStep preferred profile fallback", () => {
  it("connects through the preferred profile when it is still active", () => {
    const onSelectProfile = renderDeviceStep(
      snapshotOf([profileOf("p-first"), profileOf("p-preferred")], {
        states: [
          {
            profileId: "p-preferred",
            sourceServerId,
            state: "online",
            updateAvailability: "none",
            updatedAt: 1,
          },
        ],
      } as never),
    );

    fireEvent.click(screen.getByText("devbox"));
    expect(onSelectProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "p-preferred" }),
    );
  });

  it("falls back to the first active profile when the preferred one is retired", () => {
    const onSelectProfile = renderDeviceStep(
      snapshotOf([
        profileOf("p-preferred", { lifecycleState: "retired" }),
        profileOf("p-first"),
        profileOf("p-second"),
      ]),
    );

    fireEvent.click(screen.getByText("devbox"));
    expect(onSelectProfile).toHaveBeenCalledWith(expect.objectContaining({ profileId: "p-first" }));
  });

  it("disables the connect entry when the device has no active profile left", () => {
    const onSelectProfile = renderDeviceStep(
      snapshotOf([
        profileOf("p-preferred", { lifecycleState: "retired" }),
        profileOf("p-old", { lifecycleState: "retired" }),
      ]),
    );

    const button = screen.getByText("devbox").closest("button");
    expect(button?.disabled).toBe(true);
    fireEvent.click(button!);
    expect(onSelectProfile).not.toHaveBeenCalled();
  });
});
