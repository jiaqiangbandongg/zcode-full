import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import lintStagedConfig from "../../../lint-staged.config.mjs";

const createdManifestPaths: string[] = [];

function extractManifestPath(command: string): string {
  const match = command.match(/--files-manifest\s+(.+)$/u);
  if (!match) {
    throw new Error(`command did not include --files-manifest: ${command}`);
  }
  return match[1]!.replace(/^['"]|['"]$/gu, "");
}

function readSingleCommandManifest(result: string | string[]) {
  // 即使旧拆批实现导致断言失败，也要清理本次测试生成的全部 manifest。
  const commands = typeof result === "string" ? [result] : result;
  const paths = commands.map(extractManifestPath);
  createdManifestPaths.push(...paths);
  expect(typeof result).toBe("string");
  return JSON.parse(readFileSync(paths[0]!, "utf8"));
}

describe("lint-staged config", () => {
  afterEach(() => {
    for (const manifestPath of createdManifestPaths.splice(0)) {
      rmSync(manifestPath, { force: true });
    }
  });

  it("passes shell-sensitive Windows filenames through a manifest", () => {
    const sensitiveFile = "packages/ui/src/foo%PATH% caret^ amp& paren(x).test.ts";
    const command = lintStagedConfig["packages/**/*.{js,jsx,ts,tsx,json}"]([sensitiveFile]);
    const manifest = readSingleCommandManifest(command);

    expect(command).toContain("node scripts/run-lint-staged-vitest.mjs related");
    expect(command).toContain("--files-manifest");
    expect(command).not.toContain(sensitiveFile);
    expect(manifest).toEqual({
      mode: "related",
      files: [sensitiveFile],
    });
  });

  it("runs all changed tests in one vitest command", () => {
    const testFiles = Array.from(
      { length: 21 },
      (_, index) => `packages/ui/test/changed-${index}.test.ts`,
    );
    const commands = lintStagedConfig["packages/*/test/**/*.test.ts"](testFiles);

    expect(readSingleCommandManifest(commands)).toEqual({ mode: "run", files: testFiles });
  });

  it("selects related tests for all sources in one vitest command", () => {
    const sourceFiles = Array.from(
      { length: 17 },
      (_, index) => `packages/ui/src/changed-${index}.ts`,
    );
    const commands = lintStagedConfig["packages/**/*.{js,jsx,ts,tsx,json}"](sourceFiles);

    expect(readSingleCommandManifest(commands)).toEqual({ mode: "related", files: sourceFiles });
  });

  it("keeps E2E excluded and separates changed tests from sources", () => {
    const files = [
      "packages\\ui\\src\\example.ts",
      "packages\\ui\\test\\example.test.ts",
      "packages\\desktop\\test\\e2e\\example.test.ts",
    ];
    expect(
      readSingleCommandManifest(lintStagedConfig["packages/*/test/**/*.test.ts"](files)),
    ).toEqual({ mode: "run", files: ["packages/ui/test/example.test.ts"] });
    expect(
      readSingleCommandManifest(lintStagedConfig["packages/**/*.{js,jsx,ts,tsx,json}"](files)),
    ).toEqual({ mode: "related", files: ["packages/ui/src/example.ts"] });
  });

  it("does not launch Vitest for empty or E2E-only groups", () => {
    for (const callback of Object.values(lintStagedConfig)) {
      expect(callback([])).toEqual([]);
      expect(callback(["packages/desktop/test/e2e/example.test.ts"])).toEqual([]);
    }
  });
});
