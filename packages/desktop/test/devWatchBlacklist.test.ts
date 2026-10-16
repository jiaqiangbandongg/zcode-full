import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopPackageJsonPath = resolve(import.meta.dirname, "../package.json");
const desktopPackageJson = JSON.parse(readFileSync(desktopPackageJsonPath, "utf8")) as {
  scripts: Record<string, string | undefined>;
};

const generatedWatchBlacklist = [
  "mock-cdn/**",
  "bundled-agents/**",
  ".e2e-cache/**",
  ".e2e-artifacts/**",
  ".e2e-home-*/**",
  "dist-cua-helper/**",
];
const workspaceWatchRoots = [
  "src",
  "../services/src",
  "../server/src",
  "../shared/src",
  "../rpc/src",
  "../client/src",
  "../provider/src",
  "../provider-node/src",
];

describe("desktop dev tsup watcher", () => {
  it("标准和 local-cli 开发入口都排除生成目录", () => {
    for (const scriptName of ["dev:runtime", "dev:local-cli"]) {
      const script = desktopPackageJson.scripts[scriptName];
      expect(script).toBeDefined();
      expect(script).toContain("tsup --watch src");

      for (const path of workspaceWatchRoots.slice(1)) {
        expect(script).toContain(`--watch ${path}`);
      }

      for (const path of generatedWatchBlacklist) {
        expect(script).toContain(`--ignore-watch '${path}'`);
      }
    }
  });

  it("黑名单 glob 必须保留在 shell 引号内", () => {
    for (const scriptName of ["dev:runtime", "dev:local-cli"]) {
      const script = desktopPackageJson.scripts[scriptName] ?? "";
      expect(script).not.toMatch(
        /--ignore-watch (?:mock-cdn|bundled-agents|\.e2e|dist-cua-helper)\/\*/u,
      );
    }
  });
});
