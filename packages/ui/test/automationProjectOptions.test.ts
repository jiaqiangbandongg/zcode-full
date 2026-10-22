// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualProject } from "@zcode/services";
import {
  resolveAutomationProjectOptions,
  useAutomationProjectOptions,
} from "@/hooks/useAutomationProjectOptions.js";
const service = vi.hoisted(() => ({
  readProjects: vi.fn(),
  readTree: vi.fn(async () => {
    throw new Error("task query forbidden");
  }),
  onMessage: () => ({ dispose() {} }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => services,
}));
const services = { projectService: service, broadcastService: { onMessage: service.onMessage } };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const project = (
  id: string,
  roots: string[] = [],
  extra: Partial<VirtualProject> = {},
): VirtualProject => ({
  id,
  hostId: "local",
  name: id,
  roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
  deleted: false,
  pinned: false,
  nameOverridden: true,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
describe("automation virtual project options", () => {
  it("opening the project selector reads directories without querying tasks or auto-archiving", async () => {
    service.readProjects.mockResolvedValue([project("p", ["/unopened"])]);
    const { result } = renderHook(useAutomationProjectOptions);
    await waitFor(() => expect(result.current.map((option) => option.projectId)).toEqual(["p"]));
    expect(service.readProjects).toHaveBeenCalledOnce();
    expect(service.readTree).not.toHaveBeenCalled();
  });
  it("keeps empty projects and overlapping roots as distinct choices without open tabs", () => {
    expect(
      resolveAutomationProjectOptions([
        project("empty"),
        project("a", ["/same", "/extra"]),
        project("b", ["/same"]),
      ]),
    ).toEqual([
      { projectId: "empty", hostId: "local", workspacePath: "", label: "empty" },
      { projectId: "a", hostId: "local", workspacePath: "/same", label: "a" },
      { projectId: "b", hostId: "local", workspacePath: "/same", label: "b" },
    ]);
  });
  it("excludes deleted projects and remote entries from local scheduling", () => {
    expect(
      resolveAutomationProjectOptions([
        project("deleted", [], { deleted: true }),
        project("remote", [], { hostId: "remote:server:s" }),
      ]),
    ).toEqual([]);
  });
});
