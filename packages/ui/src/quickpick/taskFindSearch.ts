import type { ZCodeTaskMeta } from "@zcode/shared";
import { formatTaskChangedFileLabel } from "@/lib/taskChangeSummary.js";

type TaskFindScope = "conversation" | "changes";

interface TaskFindEntry {
  task: ZCodeTaskMeta;
  searchText: string;
}

interface TaskFindState {
  matches: TaskFindEntry[];
  activeTaskId: string | null;
  currentIndex: number;
  total: number;
}

function normalizeTaskFindText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getTaskChangeSearchText(task: ZCodeTaskMeta): string {
  const summary = task.changeSummary;
  if (!summary || summary.files.length === 0) {
    return "";
  }

  return summary.files
    .map((file) => formatTaskChangedFileLabel(task.workspacePath, file))
    .join(" ");
}

export function createTaskFindEntries(
  tasks: readonly ZCodeTaskMeta[],
  scope: TaskFindScope,
): TaskFindEntry[] {
  return tasks.map((task) => ({
    task,
    searchText: [
      scope === "conversation"
        ? [task.title, task.taskId, task.workspacePath].join(" ")
        : getTaskChangeSearchText(task),
    ]
      .join(" ")
      .toLocaleLowerCase(),
  }));
}

export function getTaskFindState(
  entries: readonly TaskFindEntry[],
  query: string,
  preferredTaskId: string | null,
): TaskFindState {
  const normalizedQuery = normalizeTaskFindText(query);
  const matches = normalizedQuery
    ? entries.filter((entry) => entry.searchText.includes(normalizedQuery))
    : [];
  const preferredIndex = preferredTaskId
    ? matches.findIndex((entry) => entry.task.taskId === preferredTaskId)
    : -1;
  const currentIndex = matches.length === 0 ? -1 : Math.max(0, preferredIndex);

  return {
    matches,
    activeTaskId: currentIndex === -1 ? null : matches[currentIndex]?.task.taskId ?? null,
    currentIndex,
    total: matches.length,
  };
}

export function moveTaskFindSelection(
  state: TaskFindState,
  direction: "previous" | "next",
): string | null {
  if (state.total === 0 || state.currentIndex < 0) {
    return null;
  }

  const delta = direction === "next" ? 1 : -1;
  const nextIndex = (state.currentIndex + delta + state.total) % state.total;
  return state.matches[nextIndex]?.task.taskId ?? null;
}
