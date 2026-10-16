import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@zcode/shared";
import {
  hasRunningWorkspaceChat,
  isWindowsReservedDevicePathSegment,
  scanWindowsReservedDeviceNameFiles,
} from "@/lib/workspaceRemovalSafety.js";

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function createFileEntry(name: string, path: string, type: "file" | "directory" = "file"): FileEntry {
  return { name, path, type };
}

describe("workspaceRemovalSafety", () => {
  it("detects running draft or task runtime before workspace removal", () => {
    expect(
      hasRunningWorkspaceChat({
        workspaceState: {
          draftRuntime: { status: "streaming", error: null },
          taskRuntimeByTaskId: {},
        },
        taskItems: [],
      }),
    ).toBe(true);

    expect(
      hasRunningWorkspaceChat({
        workspaceState: {
          draftRuntime: { status: "idle", error: null },
          taskRuntimeByTaskId: {
            task_1: {
              status: "creating",
              error: null,
              contextWindow: null,
              usage: null,
              apiRetry: null,
              backgroundTaskControls: [],
            },
          },
        },
        taskItems: [{ taskId: "task_1" }],
      }),
    ).toBe(true);

    expect(
      hasRunningWorkspaceChat({
        workspaceState: {
          draftRuntime: { status: "idle", error: null },
          taskRuntimeByTaskId: {
            task_1: {
              status: "completed",
              error: null,
              contextWindow: null,
              usage: null,
              apiRetry: null,
              backgroundTaskControls: [],
            },
          },
        },
        taskItems: [{ taskId: "task_1" }],
      }),
    ).toBe(false);
  });

  it("detects Windows reserved device names including extension variants", () => {
    expect(isWindowsReservedDevicePathSegment("nul")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("NUL")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("nul.txt")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("con.md")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("aux.log")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("COM1.json")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("LPT9.tmp")).toBe(true);
    expect(isWindowsReservedDevicePathSegment("normal-null.txt")).toBe(false);
    expect(isWindowsReservedDevicePathSegment("component.tsx")).toBe(false);
  });

  it("scans workspace files, reports reserved names, and skips low relevance directories", async () => {
    const readdir = vi.fn(async ({ path }: { path: string }) => {
      const entriesByPath: Record<string, FileEntry[]> = {
        "C:/repo": [
          createFileEntry("src", "C:/repo/src", "directory"),
          createFileEntry("node_modules", "C:/repo/node_modules", "directory"),
          createFileEntry(".git", "C:/repo/.git", "directory"),
        ],
        "C:/repo/src": [
          createFileEntry("nul", "C:/repo/src/nul"),
          createFileEntry("COM1.json", "C:/repo/src/COM1.json"),
        ],
        "C:/repo/node_modules": [createFileEntry("con", "C:/repo/node_modules/con")],
        "C:/repo/.git": [createFileEntry("aux", "C:/repo/.git/aux")],
      };
      return entriesByPath[path] ?? [];
    });

    const result = await scanWindowsReservedDeviceNameFiles({ readdir }, "C:/repo");

    expect(result.findings).toEqual(["C:/repo/src/nul", "C:/repo/src/COM1.json"]);
    expect(result.truncated).toBe(false);
    expect(readdir).toHaveBeenCalledWith({ path: "C:/repo", includeHidden: true });
    expect(readdir).toHaveBeenCalledWith({ path: "C:/repo/src", includeHidden: true });
    expect(readdir).not.toHaveBeenCalledWith({ path: "C:/repo/node_modules", includeHidden: true });
    expect(readdir).not.toHaveBeenCalledWith({ path: "C:/repo/.git", includeHidden: true });
  });

  it("limits reserved-name scan findings without throwing", async () => {
    const readdir = vi.fn(async () => [
      createFileEntry("nul", "C:/repo/nul"),
      createFileEntry("con", "C:/repo/con"),
    ]);

    const result = await scanWindowsReservedDeviceNameFiles({ readdir }, "C:/repo", {
      maxFindings: 1,
    });

    expect(result.findings).toEqual(["C:/repo/nul"]);
    expect(result.truncated).toBe(true);
  });
});
