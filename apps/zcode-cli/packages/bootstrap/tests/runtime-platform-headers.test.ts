import { arch as readOsArch, release as readOsRelease } from "node:os";
import { describe, expect, it } from "vitest";
import { createRuntimePlatformHeaders } from "../src/runtime-platform-headers.js";

describe("createRuntimePlatformHeaders", () => {
  it("builds runtime platform headers from the current agent runtime host", () => {
    const osCategory =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

    expect(createRuntimePlatformHeaders()).toEqual({
      "X-Os-Category": osCategory,
      "X-Os-Version": readOsRelease(),
      "X-Platform": `${process.platform}-${readOsArch()}`,
    });
  });
});
