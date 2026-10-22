import { describe, expect, it } from "vitest";
import {
  getRemoteRuntimeToolsForPlatform,
  normalizeRemoteResourcePackageSelection,
  remoteTargetSchema,
} from "@zcode/shared";

describe("remote resource packages", () => {
  it("ignores historical selections and always returns active packages", () => {
    expect(
      normalizeRemoteResourcePackageSelection({
        selectedPackageIds: ["glm"],
      }),
    ).toEqual(["server-bundle", "node-runtime", "node-pty", "glm", "bfs", "ripgrep", "ugrep"]);
  });

  it("Linux remote 使用 native-search 三工具，Darwin 保留 legacy ripgrep", () => {
    expect(getRemoteRuntimeToolsForPlatform("linux")).toEqual([
      expect.objectContaining({ toolId: "bfs", version: "v4.1.1-2" }),
      expect.objectContaining({ toolId: "ripgrep", version: "v14.1.1-1" }),
      expect.objectContaining({ toolId: "ugrep", version: "v7.8.4-1" }),
    ]);
    expect(getRemoteRuntimeToolsForPlatform("darwin")).toEqual([
      expect.objectContaining({ toolId: "ripgrep", version: "v13.0.0-10" }),
    ]);
  });

  it("accepts selected SSH resource packages", () => {
    expect(
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
        },
      }),
    ).toMatchObject({
      resourcePackages: {
        selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
      },
    });
  });

  it("rejects unknown SSH resource packages", () => {
    expect(() =>
      remoteTargetSchema.parse({
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "unknown-runtime"],
        },
      }),
    ).toThrow();
  });
});
