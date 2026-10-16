import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolvedRemoteSessionIdMock } = vi.hoisted(() => ({
  resolvedRemoteSessionIdMock: vi.fn<() => string | null>(),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    description,
    side,
  }: {
    children: unknown;
    title: string;
    description?: string;
    side?: string;
  }) =>
    createElement(
      "span",
      {
        "data-tooltip-title": title,
        "data-tooltip-description": description ?? "",
        "data-tooltip-side": side ?? "",
      },
      children,
    ),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    ...props
  }: {
    children: unknown;
    [key: string]: unknown;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/lucide.js", () => ({
  Smartphone: () => createElement("span", { "data-testid": "smartphone-icon" }),
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

vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: resolvedRemoteSessionIdMock,
}));

vi.mock("@/hooks/useWebRemoteControlStatus.js", () => ({
  useWebRemoteControlStatus: () => ({ status: "idle" }),
}));

vi.mock("@/WebRemoteControlDialog.js", () => ({
  WebRemoteControlDialog: ({
    initialTaskId,
    remoteSessionId,
  }: {
    initialTaskId?: string;
    remoteSessionId?: string;
  }) =>
    createElement("div", {
      "data-testid": "web-remote-control-dialog",
      "data-initial-task-id": initialTaskId ?? "",
      "data-remote-session-id": remoteSessionId ?? "",
    }),
}));

async function renderTriggerWithEnv(
  env: "test" | "production",
  options?: {
    initialTaskId?: string;
    featureEnabled?: boolean;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  vi.resetModules();
  vi.doMock("@zcode/shared", () => ({ ZCODE_ENV: env }));

  const { WorkspaceWebRemoteControlTrigger } =
    await import("../src/WorkspaceWebRemoteControlTrigger.js");
  const { WebRemoteControlFeatureProvider } =
    await import("../src/WebRemoteControlFeatureProvider.js");

  const trigger = createElement(WorkspaceWebRemoteControlTrigger, {
    workspacePath: "/tmp/project",
    workspaceIdentity: options?.workspaceIdentity,
    remoteSessionId: options?.remoteSessionId,
    initialTaskId: options?.initialTaskId,
  });

  return renderToStaticMarkup(
    typeof options?.featureEnabled === "boolean"
      ? createElement(
          WebRemoteControlFeatureProvider,
          { enabled: options.featureEnabled },
          trigger,
        )
      : trigger,
  );
}

afterEach(() => {
  resolvedRemoteSessionIdMock.mockReset();
  vi.resetModules();
});

describe("WorkspaceWebRemoteControlTrigger", () => {
  it("在 test 环境展示 Web 远程控制入口", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("在 production 环境展示 Web 远程控制入口", async () => {
    const html = await renderTriggerWithEnv("production");

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("允许 root wiring 显式注入 Web 远程控制入口能力", async () => {
    const html = await renderTriggerWithEnv("production", {
      featureEnabled: true,
    });

    expect(html).toContain("webRemoteControl.trigger");
  });

  it("把当前 active task 作为 Web 远程控制初始 task 传给弹层", async () => {
    const html = await renderTriggerWithEnv("test", {
      initialTaskId: "task-from-desktop",
    });

    expect(html).toContain('data-initial-task-id="task-from-desktop"');
  });

  it("用 workspaceIdentity 精确解析远控 session，并只向弹层传递已验证结果", async () => {
    resolvedRemoteSessionIdMock.mockReturnValue(null);

    const html = await renderTriggerWithEnv("test", {
      workspaceIdentity: "remote:ssh:localhost:2222:root:/tmp/project",
      remoteSessionId: "stale-session",
    });

    expect(resolvedRemoteSessionIdMock).toHaveBeenCalledWith(
      "/tmp/project",
      "stale-session",
      "remote:ssh:localhost:2222:root:/tmp/project",
    );
    expect(html).toContain('data-remote-session-id=""');
    expect(html).not.toContain('data-remote-session-id="stale-session"');
  });

  it("把入口名称和手机连接状态合并到同一个 tooltip", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain('data-tooltip-title="webRemoteControl.trigger"');
    expect(html).toContain(
      'data-tooltip-description="webRemoteControl.triggerStatus.idle"',
    );
    expect(html).not.toContain(
      'data-tooltip-title="webRemoteControl.triggerStatus.idle"',
    );
  });

  it("在按钮上方展示远程控制 tooltip", async () => {
    const html = await renderTriggerWithEnv("test");

    expect(html).toContain('data-tooltip-side="top"');
  });
});
