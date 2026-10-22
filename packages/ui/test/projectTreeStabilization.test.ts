import { expect, it } from "vitest";
import { stabilizeProjectTree } from "@/project-sidebar/view.js";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

it("keeps unchanged task references while another row streams or moves between projects", () => {
  const task = {
    taskId: "same",
    workspacePath: "/same",
    projectId: "p",
    hostId: "local",
    title: "Local",
    createdAt: 1,
    updatedAt: 1,
    traceId: "t",
    mode: "default",
    pinned: false,
    archived: false,
  };
  const previous: ProjectTree = {
    projects: [],
    tasks: [
      task,
      {
        ...task,
        workspaceIdentity: "remote:server:s:/same",
        hostId: "remote:server:s",
        title: "Remote",
      },
    ],
  };
  expect(stabilizeProjectTree(previous, structuredClone(previous))).toBe(previous);
  const next = stabilizeProjectTree(previous, {
    projects: [],
    tasks: [
      { ...task },
      attachTaskListRowActivity(
        { ...previous.tasks[1]!, projectId: "moved" },
        { phase: "running", lastActivityAt: 2, hasBackgroundWork: false },
      ),
    ],
  });
  expect(next.tasks[0]).toBe(task);
  expect(next.tasks[1]).not.toBe(previous.tasks[1]);
  expect(next.tasks[1]?.projectId).toBe("moved");
  expect(stabilizeProjectTree(next, structuredClone(next))).toBe(next);
});
