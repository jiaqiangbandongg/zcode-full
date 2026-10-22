// @vitest-environment jsdom
import { createElement, memo } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import {
  ProjectDirectoryProvider,
  useProjectDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
const { read, deviceNames } = vi.hoisted(() => ({ read: vi.fn(), deviceNames: new Map() }));
vi.mock("@/project-sidebar/useProjectTree.js", () => ({ useProjectTree: read }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ broadcastService: { onMessage: () => ({ dispose() {} }) } }),
}));
vi.mock("@/hooks/useSourceServerDisplayNames.js", () => ({
  useSourceServerDisplayNames: () => deviceNames,
}));
afterEach(cleanup);
it("SBV04：两个消费者共用目录，视图切换不改变手动项目顺序", () => {
  localStorage.clear();
  const base = {
    hostId: "local",
    name: "name",
    roots: [],
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    nameOverridden: false,
  };
  const tree: ProjectTree = {
    projects: [
      { ...base, id: "one", position: 1 },
      { ...base, id: "two", position: 2 },
      { ...base, id: "pin", position: 3, pinned: true },
    ],
    tasks: [{ taskId: "t", projectId: "two", hostId: "local", updatedAt: 10 } as never],
  };
  read.mockReturnValue({ tree, factTree: tree });
  function Consumer({ name }: { name: string }) {
    const { projects, preferences } = useProjectDirectory();
    return createElement(
      "button",
      { onClick: () => preferences.setView("timeline"), "data-testid": name },
      projects.map((p) => p.id).join(","),
    );
  }
  render(
    createElement(
      ProjectDirectoryProvider,
      null,
      createElement(Consumer, { name: "sidebar" }),
      createElement(ProjectDirectoryProvider, null, createElement(Consumer, { name: "composer" })),
    ),
  );
  expect(read).toHaveBeenCalledOnce();
  expect(screen.getByTestId("composer").textContent).toBe("pin,one,two");
  fireEvent.click(screen.getByTestId("sidebar"));
  expect(screen.getByTestId("composer").textContent).toBe("pin,one,two");
  expect(screen.getByTestId("sidebar").textContent).toBe("pin,one,two");
});

it("父级草稿更新不广播等价目录，项目改名仍更新消费者", () => {
  localStorage.clear();
  const tree: ProjectTree = {
    projects: [
      {
        id: "one",
        hostId: "local",
        name: "Before",
        roots: [],
        pinned: false,
        deleted: false,
        position: 1,
        createdAt: 1,
        updatedAt: 1,
        nameOverridden: true,
      },
    ],
    tasks: [],
  };
  read.mockReturnValue({ tree, factTree: tree });
  const observed = vi.fn();
  const Consumer = memo(function Consumer() {
    const { projects } = useProjectDirectory();
    observed(projects);
    return createElement("span", null, projects.map((project) => project.name).join(","));
  });
  const view = render(createElement(ProjectDirectoryProvider, null, createElement(Consumer)));
  observed.mockClear();
  view.rerender(createElement(ProjectDirectoryProvider, null, createElement(Consumer)));
  expect(observed).not.toHaveBeenCalled();
  const renamed = { ...tree, projects: [{ ...tree.projects[0]!, name: "After" }] };
  read.mockReturnValue({ tree: renamed, factTree: renamed });
  view.rerender(createElement(ProjectDirectoryProvider, null, createElement(Consumer)));
  expect(screen.getByText("After")).toBeTruthy();
  expect(observed).toHaveBeenCalled();
});
