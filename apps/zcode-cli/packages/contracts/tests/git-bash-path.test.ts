import { describe, expect, it } from "vitest";
import { gitBashPathToWindowsPath, windowsPathToGitBashPath } from "../src/path/git-bash.js";

describe("Git Bash path helpers", () => {
  it("converts Windows and Git Bash paths in both directions", () => {
    expect(windowsPathToGitBashPath("C:\\repo\\sub")).toBe("/c/repo/sub");
    expect(windowsPathToGitBashPath("C:/repo/sub")).toBe("/c/repo/sub");
    expect(windowsPathToGitBashPath("C:repo\\sub")).toBe("C:repo/sub");
    expect(windowsPathToGitBashPath("\\\\server\\share\\repo")).toBe("//server/share/repo");
    expect(gitBashPathToWindowsPath("/c/repo/sub")).toBe("C:\\repo\\sub");
    expect(gitBashPathToWindowsPath("/cygdrive/d/repo")).toBe("D:\\repo");
    expect(gitBashPathToWindowsPath("//server/share/repo")).toBe("\\\\server\\share\\repo");
  });
});
