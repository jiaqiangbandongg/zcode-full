import { useFeedbackStore } from "@/feedback/feedbackStore.js";
// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({}) }));

import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";

afterEach(cleanup);

it("replaces upload percentage with live install stages and preserves the failure log", () => {
  const logs: RemoteConnectionLogEntry[] = [
    {
      id: "upload",
      level: "info",
      message: "[source-server:upload] archive 100.0%",
      timestamp: "16:22:07",
    },
  ];
  const props = {
    kind: "ssh" as const,
    loading: true,
    errorMessage: "",
    onBack() {},
    onRetry() {},
  };
  const view = render(createElement(RemoteConnectionConnectingStep, { ...props, logs }));
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  for (const [phase, messageId] of [
    ["extract", "remote.phaseSub.extracting"],
    ["verify", "remote.phaseSub.verifyingFiles"],
    ["restart", "remote.phaseSub.restarting"],
  ]) {
    logs.push({
      id: phase!,
      level: "info",
      message: `[source-server:${phase}] working`,
      timestamp: "16:22:08",
    });
    view.rerender(createElement(RemoteConnectionConnectingStep, { ...props, logs: [...logs] }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(messageId!)).toBeTruthy();
  }
  logs.push({
    id: "failed",
    level: "error",
    message: "[source-server:restart] restart failed",
    timestamp: "16:22:09",
  });
  view.rerender(
    createElement(RemoteConnectionConnectingStep, {
      ...props,
      loading: false,
      errorMessage: "restart failed",
      logs: [...logs],
    }),
  );
  expect(screen.getByText("restart failed")).toBeTruthy();
  expect(within(screen.getByRole("list")).queryByText("remote.phaseSub.readyOnline")).toBeNull();
});

it("连接反馈只附带当前可见日志，不自动上传全量诊断文件", async () => {
  render(
    createElement(RemoteConnectionConnectingStep, {
      kind: "ssh",
      loading: false,
      errorMessage: "连接失败",
      onBack() {},
      onRetry() {},
      logs: [{ id: "1", level: "error", message: "safe connection log", timestamp: "12:00:00" }],
    }),
  );
  fireEvent.click(screen.getByText("remoteConnection.feedback"));
  await waitFor(() =>
    expect(useFeedbackStore.getState().submitDraft?.description).toContain("safe connection log"),
  );
  expect(useFeedbackStore.getState().submitDraft?.includeLogs).toBe(false);
});

it("shows download progress and speed inside the installation stage with collapsed logs", () => {
  render(
    createElement(RemoteConnectionConnectingStep, {
      kind: "ssh",
      target: { kind: "ssh", host: "build", username: "dev" },
      recognizedDeviceName: "Build device",
      loading: true,
      errorMessage: "",
      onBack() {},
      onRetry() {},
      logs: [
        {
          id: "download",
          level: "info",
          message: "[source-server:download] download progress: 25.0% (20.0/80.0 MB, 4.00 MB/s)",
          timestamp: "12:00:01",
        },
      ],
    }),
  );
  expect(screen.getByText("Build device")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  expect(screen.getByText(/4.00 MB\/s/).closest("li")).not.toBeNull();
  expect(screen.getByText(/remote.transferTimeRemaining/)).toBeTruthy();
  expect(screen.queryByTestId("remote-connection-log")).toBeNull();
  expect(screen.queryByText("remote.phase.ready")).toBeNull();
});

it("keeps completed stage durations and advances the active stage elapsed time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:10"));
  try {
    render(
      createElement(RemoteConnectionConnectingStep, {
        kind: "wsl",
        loading: true,
        errorMessage: "",
        onBack() {},
        onRetry() {},
        logs: [
          {
            id: "probe",
            level: "info",
            message: "[source-server:probe] start",
            timestamp: "12:00:00",
          },
          {
            id: "deploy",
            level: "info",
            message: "[source-server:upload] 25%",
            timestamp: "12:00:03",
          },
        ],
      }),
    );
    expect(screen.getByText("3 s")).toBeTruthy();
    expect(screen.getByText("7 s")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["2026-09-29T12:00:00.800", "2026-09-29T12:00:01.100", "12:00:01"],
  ["2026-09-29T23:59:59.800", "2026-09-30T00:00:00.100", "00:00:00"],
])(
  "does not turn a new cross-second log into a one-day duration: %s",
  (before, after, timestamp) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(before));
    try {
      const props = {
        kind: "ssh" as const,
        loading: true,
        errorMessage: "",
        onBack() {},
        onRetry() {},
      };
      const view = render(createElement(RemoteConnectionConnectingStep, { ...props, logs: [] }));
      vi.setSystemTime(new Date(after));
      view.rerender(
        createElement(RemoteConnectionConnectingStep, {
          ...props,
          logs: [{ id: "1", level: "info", message: "[source-server:probe] start", timestamp }],
        }),
      );
      expect(screen.queryByText(/86399/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("安装完成标记不再倒退成正在校验文件", () => {
  render(
    createElement(RemoteConnectionConnectingStep, {
      kind: "ssh",
      loading: true,
      errorMessage: "",
      onBack() {},
      onRetry() {},
      logs: [
        {
          id: "installed",
          level: "info",
          message: "[source-server:install] Source Server 3.8.0 installed",
          timestamp: "12:00:00",
        },
      ],
    }),
  );
  expect(screen.getByText("remote.phaseSub.installed")).toBeTruthy();
  expect(screen.queryByText("remote.phaseSub.verifyingFiles")).toBeNull();
});
