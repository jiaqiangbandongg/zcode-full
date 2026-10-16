import { describe, expect, it } from "vitest";
import { decideNodePtyRebuild } from "../scripts/node-pty-rebuild.mjs";

describe("node-pty rebuild decision", () => {
  it("在 Windows 且存在对应 prebuild 时跳过 electron-rebuild", () => {
    expect(
      decideNodePtyRebuild({
        platform: "win32",
        arch: "x64",
        nodePtyRoot: "/repo/node_modules/node-pty",
        existingPaths: new Set(["/repo/node_modules/node-pty/prebuilds/win32-x64/pty.node"]),
      }),
    ).toEqual({
      shouldRebuild: false,
      prebuildPath: "/repo/node_modules/node-pty/prebuilds/win32-x64/pty.node",
      reason: "windows-prebuild-available",
    });
  });

  it("在 Windows 缺少对应 prebuild 时继续 electron-rebuild", () => {
    expect(
      decideNodePtyRebuild({
        platform: "win32",
        arch: "x64",
        nodePtyRoot: "/repo/node_modules/node-pty",
        existingPaths: new Set(),
      }),
    ).toEqual({
      shouldRebuild: true,
      prebuildPath: "/repo/node_modules/node-pty/prebuilds/win32-x64/pty.node",
      reason: "windows-prebuild-missing",
    });
  });

  it("非 Windows 平台保持 electron-rebuild", () => {
    expect(
      decideNodePtyRebuild({
        platform: "darwin",
        arch: "arm64",
        nodePtyRoot: "/repo/node_modules/node-pty",
        existingPaths: new Set(["/repo/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"]),
      }),
    ).toEqual({
      shouldRebuild: true,
      prebuildPath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      reason: "non-windows-platform",
    });
  });
});
