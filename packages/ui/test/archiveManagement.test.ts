// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import { buildArchiveGroups, archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import { useArchiveManagement } from "@/project-sidebar/useArchiveManagement.js";

const mocks = vi.hoisted(() => ({
  directory: {} as any,
  mutateTask: vi.fn(),
  confirm: vi.fn(),
  removeTaskState: vi.fn(),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useProjectDirectory: () => mocks.directory,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: mocks, zcodeTaskService: {} }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => mocks.confirm }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: any) => select(mocks),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: any, values: any) => `${id}:${JSON.stringify(values)}` },
  }),
}));
const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  title: id,
  traceId: id,
  workspacePath: "/same",
  hostId: "local",
  projectId: "one",
  pinned: false,
  archived: true,
  createdAt: 1,
  updatedAt: 2,
  mode: "default",
  ...extra,
});
const project = (id: string, extra = {}) => ({
  id,
  hostId: "local",
  name: `Virtual ${id}`,
  roots: [{ rootPath: "/same", isPrimary: true, position: 0 }],
  deleted: false,
  pinned: false,
  position: 0,
  nameOverridden: true,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const tree = (): ProjectTree => ({
  projects: [
    project("one"),
    project("two"),
    project("one", { hostId: "remote:server:r", name: "Remote virtual" }),
    project("deleted", { deleted: true }),
  ],
  tasks: [
    task("alpha"),
    task("beta", { projectId: "two", cronAutomationId: "cron" }),
    task("alpha", { hostId: "remote:server:r", workspaceIdentity: "remote:server:r:/same" }),
    task("orphan", { projectId: null }),
    task("old", { projectId: "deleted" }),
    task("active", { archived: false }),
  ],
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("groups by virtual identity rather than shared roots and preserves removed/unclassified archives", () => {
  const groups = buildArchiveGroups(tree());
  expect(groups.map((g) => g.tasks.length)).toEqual([1, 1, 1, 1, 1]);
  expect(new Set(groups.map((g) => g.key)).size).toBe(5);
  expect(groups.find((g) => g.project?.id === "deleted")?.project?.deleted).toBe(true);
  expect(groups.find((g) => g.project === undefined)?.tasks[0]?.taskId).toBe("orphan");
  expect(archiveTaskKey(tree().tasks[0]!)).not.toBe(archiveTaskKey(tree().tasks[2]!));
});
it("intersects title/project and switches between CLI updated and created time", () => {
  const t = tree();
  t.tasks.push(task("alpha-second", { createdAt: 9, updatedAt: 1 }));
  const before = JSON.stringify(t);
  const key = buildArchiveGroups(t).find(
    (g) => g.project?.id === "one" && g.hostId === "local",
  )!.key;
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "updated", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha", "alpha-second"]);
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "created", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha-second", "alpha"]);
  expect(JSON.stringify(t)).toBe(before);
});
it("routes archived actions with full remote identity and uses the existing local service fallback", async () => {
  const row = task("same", {
    workspaceIdentity: "remote:server:r:/same",
    hostId: "remote:server:r",
  });
  await mutateProjectTask(
    { controller: mocks, service: {} as never },
    row,
    { kind: "delete" },
    "attachment",
  );
  expect(mocks.mutateTask).toHaveBeenCalledWith({
    address: {
      taskId: "same",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:r:/same",
      remoteSessionId: "attachment",
      sourceServerId: "r",
    },
    mutation: { kind: "delete" },
  });
  const service = { unarchiveTask: vi.fn(async () => row) };
  await mutateProjectTask({ service: service as never }, task("local"), {
    kind: "archive",
    archived: false,
  });
  expect(service.unarchiveTask).toHaveBeenCalledWith({
    workspacePath: "/same",
    workspaceIdentity: undefined,
    taskId: "local",
  });
});
function setup() {
  mocks.directory = {
    tree: tree(),
    directory: { hosts: [], entries: [] },
    availability: new Map(),
    refresh: vi.fn(async () => {}),
    error: null,
    loading: false,
  };
  mocks.confirm.mockResolvedValue(true);
  mocks.mutateTask.mockResolvedValue(null);
  return renderHook(() => useArchiveManagement());
}
it("cancelled deletion does not mutate; one in-flight batch rejects duplicate clicks and preserves failures", async () => {
  const { result } = setup();
  mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.mutateTask).not.toHaveBeenCalled();
  let release!: () => void;
  mocks.mutateTask
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run(tree().tasks.slice(0, 2), "unarchive");
  });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "unarchive");
  });
  expect(mocks.mutateTask).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await pending;
  });
  expect(mocks.mutateTask).toHaveBeenCalledTimes(2);
  expect(result.current.result).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
  expect(mocks.directory.refresh).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(false);
});
it("does not expand the confirmed batch and skips rows unarchived while the dialog is open", async () => {
  const { result, rerender } = setup();
  let confirm!: (value: boolean) => void;
  mocks.confirm.mockImplementationOnce(
    () =>
      new Promise<boolean>((r) => {
        confirm = r;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run([tree().tasks[0]!], "delete");
  });
  mocks.directory = {
    ...mocks.directory,
    tree: { ...tree(), tasks: [task("alpha", { archived: false }), task("new")] },
  };
  rerender();
  await act(async () => {
    confirm(true);
    await pending;
  });
  expect(mocks.mutateTask).not.toHaveBeenCalled();
  expect(result.current.result?.skipped).toBe(1);
});
