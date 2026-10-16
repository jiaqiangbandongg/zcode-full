// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type {
  IServiceAccessor,
  IWindowControllerService,
  WindowHostControllerFrame,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const REMOTE_IDENTITY = "remote:wsl:default:root:/root";
const REMOTE_SESSION_ID = "wsl-session-1";

function remoteTab(remoteSessionId?: string): WorkspaceTabState {
  return {
    id: "workspace-remote",
    kind: "workspace",
    label: "root",
    workspacePath: "/root",
    workspaceIdentity: REMOTE_IDENTITY,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  } as WorkspaceTabState;
}

function remoteTask(): ZCodeTaskMeta {
  return {
    taskId: "task-before-connect",
    traceId: "trace-task-before-connect",
    title: "历史任务",
    workspacePath: "/root",
    workspaceIdentity: REMOTE_IDENTITY,
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
  };
}

describe("useGlobalTaskList remote connection generation", () => {
  afterEach(() => {
    useZCodeSessionStore.setState({ workspaces: {} });
  });

  it("同一 WSL workspace 从断开占位变为在线 session 后重新查询 Controller", async () => {
    const controllerFrames = new Emitter<WindowHostControllerFrame>();
    let connected = false;
    const listTaskList = vi.fn(async () => ({
      items: connected
        ? [
            {
              ...remoteTask(),
              remoteSessionId: REMOTE_SESSION_ID,
              sourceAvailability: "online" as const,
            },
          ]
        : [],
      total: connected ? 1 : 0,
      hasMore: false,
    }));
    let subscriptionSerial = 0;
    const controller = {
      listTaskList,
      onDynamicControllerFrame: vi.fn(() => controllerFrames.event),
      subscribeControllerV4: vi.fn(async ({ topic }: { topic: string }) => ({
        ack: {
          subscriptionId: `${topic}-${++subscriptionSerial}`,
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      })),
      unsubscribeControllerV4: vi.fn(async () => undefined),
      resyncControllerV4: vi.fn(),
    } as unknown as IWindowControllerService;
    const services = { windowControllerService: controller } as unknown as IServiceAccessor;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services }, children);

    const { result, rerender, unmount } = renderHook(
      ({ workspaceTabs }: { workspaceTabs: WorkspaceTabState[] }) =>
        useGlobalTaskList({
          kind: "timeline",
          workspaceTabs,
          sortBy: "updated",
          searchQuery: "",
          expanded: true,
          collapsedLimit: 100,
        }),
      {
        initialProps: { workspaceTabs: [remoteTab()] },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(listTaskList).toHaveBeenCalledTimes(1);
      expect(result.current.items).toEqual([]);
    });

    connected = true;
    rerender({ workspaceTabs: [remoteTab(REMOTE_SESSION_ID)] });

    await waitFor(() => {
      expect(listTaskList).toHaveBeenCalledTimes(2);
      expect(result.current.items.map((task) => task.taskId)).toEqual(["task-before-connect"]);
    });

    rerender({ workspaceTabs: [remoteTab(REMOTE_SESSION_ID)] });
    await waitFor(() => {
      expect(listTaskList).toHaveBeenCalledTimes(2);
    });

    rerender({ workspaceTabs: [remoteTab("wsl-session-2")] });
    await waitFor(() => {
      expect(listTaskList).toHaveBeenCalledTimes(3);
    });

    unmount();
  });
});
