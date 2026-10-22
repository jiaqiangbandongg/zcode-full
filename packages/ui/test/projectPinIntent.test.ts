// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import type { ProjectTree } from "@/project-sidebar/contract.js";
const tree: ProjectTree = {
  projects: [],
  tasks: [
    {
      taskId: "a",
      workspacePath: "/repo",
      hostId: "local",
      projectId: null,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      title: "a",
      mode: "default",
      traceId: "a",
    },
  ],
};
it("shows a pin intent while command and authoritative refresh are still pending", async () => {
  let done!: () => void;
  let refreshed!: () => void;
  const refresh = new Promise<void>((resolve) => {
    refreshed = resolve;
  });
  const { result, rerender } = renderHook(useProjectPinIntent, { initialProps: tree });
  let command!: Promise<void>;
  act(() => {
    command = result.current.pin(tree.tasks[0]!, true, async () => {
      await new Promise<void>((resolve) => {
        done = resolve;
      });
      await refresh;
    });
  });
  expect(result.current.tree.tasks[0]!.pinned).toBe(true);
  expect(tree.tasks[0]!.pinned).toBe(false);
  await act(async () => {
    done();
  });
  rerender({ ...tree });
  expect(result.current.tree.tasks[0]!.pinned).toBe(true);
  rerender({ ...tree, tasks: [{ ...tree.tasks[0]!, pinned: true }] });
  await act(async () => {
    refreshed();
    await command;
  });
  rerender(tree);
  expect(result.current.tree.tasks[0]!.pinned).toBe(false);
});
it("rolls back a failed intent without changing another Host at the same path", async () => {
  const remote = {
    ...tree.tasks[0]!,
    workspaceIdentity: "remote:server:s:/repo",
    hostId: "remote:server:s",
  };
  const { result } = renderHook(() =>
    useProjectPinIntent({ ...tree, tasks: [...tree.tasks, remote] }),
  );
  let reject!: (cause: Error) => void;
  let command!: Promise<void>;
  act(() => {
    command = result.current.pin(
      remote,
      true,
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
  });
  expect(result.current.tree.tasks.map((t) => t.pinned)).toEqual([false, true]);
  await act(async () => {
    reject(new Error("offline"));
    await expect(command).rejects.toThrow("offline");
  });
  expect(result.current.tree.tasks.map((t) => t.pinned)).toEqual([false, false]);
});

it("keeps snapshot-before-ACK single flight and releases it after acknowledgement", async () => {
  const { result, rerender } = renderHook(useProjectPinIntent, { initialProps: tree });
  let acknowledge!: () => void;
  let command!: Promise<void>;
  act(() => {
    command = result.current.pin(
      tree.tasks[0]!,
      true,
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
  });
  const pinned = { ...tree, tasks: [{ ...tree.tasks[0]!, pinned: true }] };
  rerender(pinned);
  const duplicate = vi.fn();
  await act(() => result.current.pin(pinned.tasks[0]!, false, duplicate));
  expect(duplicate).not.toHaveBeenCalled();
  await act(async () => {
    acknowledge();
    await command;
  });
  const next = vi.fn(async () => undefined);
  await act(() => result.current.pin(pinned.tasks[0]!, false, next));
  expect(next).toHaveBeenCalledTimes(1);
});

it("releases the intent even when another client supersedes it before the final refresh", async () => {
  const { result } = renderHook(useProjectPinIntent, { initialProps: tree });
  await act(() =>
    result.current.pin(tree.tasks[0]!, true, async () => {
      // Host 已处理 pin，但另一端随后 unpin，最新权威查询仍为 false；不能等待值相等而永久遮蔽事实。
    }),
  );
  expect(result.current.tree.tasks[0]!.pinned).toBe(false);
});
