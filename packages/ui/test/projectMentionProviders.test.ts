// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor, ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useSessionsMentionProvider } from "@/mentions/providers/sessionsMentionProvider.js";
import { useFileMentionProvider } from "@/mentions/providers/fileMentionProvider.js";

const scope = vi.hoisted(() => ({ services: null as unknown as IServiceAccessor }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => scope.services,
  useWorkspaceServicesResolution: () => ({
    services: scope.services,
    remoteSessionId: null,
    isRemoteTarget: false,
  }),
}));
let events: Emitter<{ channel: string }>;
let tree: ProjectTree;
let readTree: ReturnType<typeof vi.fn>;
let listFiles: ReturnType<typeof vi.fn>;
let resolveDirectories: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
const project = (id: string, roots = ["/cwd"]): VirtualProject => ({
  id,
  hostId: "owner",
  name: `Project ${id}`,
  nameOverridden: false,
  roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
  position: 0,
  pinned: false,
  deleted: false,
  createdAt: 1,
  updatedAt: 1,
});
const task = (
  taskId: string,
  projectId: string | null,
  overrides: Partial<ProjectTask> = {},
): ProjectTask => ({
  taskId,
  traceId: taskId,
  title: taskId,
  hostId: "owner",
  projectId,
  workspacePath: "/unopened",
  pinned: false,
  archived: false,
  mode: "default",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    ServiceProvider,
    { services: scope.services },
    createElement(TabStoreProvider, null, children),
  );
beforeEach(() => {
  events = new Emitter();
  tree = {
    projects: [project("p"), project("q")],
    tasks: [task("unopened", "p"), task("unclassified", null)],
  };
  readTree = vi.fn(async () => tree);
  prepare = vi.fn();
  resolveDirectories = vi.fn(async () => ({
    workspacePath: "/cwd",
    additionalDirectories: ["/second"],
    projectId: "p",
  }));
  listFiles = vi.fn(async ({ rootPath }: { rootPath: string }) => [
    {
      name: "same.ts",
      relativePath: "src/same.ts",
      path: `${rootPath}/src/same.ts`,
      type: "file",
    },
  ]);
  scope.services = {
    projectService: {
      readTree,
      readProjects: vi.fn(async () => tree.projects),
      resolveSessionDirectories: resolveDirectories,
      prepareSession: prepare,
    },
    fileService: { searchWorkspaceFiles: listFiles },
    broadcastService: { onMessage: events.event },
  } as unknown as IServiceAccessor;
});
afterEach(() => {
  cleanup();
  events.dispose();
  vi.clearAllMocks();
});
const sessions = (query = "", workspaceScope = "same-authority-workspaces" as const) =>
  useSessionsMentionProvider(
    "glm",
    "/cwd",
    undefined,
    query,
    true,
    workspaceScope,
    "Empty",
    "Sessions",
    "Tasks",
  );

it("# reads unopened tasks from the current Host and groups by project including unclassified", async () => {
  tree.projects[0]!.deleted = true;
  const { result } = renderHook(() => sessions(), { wrapper });
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(readTree).toHaveBeenCalledWith({ includeDeleted: true });
  expect(
    result.current.groups?.map((group) => [group.title, group.items.map((item) => item.value)]),
  ).toEqual([
    ["Project p", ["unopened"]],
    ["Tasks", ["unclassified"]],
  ]);
});

it("# searches before limiting each project, so unopened older results remain findable", async () => {
  tree.tasks = [
    ...Array.from({ length: 21 }, (_, i) => task(`p${i}`, "p", { updatedAt: 100 - i })),
    ...Array.from({ length: 21 }, (_, i) => task(`q${i}`, "q", { updatedAt: 100 - i })),
  ];
  const { result, rerender } = renderHook(({ query }) => sessions(query), {
    wrapper,
    initialProps: { query: "" },
  });
  await waitFor(() => expect(result.current.items).toHaveLength(40));
  rerender({ query: "q20" });
  await waitFor(() => expect(result.current.items.map((item) => item.value)).toEqual(["q20"]));
});

it("@ session candidates keep workspace identity isolation even when physical paths match", async () => {
  tree.tasks = [
    task("local", "p", { workspacePath: "/cwd" }),
    task("foreign", "p", { workspacePath: "/cwd", workspaceIdentity: "remote:server:r:/cwd" }),
  ];
  const { result } = renderHook(
    () =>
      useSessionsMentionProvider(
        "glm",
        "/cwd",
        undefined,
        "",
        true,
        "current-workspace",
        "Empty",
        "Sessions",
      ),
    { wrapper },
  );
  await waitFor(() => expect(result.current.items.map((item) => item.value)).toEqual(["local"]));
});

it("project refresh discards an earlier response that would restore a moved task", async () => {
  let resolveOld!: (value: ProjectTree) => void;
  readTree.mockImplementationOnce(
    () =>
      new Promise<ProjectTree>((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { result } = renderHook(() => sessions(), { wrapper });
  await waitFor(() => expect(readTree).toHaveBeenCalledOnce());
  act(() => events.fire({ channel: "state:projects" }));
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  await act(async () => resolveOld({ projects: [], tasks: [] }));
  expect(result.current.items).toHaveLength(2);
});

it("closed session mention does not read projects or start an Agent", () => {
  const { result } = renderHook(
    () =>
      useSessionsMentionProvider(
        "glm",
        "/cwd",
        undefined,
        "",
        false,
        "same-authority-workspaces",
        "Empty",
        "Sessions",
      ),
    { wrapper },
  );
  expect(result.current.items).toEqual([]);
  expect(readTree).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it("@ includes every selected project root without colliding equal relative paths", async () => {
  tree.projects = [project("p", ["/cwd", "/second", "/cwd"])];
  const { result } = renderHook(
    () =>
      useFileMentionProvider("/cwd", undefined, "same", true, "Empty", "Files", 20, {
        projectId: "p",
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(listFiles).toHaveBeenCalledTimes(2);
  const items = result.current.items;
  expect(new Set(items.map((item) => item.id)).size).toBe(2);
  expect(items.map((item) => item.data?.relativePath)).toEqual(["src/same.ts", "src/same.ts"]);
  expect(items.map((item) => item.data?.rootName)).toEqual(["cwd", "second"]);
  expect(items.map((item) => item.markdown)).toEqual([
    "[same.ts](./src/same.ts)",
    "[same.ts](/second/src/same.ts)",
  ]);
  expect(prepare).not.toHaveBeenCalled();
});

it("existing task uses its immutable cwd and resolved extra roots after project roots change", async () => {
  tree.projects = [project("p", ["/second"])];
  const { result } = renderHook(
    () =>
      useFileMentionProvider("/cwd", undefined, "same", true, "Empty", "Files", 20, {
        sessionId: "old",
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(resolveDirectories).toHaveBeenCalledWith({ taskId: "old", workspacePath: "/cwd" });
  expect(listFiles.mock.calls.map(([input]) => input.rootPath)).toEqual(["/cwd", "/second"]);
  expect(prepare).not.toHaveBeenCalled();
});

it("project read failure is visible and does not silently search cwd or loop retry", async () => {
  resolveDirectories.mockRejectedValue(new Error("missing project"));
  const { result, rerender } = renderHook(
    ({ query }) =>
      useFileMentionProvider("/cwd", undefined, query, true, "Empty", "Files", 20, {
        sessionId: "old",
      }),
    { wrapper, initialProps: { query: "same" } },
  );
  await waitFor(() => expect(result.current.error?.message).toBe("missing project"));
  rerender({ query: "changed" });
  expect(resolveDirectories).toHaveBeenCalledOnce();
  expect(listFiles).not.toHaveBeenCalled();
});
