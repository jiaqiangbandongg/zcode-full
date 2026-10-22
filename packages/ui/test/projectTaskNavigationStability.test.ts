// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
const focus = vi.hoisted(() => ({ activeTaskId: "original", draftFocusVersion: 0 }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: { getState: () => ({ getWorkspaceState: () => ({ ...focus }) }) },
}));
beforeEach(() => {
  focus.activeTaskId = "original";
  focus.draftFocusVersion = 0;
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: unknown) => unknown) => select({ activeWorkspaceIdentity: null }),
}));
it("keeps the row action stable across tree refreshes and uses the latest navigation callback", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(
    ({ select }) =>
      useProjectTaskNavigation({ onSelectTask: select } as unknown as ProjectSidebarProps, {
        projects: [],
        tasks: [],
      }),
    { initialProps: { select: first } },
  );
  const before = result.current;
  rerender({ select: second });
  expect(result.current).toBe(before);
  result.current("/same", "task");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("/same", "task", undefined, undefined, undefined);
});

it.each(["task", "draft"])(
  "ignores a late directory response after another %s selection in the same workspace",
  async (kind) => {
    const pending = Promise.withResolvers<{ hosts: never[] }>();
    const select = vi.fn();
    const task = {
      taskId: "remote-task",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:s:/same",
      hostId: "remote:server:s",
    };
    const { result } = renderHook(() =>
      useProjectTaskNavigation(
        { workspacePath: "/current", onSelectTask: select } as unknown as ProjectSidebarProps,
        { projects: [], tasks: [task] } as never,
        { readDirectory: () => pending.promise } as never,
      ),
    );
    await act(async () => {
      result.current(task.workspacePath, task.taskId, task.workspaceIdentity);
      if (kind === "task") focus.activeTaskId = "other";
      else focus.draftFocusVersion++;
      pending.resolve({ hosts: [] });
      await pending.promise;
    });
    expect(select).not.toHaveBeenCalled();
  },
);
