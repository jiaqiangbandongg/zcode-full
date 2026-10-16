// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reportAppTelemetryEvent: vi.fn(async () => {}),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: h.reportAppTelemetryEvent,
}));

vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: (_workspacePath: string, remoteSessionId?: string) =>
    remoteSessionId ?? null,
}));

vi.mock("@/hooks/useWebRemoteControlStatus.js", () => ({
  useWebRemoteControlStatus: () => ({ status: "idle" }),
}));

vi.mock("@/WebRemoteControlDialog.js", () => ({
  WebRemoteControlDialog: () => null,
}));

afterEach(() => {
  cleanup();
  h.reportAppTelemetryEvent.mockClear();
});

async function renderTrigger(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { WorkspaceWebRemoteControlTrigger } =
    await import("../src/WorkspaceWebRemoteControlTrigger.js");
  const { WebRemoteControlFeatureProvider } =
    await import("../src/WebRemoteControlFeatureProvider.js");
  const { PlatformProvider } = await import("../src/hooks/usePlatform.js");
  const platform = {
    reportTelemetryEvent: vi.fn(async () => {}),
  };

  render(
    createElement(
      PlatformProvider,
      { platform: platform as never },
      createElement(
        WebRemoteControlFeatureProvider,
        { enabled: true },
        createElement(WorkspaceWebRemoteControlTrigger, input),
      ),
    ),
  );

  fireEvent.click(screen.getByRole("button"));
  return platform;
}

describe("WorkspaceWebRemoteControlTrigger telemetry", () => {
  it("点击本地 workspace 入口时上报 local 维度", async () => {
    const platform = await renderTrigger({
      workspacePath: "/workspace/local",
    });

    expect(h.reportAppTelemetryEvent).toHaveBeenCalledWith(
      platform,
      {
        elementName: "web_remote_control_entry_view",
        eventRegion: "web_remote_control",
        eventType: "view",
        eventExtraDetail: {
          workspace_kind: "local",
          remote_kind: "",
        },
      },
      "web-remote-control-entry",
    );
  });

  it("点击远程 workspace 入口时上报解析后的 remote kind", async () => {
    const platform = await renderTrigger({
      workspacePath: "/workspace/remote",
      workspaceIdentity: "remote:ssh:dev.example.com:22:root:/workspace/remote",
      remoteSessionId: "remote-session-1",
    });

    expect(h.reportAppTelemetryEvent).toHaveBeenCalledWith(
      platform,
      {
        elementName: "web_remote_control_entry_view",
        eventRegion: "web_remote_control",
        eventType: "view",
        eventExtraDetail: {
          workspace_kind: "remote",
          remote_kind: "ssh",
        },
      },
      "web-remote-control-entry",
    );
  });
});
