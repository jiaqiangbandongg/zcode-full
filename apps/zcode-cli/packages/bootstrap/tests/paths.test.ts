import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { getModelIoDir, getProjectMemoryRoot } from "../src/app/paths.js";

describe("getProjectMemoryRoot", () => {
  it("uses an opaque workspace identity and the canonical memory suffix", () => {
    const first = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/first",
      "  remote:ssh:host:/workspace/app  ",
    );
    const second = getProjectMemoryRoot(
      "/tmp/zcode-cli",
      "/workspace/second",
      "remote:ssh:host:/workspace/app",
    );

    expect(first).toBe("/tmp/zcode-cli/memories/projects/project-dce7d1610bbf24dd/memory");
    expect(second).toBe(first);
  });

  it("normalizes the workspace path only when identity is absent", () => {
    const relativeRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".");
    const absoluteRoot = getProjectMemoryRoot("/tmp/zcode-cli", resolve("."));
    const blankIdentityRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".", "   ");

    expect(relativeRoot).toBe(absoluteRoot);
    expect(blankIdentityRoot).toBe(absoluteRoot);
    expect(relativeRoot).toMatch(/\/memories\/projects\/.+\/memory$/);
  });
});

describe("getModelIoDir", () => {
  it("derives debug and rollout from the configured CLI storage root", () => {
    expect(getModelIoDir("/custom/storage/cli", true)).toBe("/custom/storage/cli/debug");
    expect(getModelIoDir("/custom/storage/cli", false)).toBe("/custom/storage/cli/rollout");
  });
});
