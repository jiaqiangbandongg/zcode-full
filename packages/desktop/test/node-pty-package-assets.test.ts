import { describe, expect, it } from "vitest";
import {
  resolvePackagedNodePtyPrebuildPath,
  resolveSourceNodePtyPrebuildPath,
} from "../scripts/node-pty-package-assets.mjs";

describe("node-pty package assets", () => {
  it("resolves the unpacked node-pty prebuild path used by packaged Windows apps", () => {
    const resolvedPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir: "C:/Program Files/ZCode/resources",
      platformKey: "win32-x64",
    }).replaceAll("\\", "/");

    expect(resolvedPath).toContain("/resources/");
    expect(resolvedPath).toMatch(
      /app\.asar\.unpacked\/node_modules\/node-pty\/prebuilds\/win32-x64\/pty\.node$/,
    );
  });

  it("resolves linux source prebuilds through package exports compatible entrypoints", () => {
    for (const platformKey of ["linux-x64", "linux-arm64"]) {
      const resolvedPath = resolveSourceNodePtyPrebuildPath({
        sourcePackageName: `@lydell/node-pty-${platformKey}`,
        platformKey,
      }).replaceAll("\\", "/");

      expect(resolvedPath).toMatch(
        new RegExp(`@lydell/node-pty-${platformKey}/prebuilds/${platformKey}/pty\\.node$`),
      );
    }
  });

  it("resolves the unpacked node-pty prebuild path used by packaged Linux apps", () => {
    const resolvedPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir: "/opt/ZCode/resources",
      platformKey: "linux-x64",
    }).replaceAll("\\", "/");

    expect(resolvedPath).toContain("/opt/ZCode/resources/");
    expect(resolvedPath).toMatch(
      /app\.asar\.unpacked\/node_modules\/node-pty\/prebuilds\/linux-x64\/pty\.node$/,
    );
  });
});
