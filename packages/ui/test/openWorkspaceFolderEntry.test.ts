import { describe, expect, it, vi } from "vitest";
import { openFolderFromWorkspaceEntry } from "../src/root/openWorkspaceFolderEntry.js";

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("openFolderFromWorkspaceEntry", () => {
  it("opens the service directory browser when preferred", async () => {
    const selectDirectory = vi.fn(async () => "/native/project");
    const openDirectoryBrowser = vi.fn();
    const onSelectProject = vi.fn();

    await openFolderFromWorkspaceEntry({
      preferDirectoryBrowser: true,
      openDirectoryBrowser,
      selectDirectory,
      onSelectProject,
    });

    expect(openDirectoryBrowser).toHaveBeenCalledTimes(1);
    expect(selectDirectory).not.toHaveBeenCalled();
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("uses the platform directory picker when service browsing is not preferred", async () => {
    const selectDirectory = vi.fn(async () => "/native/project");
    const openDirectoryBrowser = vi.fn();
    const onSelectProject = vi.fn();

    await openFolderFromWorkspaceEntry({
      preferDirectoryBrowser: false,
      openDirectoryBrowser,
      selectDirectory,
      onSelectProject,
    });

    expect(openDirectoryBrowser).not.toHaveBeenCalled();
    expect(selectDirectory).toHaveBeenCalledTimes(1);
    expect(onSelectProject).toHaveBeenCalledWith("/native/project");
  });
});
