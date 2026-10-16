import { describe, expect, it } from "vitest";
import { formatWorkspaceContextPath } from "@/WorkspaceHeaderSections/workspaceContextPathFormat.js";

describe("workspace context path", () => {
  it("abbreviates only the supplied host home and its descendants", () => {
    expect(formatWorkspaceContextPath("/Users/a/Projects/z-code", "/Users/a")).toBe(
      "~/Projects/z-code",
    );
    expect(formatWorkspaceContextPath("/Users/a", "/Users/a/")).toBe("~");
    expect(formatWorkspaceContextPath("/Users/another/project", "/Users/a")).toBe(
      "/Users/another/project",
    );
  });
  it("preserves paths before host information is available", () => {
    expect(formatWorkspaceContextPath("/remote/project")).toBe("/remote/project");
  });
  it("supports Windows host paths", () => {
    expect(formatWorkspaceContextPath("C:\\Users\\a\\project", "C:\\Users\\a")).toBe("~/project");
  });
});
