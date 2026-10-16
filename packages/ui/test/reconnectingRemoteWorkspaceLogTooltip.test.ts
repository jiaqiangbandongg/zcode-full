import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: unknown }) => createElement("div", null, children),
  Tooltip: ({ children }: { children: unknown }) => createElement("div", null, children),
  TooltipTrigger: ({ children }: { children: unknown }) => createElement("div", null, children),
  TooltipContent: ({
    children,
    side,
    className,
  }: {
    children: unknown;
    side?: string;
    className?: string;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "tooltip-content",
        "data-side": side,
        className,
      },
      children,
    ),
}));

import {
  ReconnectingRemoteWorkspaceLogTooltip,
  scheduleRemoteConnectionLogsScrollToLatest,
  scrollRemoteConnectionLogsToLatest,
} from "@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js";

describe("ReconnectingRemoteWorkspaceLogTooltip", () => {
  it("renders reconnect logs tooltip on the right side", () => {
    const html = renderToStaticMarkup(
      createElement(ReconnectingRemoteWorkspaceLogTooltip, {
        logs: [
          {
            id: "log-1",
            level: "info",
            timestamp: "10:00:00",
            message: "connecting...",
          },
        ],
      }),
    );

    expect(html).toContain('data-side="right"');
  });

  it("breaks very long log messages inside tooltip", () => {
    const longMessage = `download-progress-${"x".repeat(240)}`;

    const html = renderToStaticMarkup(
      createElement(ReconnectingRemoteWorkspaceLogTooltip, {
        logs: [
          {
            id: "log-2",
            level: "info",
            timestamp: "10:00:01",
            message: longMessage,
          },
        ],
      }),
    );

    expect(html).toContain("break-all");
    expect(html).toContain(longMessage);
  });

  it("scrolls the log viewport to the latest line", () => {
    const viewport = {
      scrollHeight: 240,
      scrollTop: 0,
    };

    scrollRemoteConnectionLogsToLatest(viewport);

    expect(viewport.scrollTop).toBe(240);
  });

  it("schedules scroll when the tooltip log viewport is mounted", () => {
    const viewport = {
      scrollHeight: 320,
      scrollTop: 0,
    };
    const scheduledCallbacks: Array<() => void> = [];

    const cancel = scheduleRemoteConnectionLogsScrollToLatest(
      viewport,
      (callback) => {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      },
      () => {},
    );

    expect(viewport.scrollTop).toBe(320);

    viewport.scrollTop = 0;
    scheduledCallbacks.forEach((callback) => callback());
    expect(viewport.scrollTop).toBe(320);

    cancel();
  });
});
