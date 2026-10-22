import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  MemoTaskItem,
  shouldShowRemoteConnectionOverlay,
} from "@/TaskListItem.js";

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskProvider: "codex",
    taskSessionFile: { loading: false, path: null, exists: false },
    taskNativeSessionLogFile: { loading: false, path: null, exists: false },
    providerConfigFile: { loading: false, path: null, exists: false },
    fileManagerLabel: "Open in Finder",
    handleCopyText: async () => {},
    handleOpenTaskPathInFileManager: async () => {},
    handleOpenProviderConfig: async () => {},
  }),
}));

function renderRemoteTask(variant: "default" | "timeline") {
  const task: ZCodeTaskMeta = {
    taskId: "remote-task",
    traceId: "remote-trace",
    title: "Remote task",
    workspacePath: "/home/dev/.zcode/workspace/default",
    workspaceIdentity:
      "remote:server:source-1:/home/dev/.zcode/workspace/default",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
  };
  return renderToStaticMarkup(
    createElement(MemoTaskItem, {
      workspacePath: task.workspacePath,
      task,
      isPinned: false,
      isActive: false,
      connectionOverlay: "disconnected",
      onSelectTask: () => {},
      onArchiveTaskInline: () => {},
      onCancelArchiveConfirm: () => {},
      isArchiveConfirming: false,
      onTogglePinTask: () => {},
      onStartRenameTask: () => {},
      onArchiveTask: () => {},
      onMarkTaskAsUnread: () => {},
      variant,
      intl: {
        formatMessage: ({ id }: { id: string }) => id,
      },
    }),
  );
}

describe("TaskListItem remote connection overlay", () => {
  it("only overlays remote tasks with a disconnected/reconnecting workspace", () => {
    expect(
      shouldShowRemoteConnectionOverlay({
        workspaceIdentity: "remote:server:source-1:/workspace",
        connectionOverlay: "disconnected",
      }),
    ).toBe(true);
    expect(
      shouldShowRemoteConnectionOverlay({
        workspaceIdentity: "/local/project",
        connectionOverlay: "disconnected",
      }),
    ).toBe(false);
    expect(
      shouldShowRemoteConnectionOverlay({
        workspaceIdentity: "remote:server:source-1:/workspace",
      }),
    ).toBe(false);
  });

  it.each(["default", "timeline"] as const)(
    "renders the disconnected overlay in the %s row layout",
    (variant) => {
      const html = renderRemoteTask(variant);

      expect(html).toContain('data-remote-connection-overlay="true"');
      expect(html).toContain("taskList.remoteConnectionUnknown");
    },
  );
});
