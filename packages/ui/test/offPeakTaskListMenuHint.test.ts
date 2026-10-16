// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeOffPeakTask, ZCodeOffPeakTaskStatus } from "@zcode/shared";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";

const tooltipCalls = vi.hoisted(
  () =>
    [] as Array<{
      className?: string;
      side?: string;
      sideOffset?: number;
      title: string;
    }>,
);

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    side?: string;
    sideOffset?: number;
    title: string;
  }) => {
    tooltipCalls.push(props);
    return createElement("span", { "data-testid": `hint-${props.title}` }, children);
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => createElement("div", { ...props, onClick: onSelect }, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function createTask(status: ZCodeOffPeakTaskStatus): ZCodeOffPeakTask {
  return {
    offPeakTaskId: `task-${status}`,
    title: `Task ${status}`,
    prompt: "Test prompt",
    permissionMode: "default",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    status,
    queuedAt: 100,
    createdAt: 100,
    updatedAt: 100,
  };
}

function renderTask(
  status: "queued" | "paused",
  overrides: {
    onContinue?: ReturnType<typeof vi.fn>;
    onPause?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onPause = overrides.onPause ?? vi.fn();
  const onContinue = overrides.onContinue ?? vi.fn();

  render(
    createElement(OffPeakTaskList, {
      tasks: [createTask(status)],
      busyOperationId: null,
      onOpen: vi.fn(),
      onPause,
      onContinue,
      onCancel: vi.fn(),
      onDelete: vi.fn(),
      onOpenSession: vi.fn(),
    }),
  );

  return { onContinue, onPause };
}

afterEach(() => {
  cleanup();
  tooltipCalls.length = 0;
});

describe("OffPeakTaskList menu hints", () => {
  it.each([
    {
      action: "pause",
      hintId: "offPeak.action.pauseHint",
      status: "queued",
    },
    {
      action: "continue",
      hintId: "offPeak.action.continueHint",
      status: "paused",
    },
  ] as const)(
    "keeps the $action hint local and does not trigger the menu action",
    ({ action: _action, hintId, status }) => {
      const onPause = vi.fn();
      const onContinue = vi.fn();
      renderTask(status, { onContinue, onPause });

      const hint = screen.getByTestId(`hint-${hintId}`);
      const trigger = hint.firstElementChild;
      expect(trigger).not.toBeNull();
      fireEvent.click(trigger as Element);

      expect(onPause).not.toHaveBeenCalled();
      expect(onContinue).not.toHaveBeenCalled();
      expect(tooltipCalls).toContainEqual(
        expect.objectContaining({
          className: "max-w-[min(20rem,calc(100vw-1rem))]",
          side: "right",
          sideOffset: 16,
          title: hintId,
        }),
      );
    },
  );
});
